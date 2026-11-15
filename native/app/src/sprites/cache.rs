//! Sprite sets by crosshair + scale: in RAM for the profiles that can appear, on disk
//! (`sprites/<key>.bin`, newest 512 kept, never those held in RAM) so a restart shows the
//! crosshair without a WebView.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::codec::{SpriteError, SpriteSet, FORMAT_VERSION};
use crate::logger;

pub const MAX_DISK_FILES: usize = 512;
const EXT: &str = "bin";

/// Cache key: sha256 over format version, scale and the crosshair JSON (key order preserved).
pub fn cache_key(crosshair: &Value, scale: f64) -> String {
    let mut h = Sha256::new();
    h.update(format!("CZSP{FORMAT_VERSION}-render2\n{scale}\n").as_bytes());
    h.update(serde_json::to_vec(crosshair).unwrap_or_default());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

pub struct SpriteCache {
    dir: PathBuf,
    mem: HashMap<String, Arc<SpriteSet>>,
}

impl SpriteCache {
    pub fn new(dir: &Path) -> SpriteCache {
        if let Err(err) = fs::create_dir_all(dir) {
            logger::error("sprite cache dir unavailable", json!({"dir": dir.display().to_string(), "error": err.to_string()}));
        }
        SpriteCache { dir: dir.to_path_buf(), mem: HashMap::new() }
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.{EXT}"))
    }

    /// RAM first, then disk. A damaged file is deleted (it will be rendered again).
    pub fn get(&mut self, key: &str) -> Option<Arc<SpriteSet>> {
        if let Some(set) = self.mem.get(key) {
            return Some(set.clone());
        }
        if !valid_key(key) {
            return None;
        }
        let path = self.path(key);
        let bytes = fs::read(&path).ok()?;
        match SpriteSet::decode(&bytes) {
            Ok(set) => {
                let set = Arc::new(set);
                self.mem.insert(key.to_string(), set.clone());
                touch(&path);
                Some(set)
            }
            Err(err) => {
                logger::warn("sprite cache file invalid, deleting", json!({"key": key, "error": err.to_string()}));
                let _ = fs::remove_file(&path);
                None
            }
        }
    }

    /// Validate and store rendered sprites (RAM + disk).
    pub fn put(&mut self, key: &str, bytes: &[u8]) -> Result<Arc<SpriteSet>, SpriteError> {
        let set = Arc::new(SpriteSet::decode(bytes)?);
        self.mem.insert(key.to_string(), set.clone());
        if valid_key(key) {
            self.write_disk(key, bytes);
        }
        Ok(set)
    }

    fn write_disk(&self, key: &str, bytes: &[u8]) {
        let path = self.path(key);
        let tmp = path.with_extension("tmp");
        let result = fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, &path));
        if let Err(err) = result {
            let _ = fs::remove_file(&tmp);
            logger::error("sprite cache write failed", json!({"key": key, "error": err.to_string()}));
            return;
        }
        self.prune_disk();
    }

    /// Keep `MAX_DISK_FILES` sprite files: every set held in RAM (it may be on screen), then the
    /// newest of the rest. Runs after every write on the app thread, so it counts first and reads
    /// mtimes (from the directory listing, no extra file opens) only when there is something to prune.
    fn prune_disk(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let sprites: Vec<(PathBuf, fs::DirEntry)> = entries
            .filter_map(Result::ok)
            .map(|e| (e.path(), e))
            .filter(|(p, _)| p.extension().is_some_and(|x| x == EXT))
            .collect();
        if sprites.len() <= MAX_DISK_FILES {
            return;
        }
        let files = sprites.into_iter().filter_map(|(p, e)| Some((e.metadata().ok()?.modified().ok()?, p)));
        let (held, mut rest): (Vec<_>, Vec<_>) = files.partition(|(_, p)| self.holds_file(p));
        rest.sort_by_key(|f| std::cmp::Reverse(f.0));
        for (_, p) in rest.into_iter().skip(MAX_DISK_FILES.saturating_sub(held.len())) {
            if let Err(err) = fs::remove_file(&p) {
                logger::warn("sprite cache prune failed", json!({"file": p.display().to_string(), "error": err.to_string()}));
            }
        }
    }

    /// True when `path` is the disk copy of a set held in RAM.
    fn holds_file(&self, path: &Path) -> bool {
        path.file_stem().and_then(|s| s.to_str()).is_some_and(|key| self.mem.contains_key(key))
    }

    /// Drop RAM entries not in `keep` (disk stays).
    pub fn retain_mem(&mut self, keep: &HashSet<String>) {
        self.mem.retain(|k, _| keep.contains(k));
    }

    pub fn mem_len(&self) -> usize {
        self.mem.len()
    }
}

