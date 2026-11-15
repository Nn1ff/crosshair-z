//! `config.json` persistence, port of `ConfigStore` in `src/main/store.js`. Saves are debounced
//! (300 ms), atomic (synced tmp + rename) and retried with backoff while they fail; a flush or the
//! exit retries a failing save a few times at once, since the process may end right after. The
//! first save of a session that loaded `config.json` cleanly keeps that file as `config.json.bak`
//! (written the same atomic way); a missing or corrupt `config.json` falls back to the backup
//! (corrupt files are copied aside first). A file that exists but stays unreadable (`config.json`,
//! or the backup it falls back to) makes the session read-only, so a library this process could
//! not see is never overwritten. Loads that would drop data keep a `config.json.lossy-<ms>` copy;
//! lossy and corrupt copies are kept once per distinct content, not on every start.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::model::{default_config, is_lossy, sanitize, Config, Defaults};
use crate::logger;

const SAVE_DEBOUNCE: Duration = Duration::from_millis(300);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
/// Waits before re-reading a config file that exists but cannot be read (held by a scanner or a
/// sync tool, for example); also the short retries of a save that fails at a flush or at exit.
const READ_RETRY_DELAYS: [Duration; 3] = [Duration::from_millis(100), Duration::from_millis(300), Duration::from_millis(900)];
/// Wait after the first failed save; doubles per failure up to `SAVE_RETRY_MAX`.
const SAVE_RETRY_FIRST: Duration = Duration::from_secs(1);
const SAVE_RETRY_MAX: Duration = Duration::from_secs(30);
const CONFIG_FILE: &str = "config.json";
const BACKUP_SUFFIX: &str = ".bak";
const CORRUPT_SUFFIX: &str = ".corrupt-";
const LOSSY_SUFFIX: &str = ".lossy-";
const TMP_SUFFIX: &str = ".tmp";
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
    /// `backup`: where to copy `file` before the session's first write (clean loads only).
    fn spawn(file: PathBuf, backup: Option<PathBuf>) -> Saver {
        let (tx, rx) = mpsc::channel::<SaveMsg>();
        let writes = Arc::new(AtomicUsize::new(0));
        let mut worker = SaveWorker { file, backup, pending: None, retry: None, writes: writes.clone() };
        let handle = std::thread::Builder::new()
            .name("config-saver".into())
            .spawn(move || worker.run(&rx))
            .expect("spawn config saver thread");
        Saver { tx, handle: Some(handle), writes }
    }
}

/// State of the saver thread.
struct SaveWorker {
    file: PathBuf,
    /// Set until a write succeeded or the backup of the loaded file was made.
    backup: Option<PathBuf>,
    /// Newest config text not on disk yet; kept when a write fails.
    pending: Option<String>,
    /// While writes fail: when to try again, and the backoff that led there.
    retry: Option<(Instant, Duration)>,
    writes: Arc<AtomicUsize>,
}

