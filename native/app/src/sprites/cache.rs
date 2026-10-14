//! Sprite sets by crosshair + scale: in RAM for the profiles that can appear, on disk
//! (`sprites/<key>.bin`, newest 64 kept) so a restart shows the crosshair without a WebView.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::codec::{SpriteError, SpriteSet, FORMAT_VERSION};
use crate::logger;

pub const MAX_DISK_FILES: usize = 64;
const EXT: &str = "bin";

/// Cache key: sha256 over format version, scale and the crosshair JSON (key order preserved).
pub fn cache_key(crosshair: &Value, scale: f64) -> String {
    let mut h = Sha256::new();
    h.update(format!("CZSP{FORMAT_VERSION}\n{scale}\n").as_bytes());
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

    /// Keep the newest `MAX_DISK_FILES` sprite files.
    fn prune_disk(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == EXT))
            .filter_map(|p| Some((fs::metadata(&p).ok()?.modified().ok()?, p)))
            .collect();
        if files.len() <= MAX_DISK_FILES {
            return;
        }
        files.sort_by_key(|f| std::cmp::Reverse(f.0));
        for (_, p) in files.into_iter().skip(MAX_DISK_FILES) {
            if let Err(err) = fs::remove_file(&p) {
                logger::warn("sprite cache prune failed", json!({"file": p.display().to_string(), "error": err.to_string()}));
            }
        }
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

    #[test]
    fn prunes_to_newest_64() {
        let dir = temp_dir("prune");
        let mut c = SpriteCache::new(&dir);
        let keys: Vec<String> = (0..MAX_DISK_FILES + 3).map(|i| cache_key(&json!(i), 1.0)).collect();
        for (i, k) in keys.iter().enumerate() {
            c.put(k, &bytes()).unwrap();
            // distinct mtimes so "newest" is well defined
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + i as u64);
            fs::OpenOptions::new().append(true).open(dir.join(format!("{k}.bin"))).unwrap().set_modified(t).unwrap();
        }
        c.put(&cache_key(&json!("last"), 1.0), &bytes()).unwrap();
        let left = fs::read_dir(&dir).unwrap().count();
        assert_eq!(left, MAX_DISK_FILES);
        assert!(!dir.join(format!("{}.bin", keys[0])).exists(), "oldest pruned");
        assert!(dir.join(format!("{}.bin", keys[keys.len() - 1])).exists(), "newest kept");
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