/// Mark a file as recently used for LRU pruning.
fn touch(path: &Path) {
    if let Ok(f) = fs::OpenOptions::new().append(true).open(path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cz-cache-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn bytes() -> Vec<u8> {
        SpriteSet::fallback().encode()
    }

    #[test]
    fn key_is_stable_and_scale_sensitive() {
        let ch = json!({"version": 3, "layers": [{"name": "a"}]});
        assert_eq!(cache_key(&ch, 1.0), cache_key(&ch.clone(), 1.0));
        assert_ne!(cache_key(&ch, 1.0), cache_key(&ch, 1.25));
        assert_ne!(cache_key(&ch, 1.0), cache_key(&json!({"version": 3, "layers": [{"name": "b"}]}), 1.0));
        assert!(valid_key(&cache_key(&ch, 1.0)));
    }

    #[test]
    fn put_then_get_from_disk_in_new_instance() {
        let dir = temp_dir("roundtrip");
        let key = cache_key(&json!({"x": 1}), 1.0);
        SpriteCache::new(&dir).put(&key, &bytes()).unwrap();
        assert!(!dir.join(format!("{key}.tmp")).exists());
        let mut fresh = SpriteCache::new(&dir);
        assert_eq!(*fresh.get(&key).unwrap(), SpriteSet::fallback());
        assert_eq!(fresh.mem_len(), 1);
    }

    #[test]
    fn invalid_bytes_rejected_by_put() {
        let mut c = SpriteCache::new(&temp_dir("bad-put"));
        assert!(c.put(&cache_key(&json!(1), 1.0), b"nope").is_err());
        assert_eq!(c.mem_len(), 0);
    }

    #[test]
    fn corrupt_file_deleted_on_get() {
        let dir = temp_dir("corrupt");
        let key = cache_key(&json!({"x": 2}), 1.0);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{key}.bin")), b"CZSP-truncated").unwrap();
        assert!(SpriteCache::new(&dir).get(&key).is_none());
        assert!(!dir.join(format!("{key}.bin")).exists());
    }

    #[test]
    fn foreign_keys_never_touch_disk() {
        let dir = temp_dir("foreign");
        let mut c = SpriteCache::new(&dir);
        assert!(c.get("../../evil").is_none());
        c.put("../evil", &bytes()).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    fn set_age(dir: &Path, key: &str, i: usize) {
        // distinct mtimes so "newest" is well defined (i = 0 is the oldest)
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + i as u64);
        fs::OpenOptions::new().append(true).open(dir.join(format!("{key}.bin"))).unwrap().set_modified(t).unwrap();
    }

    /// `MAX_DISK_FILES + 3` sprite files on disk only (not in RAM), oldest first.
    fn fill_disk(dir: &Path) -> Vec<String> {
        fs::create_dir_all(dir).unwrap();
        let keys: Vec<String> = (0..MAX_DISK_FILES + 3).map(|i| cache_key(&json!(i), 1.0)).collect();
        for (i, k) in keys.iter().enumerate() {
            fs::write(dir.join(format!("{k}.bin")), bytes()).unwrap();
            set_age(dir, k, i);
        }
        keys
    }

    #[test]
    fn prunes_to_newest_max_disk_files() {
        assert_eq!(MAX_DISK_FILES, 512);
        let dir = temp_dir("prune");
        let keys = fill_disk(&dir);
        let mut c = SpriteCache::new(&dir);
        c.put(&cache_key(&json!("last"), 1.0), &bytes()).unwrap();
        let left = fs::read_dir(&dir).unwrap().count();
        assert_eq!(left, MAX_DISK_FILES);
        assert!(!dir.join(format!("{}.bin", keys[0])).exists(), "oldest pruned");
        assert!(dir.join(format!("{}.bin", keys[keys.len() - 1])).exists(), "newest kept");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_never_deletes_ram_keys() {
        let dir = temp_dir("prune-ram");
        let keys = fill_disk(&dir);
        let mut c = SpriteCache::new(&dir);
        let held = &keys[0];
        assert!(c.get(held).is_some(), "loaded into RAM");
        set_age(&dir, held, 0); // still the oldest file on disk
        c.put(&cache_key(&json!("last"), 1.0), &bytes()).unwrap();
        assert!(dir.join(format!("{held}.bin")).exists(), "held in RAM: never pruned");
        assert!(!dir.join(format!("{}.bin", keys[1])).exists(), "oldest file not in RAM pruned");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), MAX_DISK_FILES, "RAM files count toward the limit");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn retain_mem_drops_others() {
        let mut c = SpriteCache::new(&temp_dir("retain"));
        let (a, b) = (cache_key(&json!("a"), 1.0), cache_key(&json!("b"), 1.0));
        c.put(&a, &bytes()).unwrap();
        c.put(&b, &bytes()).unwrap();
        c.retain_mem(&HashSet::from([a.clone()]));
        assert_eq!(c.mem_len(), 1);
    }
}
