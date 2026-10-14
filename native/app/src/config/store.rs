//! `config.json` persistence, port of `ConfigStore` in `src/main/store.js`: corrupt files are
//! backed up and replaced by defaults, saves are debounced (300 ms) and atomic (tmp + rename).

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::model::{default_config, sanitize, Config, Defaults};
use crate::logger;

const SAVE_DEBOUNCE: Duration = Duration::from_millis(300);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
const CONFIG_FILE: &str = "config.json";
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

enum SaveMsg {
    Write(String),
    Flush(Sender<()>),
    Stop,
}

/// Background writer: coalesces bursts of `set` into one atomic write.
struct Saver {
    tx: Sender<SaveMsg>,
    handle: Option<JoinHandle<()>>,
    writes: Arc<AtomicUsize>,
}

impl Saver {
    fn spawn(file: PathBuf) -> Saver {
        let (tx, rx) = mpsc::channel::<SaveMsg>();
        let writes = Arc::new(AtomicUsize::new(0));
        let counter = writes.clone();
        let handle = std::thread::Builder::new()
            .name("config-saver".into())
            .spawn(move || {
                let mut pending: Option<String> = None;
                loop {
                    let msg = if pending.is_some() {
                        match rx.recv_timeout(SAVE_DEBOUNCE) {
                            Ok(m) => Some(m),
                            Err(RecvTimeoutError::Timeout) => None,
                            Err(RecvTimeoutError::Disconnected) => Some(SaveMsg::Stop),
                        }
                    } else {
                        Some(rx.recv().unwrap_or(SaveMsg::Stop))
                    };
                    match msg {
                        Some(SaveMsg::Write(text)) => pending = Some(text),
                        None => {
                            if let Some(text) = pending.take() {
                                write_atomic(&file, &text, &counter);
                            }
                        }
                        Some(SaveMsg::Flush(ack)) => {
                            if let Some(text) = pending.take() {
                                write_atomic(&file, &text, &counter);
                            }
                            let _ = ack.send(());
                        }
                        Some(SaveMsg::Stop) => {
                            if let Some(text) = pending.take() {
                                write_atomic(&file, &text, &counter);
                            }
                            return;
                        }
                    }
                }
            })
            .expect("spawn config saver thread");
        Saver { tx, handle: Some(handle), writes }
    }
}

fn write_atomic(file: &Path, text: &str, counter: &AtomicUsize) {
    let tmp = file.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&tmp, text)?;
        fs::rename(&tmp, file)
    })();
    match result {
        Ok(()) => {
            counter.fetch_add(1, Ordering::SeqCst);
            logger::debug("config saved", None);
        }
        Err(err) => logger::error("config save failed", json!({"file": file.display().to_string(), "error": err.to_string()})),
    }
}

pub struct ConfigStore {
    file: PathBuf,
    data: Config,
    defaults: Defaults,
    /// true when no config file existed yet (very first start)
    pub is_new: bool,
    saver: Saver,
}