impl SaveWorker {
    fn run(&mut self, rx: &Receiver<SaveMsg>) {
        loop {
            let msg = match self.wait() {
                None => rx.recv().unwrap_or(SaveMsg::Stop),
                Some(timeout) => match rx.recv_timeout(timeout) {
                    Ok(m) => m,
                    Err(RecvTimeoutError::Timeout) => {
                        self.save();
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => SaveMsg::Stop,
                },
            };
            match msg {
                SaveMsg::Write(text) => self.pending = Some(text),
                SaveMsg::Flush(ack) => {
                    self.save_now(false);
                    let _ = ack.send(());
                }
                SaveMsg::Stop => {
                    self.save_now(true);
                    return;
                }
            }
        }
    }

    /// Idle: block (no wakeups). Pending: the debounce restarts with every change, but a retry
    /// keeps its deadline so a stream of changes cannot postpone it.
    fn wait(&self) -> Option<Duration> {
        self.pending.as_ref()?;
        Some(match self.retry {
            Some((at, _)) => at.saturating_duration_since(Instant::now()),
            None => SAVE_DEBOUNCE,
        })
    }

    /// Debounce or retry deadline: write the pending text; on failure keep it and schedule a retry
    /// with a longer backoff.
    fn save(&mut self) {
        if let Err(err) = self.write_pending(self.retry.is_some()) {
            let backoff = self.schedule_retry();
            logger::error(
                "config save failed, retrying",
                json!({"file": self.file.display().to_string(), "error": err.to_string(), "retryInMs": backoff.as_millis() as u64}),
            );
        }
    }

    /// Flush or exit (`at_exit`): the process may end right after, so a failing save is retried at
    /// once a few times (`READ_RETRY_DELAYS`, 1.3 s in all) instead of after the backoff. Still
    /// failing: at exit the change is lost; after a flush it stays pending, and the backoff retries
    /// only if the process keeps running (so the log promises no retry).
    fn save_now(&mut self, at_exit: bool) {
        let mut retried = self.retry.is_some();
        let mut delays = READ_RETRY_DELAYS.iter();
        loop {
            let Err(err) = self.write_pending(retried) else { return };
            let file = self.file.display().to_string();
            let Some(delay) = delays.next() else {
                let ctx = json!({"file": file, "error": err.to_string(), "attempts": READ_RETRY_DELAYS.len() + 1});
                if at_exit {
                    logger::error("config change lost: save failed at exit", ctx);
                } else {
                    self.schedule_retry();
                    logger::error("config save failed at flush, change kept in memory", ctx);
                }
                return;
            };
            logger::warn("config save failed, retrying", json!({"file": file, "error": err.to_string(), "retryInMs": delay.as_millis() as u64}));
            std::thread::sleep(*delay);
            retried = true;
        }
    }

    /// Next attempt after a failed save: 1 s, doubling per failure up to `SAVE_RETRY_MAX`.
    fn schedule_retry(&mut self) -> Duration {
        let backoff = self.retry.map_or(SAVE_RETRY_FIRST, |(_, last)| (last * 2).min(SAVE_RETRY_MAX));
        self.retry = Some((Instant::now() + backoff, backoff));
        backoff
    }

    /// Write the pending text (nothing pending: Ok), backing up the loaded file first (once). On
    /// failure the text stays pending. `retried`: an earlier attempt at it failed.
    fn write_pending(&mut self, retried: bool) -> std::io::Result<()> {
        let Some(text) = self.pending.take() else { return Ok(()) };
        self.backup_once();
        if let Err(err) = write_atomic(&self.file, text.as_bytes()) {
            self.pending = Some(text);
            return Err(err);
        }
        if retried {
            logger::info("config saved after retry", json!({"file": self.file.display().to_string()}));
        } else {
            logger::debug("config saved", None);
        }
        self.retry = None;
        self.backup = None; // later backups would only copy this session's own writes
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// Before the session's first write: keep the loaded file as `config.json.bak`.
    fn backup_once(&mut self) {
        let Some(bak) = &self.backup else { return };
        match backup_file(&self.file, bak) {
            Ok(()) => {
                logger::info("config backed up", json!({"file": bak.display().to_string()}));
                self.backup = None;
            }
            // the save itself still runs: losing the change would be worse than a missing backup
            Err(err) => logger::warn("config backup failed", json!({"file": bak.display().to_string(), "error": err.to_string()})),
        }
    }
}

/// Replace `file` with `bytes`: synced `<file>.tmp` next to it, then rename (atomic on one volume).
fn write_atomic(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = sibling(file, TMP_SUFFIX);
    let result = (|| -> std::io::Result<()> {
        let mut out = fs::File::create(&tmp)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        drop(out); // closed before the rename
        fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Keep `file` as `bak`, written like a save (synced tmp + rename): a crash mid-copy never leaves a
/// truncated backup in place of the previous one.
fn backup_file(file: &Path, bak: &Path) -> std::io::Result<()> {
    write_atomic(bak, &fs::read(file)?)
}

pub struct ConfigStore {
    file: PathBuf,
    data: Config,
    defaults: Defaults,
    /// true when no config file existed yet (very first start)
    pub is_new: bool,
    read_only: bool,
    read_only_warned: AtomicBool,
    saver: Saver,
}

impl ConfigStore {
    pub fn open(dir: &Path, defaults: Defaults) -> ConfigStore {
        let file = dir.join(CONFIG_FILE);
        let loaded = load(&file, &defaults);
        let backup = loaded.clean.then(|| sibling(&file, BACKUP_SUFFIX));
        let saver = Saver::spawn(file.clone(), backup);
        ConfigStore {
            file,
            data: loaded.config,
            defaults,
            is_new: loaded.is_new,
            read_only: loaded.read_only,
            read_only_warned: AtomicBool::new(false),
            saver,
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    /// True when `config.json`, or the backup it fell back to, exists but could not be read: this
    /// session never saves.
    pub fn read_only(&self) -> bool {
        self.read_only
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
        if self.read_only {
            if !self.read_only_warned.swap(true, Ordering::Relaxed) {
                logger::warn("config is read-only this session, changes are not saved", json!({"file": self.file.display().to_string()}));
            }
            return;
        }
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

/// What `load` found on disk.
struct Loaded {
    config: Config,
    /// no config file existed yet (very first start)
    is_new: bool,
    /// `config.json` itself was read and parsed: its first save keeps it as `config.json.bak`
    clean: bool,
    /// `config.json`, or the backup it fell back to, exists but stayed unreadable: never save
    read_only: bool,
}

/// Why `config.json` itself could not be used.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fault {
    Missing,
    Corrupt,
    Unreadable,
}

impl Fault {
    fn as_str(self) -> &'static str {
        match self {
            Fault::Missing => "missing",
            Fault::Corrupt => "corrupt",
            Fault::Unreadable => "unreadable",
        }
    }
}

/// What `config.json.bak` gave.
enum Backup {
    /// its library
    Restored(Box<Config>),
    /// no usable backup: there is none, or it is not a config file
    Absent,
    /// it exists but stayed unreadable: it may hold the only copy of the library
    Unreadable,
}

fn load(file: &Path, defaults: &Defaults) -> Loaded {
    let path = file.display().to_string();
    match read_retrying(file) {
        Ok(bytes) => match parse(&bytes) {
            Ok(raw) => {
                let config = repair(file, &bytes, &raw, defaults);
                logger::info("config loaded", json!({"profiles": config.profiles.len()}));
                Loaded { config, is_new: false, clean: true, read_only: false }
            }
            Err(error) => {
                logger::error("config corrupt", json!({"file": path, "error": error}));
                keep_copy(file, CORRUPT_SUFFIX, &bytes, "corrupt config"); // the bytes read, not a second read
                fall_back(file, defaults, Fault::Corrupt)
            }
        },
        Err(err) if err.kind() == ErrorKind::NotFound => fall_back(file, defaults, Fault::Missing),
        Err(err) => {
            logger::error("config unreadable, running read-only: changes are not saved this session", json!({"file": path, "error": err.to_string()}));
            fall_back(file, defaults, Fault::Unreadable)
        }
    }
}

/// Session for a `config.json` that could not be used: the library of `config.json.bak`, else the
/// defaults. Read-only while `config.json` or the backup exists but stays unreadable: either may
/// hold a library this process could not see, which defaults must never overwrite.
fn fall_back(file: &Path, defaults: &Defaults, fault: Fault) -> Loaded {
    let read_only = fault == Fault::Unreadable;
    match load_backup(file, defaults, fault.as_str()) {
        Backup::Restored(config) => Loaded { config: *config, is_new: false, clean: false, read_only },
        Backup::Absent if fault == Fault::Missing => {
            logger::info("config missing, using defaults", json!({"file": file.display().to_string()}));
            Loaded { config: default_config(defaults), is_new: true, clean: false, read_only }
        }
        Backup::Absent => {
            logger::warn("no usable config backup, using defaults", json!({"file": sibling(file, BACKUP_SUFFIX).display().to_string(), "reason": fault.as_str()}));
            Loaded { config: default_config(defaults), is_new: false, clean: false, read_only }
        }
        Backup::Unreadable => {
            if !read_only {
                logger::error(
                    "config backup unreadable, running read-only on defaults: changes are not saved this session",
                    json!({"file": sibling(file, BACKUP_SUFFIX).display().to_string(), "reason": fault.as_str()}),
                );
            }
            Loaded { config: default_config(defaults), is_new: false, clean: false, read_only: true }
        }
    }
}

/// `fs::read`, retried while the file exists but cannot be read.
fn read_retrying(file: &Path) -> std::io::Result<Vec<u8>> {
    let mut retries = READ_RETRY_DELAYS.iter();
    loop {
        match fs::read(file) {
            Err(err) if err.kind() != ErrorKind::NotFound => match retries.next() {
                Some(delay) => {
                    logger::warn("config read failed, retrying", json!({"file": file.display().to_string(), "error": err.to_string(), "retryInMs": delay.as_millis() as u64}));
                    std::thread::sleep(*delay);
                }
                None => return Err(err),
            },
            other => return other,
        }
    }
}

/// JSON of a config file (UTF-8, optional BOM).
fn parse(bytes: &[u8]) -> Result<Value, String> {
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    std::str::from_utf8(body).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(t).map_err(|e| e.to_string()))
}

/// Sanitize a parsed config file; keep a copy of its bytes first when that drops data.
fn repair(file: &Path, bytes: &[u8], raw: &Value, defaults: &Defaults) -> Config {
    let config = sanitize(raw, defaults);
    if is_lossy(raw, &config) {
        keep_copy(file, LOSSY_SUFFIX, bytes, "config has data this version drops");
    }
    config
}

/// Keep `bytes` (what `file` holds) as `<file><kind><ms>` next to it, unless a copy of that kind
/// with the same content exists: a file that stays lossy or corrupt is read on every start, and a
/// copy per start would grow the data dir without bound. `what` describes the file in the log.
fn keep_copy(file: &Path, kind: &str, bytes: &[u8], what: &str) {
    let path = file.display().to_string();
    if let Some(existing) = identical_copy(file, kind, bytes) {
        logger::warn(&format!("{what}, a copy with the same content exists"), json!({"file": path, "copy": existing.display().to_string()}));
        return;
    }
    let copy = sibling(file, &format!("{kind}{}", now_ms()));
    match fs::write(&copy, bytes) {
        Ok(()) => logger::warn(&format!("{what}, kept a copy"), json!({"file": path, "copy": copy.display().to_string()})),
        Err(err) => logger::error(&format!("{what}, keeping a copy failed"), json!({"file": copy.display().to_string(), "error": err.to_string()})),
    }
}

/// An existing `<file><kind>*` holding exactly `bytes`; only files of the same length are read.
/// Any error counts as "none" (one copy too many is better than none).
fn identical_copy(file: &Path, kind: &str, bytes: &[u8]) -> Option<PathBuf> {
    let prefix = format!("{}{kind}", file.file_name()?.to_string_lossy());
    fs::read_dir(file.parent()?).ok()?.filter_map(Result::ok).find_map(|entry| {
        let candidate = entry.file_name().to_string_lossy().starts_with(&prefix)
            && entry.metadata().is_ok_and(|m| m.is_file() && m.len() == bytes.len() as u64);
        (candidate && fs::read(entry.path()).is_ok_and(|b| b == bytes)).then(|| entry.path())
    })
}

/// Library of `config.json.bak` (used because `config.json` is `reason`).
fn load_backup(file: &Path, defaults: &Defaults, reason: &str) -> Backup {
    let bak = sibling(file, BACKUP_SUFFIX);
    let path = bak.display().to_string();
    let bytes = match read_retrying(&bak) {
        Ok(b) => b,
        Err(err) if err.kind() == ErrorKind::NotFound => return Backup::Absent,
        Err(err) => {
            logger::error("config backup unreadable", json!({"file": path, "error": err.to_string()}));
            return Backup::Unreadable;
        }
    };
    match parse(&bytes) {
        Ok(raw) => {
            let config = repair(&bak, &bytes, &raw, defaults);
            logger::warn("config restored from backup", json!({"file": path, "reason": reason, "profiles": config.profiles.len()}));
            Backup::Restored(Box::new(config))
        }
        Err(error) => {
            logger::error("config backup corrupt, ignored", json!({"file": path, "error": error}));
            Backup::Absent
        }
    }
}

/// `file` with `suffix` appended to its name (`config.json` → `config.json.bak`).
fn sibling(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
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

    /// Config text with one profile per id.
    fn library(ids: &[&str]) -> String {
        let profiles: Vec<Value> = ids.iter().map(|id| json!({"id": id, "name": id, "hotkey": "", "crosshair": {"layers": []}})).collect();
        serde_json::to_string_pretty(&json!({"version": 5, "profiles": profiles})).unwrap()
    }

    fn ids(s: &ConfigStore) -> Vec<String> {
        s.get().profiles.iter().map(|p| p.id.clone()).collect()
    }

    fn files_starting_with(dir: &Path, prefix: &str) -> Vec<PathBuf> {
        fs::read_dir(dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with(prefix)).map(|e| e.path()).collect()
    }

    /// Hold `path` open without sharing (as a scanner or sync tool might) for `hold`.
    fn lock_for(path: &Path, hold: Duration) -> std::thread::JoinHandle<()> {
        use std::os::windows::fs::OpenOptionsExt;
        let file = fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(hold);
            drop(file);
        })
    }

    #[test]
    fn briefly_locked_config_loads_normally() {
        let dir = temp_dir("brief-lock");
        let file = dir.join("config.json");
        fs::write(&file, library(&["a", "b"])).unwrap();
        let lock = lock_for(&file, Duration::from_millis(150));
        let mut s = ConfigStore::open(&dir, defaults());
        lock.join().unwrap();
        assert_eq!(ids(&s), ["a", "b"]);
        assert!(!s.read_only());
        s.update(|c| c.enabled = false);
        s.flush();
        assert_eq!(s.write_count(), 1);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["enabled"], false);
    }

    #[test]
    fn locked_config_runs_read_only_without_bak() {
        let dir = temp_dir("lock-no-bak");
        let file = dir.join("config.json");
        let original = library(&["a"]);
        fs::write(&file, &original).unwrap();
        let lock = lock_for(&file, Duration::from_secs(3));
        let mut s = ConfigStore::open(&dir, defaults());
        assert!(s.read_only());
        assert!(!s.is_new);
        assert_eq!(s.get().profiles[0].name, "First", "defaults while the file stays unreadable");
        lock.join().unwrap();
        s.update(|c| c.enabled = false);
        s.flush();
        assert_eq!(s.write_count(), 0);
        assert_eq!(fs::read(&file).unwrap(), original.as_bytes(), "a read-only session never overwrites the file");
    }

    #[test]
    fn locked_config_uses_bak_read_only() {
        let dir = temp_dir("lock-bak");
        let file = dir.join("config.json");
        fs::write(&file, library(&["newer"])).unwrap();
        fs::write(dir.join("config.json.bak"), library(&["b1", "b2"])).unwrap();
        let lock = lock_for(&file, Duration::from_secs(3));
        let s = ConfigStore::open(&dir, defaults());
        lock.join().unwrap();
        assert_eq!(ids(&s), ["b1", "b2"]);
        assert!(s.read_only());
    }

    #[test]
    fn first_save_writes_bak_of_clean_load() {
        let dir = temp_dir("first-bak");
        let original = library(&["a"]);
        fs::write(dir.join("config.json"), &original).unwrap();
        let mut s = ConfigStore::open(&dir, defaults());
        s.update(|c| c.enabled = false);
        s.flush();
        let bak = dir.join("config.json.bak");
        assert_eq!(fs::read(&bak).unwrap(), original.as_bytes());
        assert!(!dir.join("config.json.bak.tmp").exists(), "the backup is written through a tmp file");
        s.update(|c| c.display.offset_x = 5);
        s.flush();
        assert_eq!(s.write_count(), 2);
        assert_eq!(fs::read(&bak).unwrap(), original.as_bytes(), "later saves keep the backup of the clean load");
        assert!(files_starting_with(&dir, "config.json.lossy-").is_empty());
    }

    #[test]
    fn no_bak_from_default_or_read_only_session() {
        let fresh = temp_dir("no-bak-default");
        let mut s = ConfigStore::open(&fresh, defaults());
        s.flush();
        s.update(|c| c.enabled = false);
        s.flush();
        assert_eq!(s.write_count(), 2);
        assert!(!fresh.join("config.json.bak").exists(), "defaults were never a clean load");

        let locked = temp_dir("no-bak-read-only");
        fs::write(locked.join("config.json"), library(&["a"])).unwrap();
        let lock = lock_for(&locked.join("config.json"), Duration::from_secs(3));
        let mut s = ConfigStore::open(&locked, defaults());
        lock.join().unwrap();
        s.update(|c| c.enabled = false);
        s.flush();
        assert!(!locked.join("config.json.bak").exists(), "a read-only session saves nothing");
    }

    #[test]
    fn missing_config_falls_back_to_bak() {
        let dir = temp_dir("bak-only");
        let bak = library(&["b1"]);
        fs::write(dir.join("config.json.bak"), &bak).unwrap();
        let mut s = ConfigStore::open(&dir, defaults());
        assert_eq!(ids(&s), ["b1"]);
        assert!(!s.is_new);
        assert!(!s.read_only());
        s.update(|c| c.enabled = false);
        s.flush();
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved["profiles"][0]["id"], "b1", "the restored library is saved as config.json");
        assert_eq!(fs::read(dir.join("config.json.bak")).unwrap(), bak.as_bytes());
    }

    #[test]
    fn corrupt_config_falls_back_to_bak() {
        let dir = temp_dir("corrupt-bak");
        fs::write(dir.join("config.json"), b"{not json").unwrap();
        let bak = library(&["b1"]);
        fs::write(dir.join("config.json.bak"), &bak).unwrap();
        let mut s = ConfigStore::open(&dir, defaults());
        assert_eq!(ids(&s), ["b1"]);
        let corrupt = files_starting_with(&dir, "config.json.corrupt-");
        assert_eq!(corrupt.len(), 1);
        assert_eq!(fs::read(&corrupt[0]).unwrap(), b"{not json");
        s.update(|c| c.enabled = false);
        s.flush();
        assert_eq!(fs::read(dir.join("config.json.bak")).unwrap(), bak.as_bytes(), "a corrupt file never replaces the backup");
    }

    #[test]
    fn failed_save_is_retried() {
        let dir = temp_dir("retry");
        let file = dir.join("config.json");
        let mut s = ConfigStore::open(&dir, defaults());
        fs::create_dir_all(&file).unwrap(); // a directory where the file should be makes the rename fail
        s.update(|c| c.display.offset_x = 9);
        s.flush();
        assert_eq!(s.write_count(), 0);
        std::thread::sleep(Duration::from_millis(200));
        fs::remove_dir(&file).unwrap();
        let end = Instant::now() + Duration::from_secs(4);
        while s.write_count() == 0 && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(s.write_count(), 1, "the kept change is written once the target is free");
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["display"]["offsetX"], 9);
    }

    #[test]
    fn lossy_load_is_backed_up() {
        for (name, text) in [("lossy-version", r#"{"version": 6, "profiles": []}"#), ("lossy-profiles", r#"{"version": 5, "profiles": {"a": {}}}"#)] {
            let dir = temp_dir(name);
            fs::write(dir.join("config.json"), text).unwrap();
            let _s = ConfigStore::open(&dir, defaults());
            let copies = files_starting_with(&dir, "config.json.lossy-");
            assert_eq!(copies.len(), 1, "{name}");
            assert_eq!(fs::read(&copies[0]).unwrap(), text.as_bytes(), "{name}");
        }
    }

    #[test]
    fn locked_bak_keeps_the_session_read_only() {
        // config.json missing or corrupt and the backup locked: the backup may hold the only copy of
        // the library, so this session writes neither defaults nor changes
        let bak = library(&["b1"]);
        let missing = temp_dir("locked-bak-missing");
        let corrupt = temp_dir("locked-bak-corrupt");
        fs::write(corrupt.join("config.json"), b"{not json").unwrap();
        let mut locks = Vec::new();
        for dir in [&missing, &corrupt] {
            fs::write(dir.join("config.json.bak"), &bak).unwrap();
            locks.push(lock_for(&dir.join("config.json.bak"), Duration::from_secs(3)));
            let mut s = ConfigStore::open(dir, defaults());
            assert!(s.read_only(), "{}", dir.display());
            assert!(!s.is_new, "not a first start: {}", dir.display());
            s.flush();
            s.update(|c| c.enabled = false);
            s.flush();
            assert_eq!(s.write_count(), 0, "{}", dir.display());
        }
        assert!(!missing.join("config.json").exists(), "no defaults written in place of the library");
        assert_eq!(fs::read(corrupt.join("config.json")).unwrap(), b"{not json");
        for lock in locks {
            lock.join().unwrap();
        }
        for dir in [&missing, &corrupt] {
            assert_eq!(fs::read(dir.join("config.json.bak")).unwrap(), bak.as_bytes(), "{}", dir.display());
        }
    }

    #[test]
    fn same_lossy_or_corrupt_file_is_copied_once() {
        for (name, text, prefix) in [
            ("dedupe-lossy", r#"{"version": 6, "profiles": []}"#, "config.json.lossy-"),
            ("dedupe-corrupt", "{not json", "config.json.corrupt-"),
        ] {
            let dir = temp_dir(name);
            fs::write(dir.join("config.json"), text).unwrap();
            for _ in 0..2 {
                drop(ConfigStore::open(&dir, defaults()));
                std::thread::sleep(Duration::from_millis(5)); // a second copy would get another name
            }
            let copies = files_starting_with(&dir, prefix);
            assert_eq!(copies.len(), 1, "{name}: an unchanged file is copied once, not on every start");
            assert_eq!(fs::read(&copies[0]).unwrap(), text.as_bytes(), "{name}");
            fs::write(dir.join("config.json"), format!("{text} ")).unwrap();
            drop(ConfigStore::open(&dir, defaults()));
            assert_eq!(files_starting_with(&dir, prefix).len(), 2, "{name}: other content gets its own copy");
        }
    }

    #[test]
    fn flush_and_exit_retry_a_briefly_failing_save() {
        // a short lock on config.json right at exit (scanner, sync tool) must not lose the last change
        let free_after = |file: PathBuf| {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(250));
                fs::remove_dir(&file).unwrap();
            })
        };
        let dir = temp_dir("flush-retry");
        let file = dir.join("config.json");
        let mut s = ConfigStore::open(&dir, defaults());
        fs::create_dir_all(&file).unwrap(); // a directory where the file should be makes the rename fail
        s.update(|c| c.display.offset_x = 3);
        let free = free_after(file.clone());
        s.flush();
        free.join().unwrap();
        assert_eq!(s.write_count(), 1, "flush retried within its bounded wait");

        let dir = temp_dir("stop-retry");
        let file = dir.join("config.json");
        let mut s = ConfigStore::open(&dir, defaults());
        fs::create_dir_all(&file).unwrap();
        s.update(|c| c.display.offset_y = 4);
        let free = free_after(file.clone());
        drop(s);
        free.join().unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["display"]["offsetY"], 4, "the save at exit was retried, not lost");
    }
}