impl ConfigStore {
    pub fn open(dir: &Path, defaults: Defaults) -> ConfigStore {
        let file = dir.join(CONFIG_FILE);
        let (data, is_new) = load(&file, &defaults);
        let saver = Saver::spawn(file.clone());
        ConfigStore { file, data, defaults, is_new, saver }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn get(&self) -> &Config {
        &self.data
    }

    pub fn defaults(&self) -> &Defaults {
        &self.defaults
    }

    /// Replace the config (sanitized) and schedule a save.
    pub fn set(&mut self, next: Config) -> &Config {
        self.data = sanitize(&next.to_value(), &self.defaults);
        self.schedule_save();
        &self.data
    }

    /// Mutate a copy, then `set` it (main.js `mutate`).
    pub fn update(&mut self, f: impl FnOnce(&mut Config)) -> &Config {
        let mut next = self.data.clone();
        f(&mut next);
        self.set(next)
    }

    fn schedule_save(&self) {
        match serde_json::to_string_pretty(&self.data) {
            Ok(text) => {
                if self.saver.tx.send(SaveMsg::Write(text)).is_err() {
                    logger::error("config saver thread gone, change not saved", None);
                }
            }
            Err(err) => logger::error("config serialize failed", json!({"error": err.to_string()})),
        }
    }

    /// Write any pending change now and wait for it (bounded).
    pub fn flush(&self) {
        // A first start has nothing pending yet but must persist the defaults.
        if self.is_new && self.saver.writes.load(Ordering::SeqCst) == 0 {
            self.schedule_save();
        }
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.saver.tx.send(SaveMsg::Flush(ack_tx)).is_err() || ack_rx.recv_timeout(FLUSH_TIMEOUT).is_err() {
            logger::error("config flush did not complete", json!({"file": self.file.display().to_string()}));
        }
    }

    /// Number of completed writes (tests, diagnostics).
    pub fn write_count(&self) -> usize {
        self.saver.writes.load(Ordering::SeqCst)
    }
}

impl Drop for ConfigStore {
    fn drop(&mut self) {
        let _ = self.saver.tx.send(SaveMsg::Stop);
        if let Some(h) = self.saver.handle.take() {
            let _ = h.join();
        }
    }
}

fn load(file: &Path, defaults: &Defaults) -> (Config, bool) {
    let bytes = match fs::read(file) {
        Ok(b) => b,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            logger::info("config missing, using defaults", json!({"file": file.display().to_string()}));
            return (default_config(defaults), true);
        }
        Err(err) => {
            logger::error("config read failed, using defaults", json!({"file": file.display().to_string(), "error": err.to_string()}));
            return (default_config(defaults), false);
        }
    };
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(&bytes);
    let parsed = std::str::from_utf8(body).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(t).map_err(|e| e.to_string()));
    match parsed {
        Ok(raw) => {
            let cfg = sanitize(&raw, defaults);
            logger::info("config loaded", json!({"profiles": cfg.profiles.len()}));
            (cfg, false)
        }
        Err(error) => {
            let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
            let backup = PathBuf::from(format!("{}.corrupt-{ms}", file.display()));
            logger::error("config corrupt, backing up and resetting", json!({"backup": backup.display().to_string(), "error": error}));
            if let Err(err) = fs::copy(file, &backup) {
                logger::error("config backup failed", json!({"error": err.to_string()}));
            }
            (default_config(defaults), false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> Defaults {
        Defaults {
            default_crosshair: json!({"layers": [{"name": "default"}]}),
            first_preset_name: "First".into(),
            first_preset_crosshair: json!({"layers": [{"name": "first"}]}),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cz-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_file_is_new_defaults() {
        let dir = temp_dir("missing");
        let s = ConfigStore::open(&dir, defaults());
        assert!(s.is_new);
        assert_eq!(s.get().profiles[0].name, "First");
        assert!(!dir.join("config.json").exists());
        s.flush();
        assert!(dir.join("config.json").exists(), "first start persists defaults on flush");
    }

    #[test]
    fn bom_is_stripped() {
        let dir = temp_dir("bom");
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(br#"{"enabled": false, "profiles": [{"id": "a", "name": "A", "crosshair": {"layers": []}}]}"#);
        fs::write(dir.join("config.json"), bytes).unwrap();
        let s = ConfigStore::open(&dir, defaults());
        assert!(!s.is_new);
        assert!(!s.get().enabled);
        assert_eq!(s.get().profiles[0].id, "a");
    }

    #[test]
    fn corrupt_file_backed_up() {
        let dir = temp_dir("corrupt");
        fs::write(dir.join("config.json"), b"{not json").unwrap();
        let s = ConfigStore::open(&dir, defaults());
        assert_eq!(s.get().profiles[0].name, "First");
        let backups: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with("config.json.corrupt-")).collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].path()).unwrap(), b"{not json");
    }

    #[test]
    fn set_saves_atomically_and_debounces() {
        let dir = temp_dir("save");
        let mut s = ConfigStore::open(&dir, defaults());
        for i in 0..5 {
            s.update(|c| c.display.offset_x = i);
        }
        s.flush();
        assert_eq!(s.write_count(), 1, "5 quick sets → 1 write");
        assert!(!dir.join("config.json.tmp").exists());
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved["display"]["offsetX"], 4);

        let reopened = ConfigStore::open(&dir, defaults());
        assert_eq!(reopened.get().display.offset_x, 4);
    }

    #[test]
    fn debounce_writes_after_quiet_period() {
        let dir = temp_dir("quiet");
        let mut s = ConfigStore::open(&dir, defaults());
        s.update(|c| c.enabled = false);
        std::thread::sleep(SAVE_DEBOUNCE * 3);
        assert_eq!(s.write_count(), 1);
    }

    #[test]
    fn set_sanitizes() {
        let dir = temp_dir("sanitize");
        let mut s = ConfigStore::open(&dir, defaults());
        s.update(|c| c.display.offset_x = 99_999);
        assert_eq!(s.get().display.offset_x, 4000);
    }

    #[test]
    fn unwritable_target_does_not_panic() {
        let dir = temp_dir("unwritable");
        let mut s = ConfigStore::open(&dir, defaults());
        // a directory where the file should be makes the rename fail
        fs::create_dir_all(dir.join("config.json")).unwrap();
        s.update(|c| c.enabled = false);
        s.flush();
        assert_eq!(s.write_count(), 0);
    }

    #[test]
    fn drop_flushes_pending() {
        let dir = temp_dir("drop");
        {
            let mut s = ConfigStore::open(&dir, defaults());
            s.update(|c| c.display.offset_y = 7);
        }
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved["display"]["offsetY"], 7);
    }
}
