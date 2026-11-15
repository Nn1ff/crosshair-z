//! Optional update check against GitHub releases (port of `src/main/updater.js`). The app never
//! depends on it: every failure is logged and reported as "no update". HTTP via WinHTTP, so TLS,
//! proxies and redirects come from Windows.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_QUERY_STATUS_CODE,
};

use crate::logger;

pub const RELEASES_URL: &str = "https://api.github.com/repos/Nn1ff/crosshair-z/releases/latest";
pub const ASSET_NAME: &str = "Crosshair-Z.exe";
const DOWNLOAD_HOST_PREFIX: &str = "https://github.com/";
const USER_AGENT: &str = "Crosshair-Z";
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const CHECK_RETRIES: u32 = 2;
const RETRY_BASE: Duration = Duration::from_secs(2);
/// WinHTTP timeout of each network operation of a download; a `.part` file that has not been
/// written for this long belongs to no running download.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Limit for a whole download (`DOWNLOAD_TIMEOUT` only bounds each operation).
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(10 * 60);
pub const MAX_ASSET_BYTES: u64 = 300 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub page: Option<String>,
}

fn trusted_asset_url(url: &str, version: &str) -> bool {
    [format!("v{version}"), version.to_string()].iter().any(|tag| {
        url == format!("https://github.com/Nn1ff/crosshair-z/releases/download/{tag}/{ASSET_NAME}")
    })
}

fn valid_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Preserve actionable antivirus diagnostics instead of suggesting an update retry or bypass.
pub fn file_error(err: &std::io::Error) -> String {
    if matches!(err.raw_os_error(), Some(225 | 226)) {
        return "Windows antivirus blocked or removed the update. Open Windows Security > Protection history for the detection name. Keep protection enabled and report the file to Microsoft for review.".into();
    }
    err.to_string()
}

/// `x.y.z`, digits only: the form of release versions and of versioned exe names.
pub(crate) fn is_release_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `v1.2.3` / `1.2.3` → `1.2.3`; anything but exactly three numeric parts → `None`.
fn version_of(tag: &str) -> Option<String> {
    let t = tag.trim();
    let t = t.strip_prefix('v').unwrap_or(t);
    is_release_version(t).then(|| t.to_string())
}

/// Returns a positive number when `a` is newer than `b`: dotted numbers (missing parts = 0); on equal numbers a
/// prerelease (`2.0.0-beta.1`) is older than the release (`2.0.0`), prereleases compare as text.
pub fn compare_versions(a: &str, b: &str) -> i64 {
    let split = |s: &str| -> (Vec<i64>, Option<String>) {
        let (core, pre) = match s.trim().split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (s.trim(), None),
        };
        (core.split('.').map(|p| p.trim().parse::<i64>().unwrap_or(0)).collect(), pre)
    };
    let ((pa, prea), (pb, preb)) = (split(a), split(b));
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0) - pb.get(i).copied().unwrap_or(0);
        if d != 0 {
            return d;
        }
    }
    match (prea, preb) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(x), Some(y)) => x.cmp(&y) as i64,
    }
}

/// The portable exe asset of a GitHub "latest release" payload (drafts / prereleases ignored).
pub fn parse_release(json: &Value) -> Option<Release> {
    if json.get("draft") == Some(&Value::Bool(true)) || json.get("prerelease") == Some(&Value::Bool(true)) {
        return None;
    }
    let version = version_of(json.get("tag_name")?.as_str()?)?;
    let asset = json.get("assets")?.as_array()?.iter().find(|a| a.get("name").and_then(Value::as_str) == Some(ASSET_NAME))?;
    let url = asset.get("browser_download_url")?.as_str()?.to_string();
    if !trusted_asset_url(&url, &version) {
        return None;
    }
    let size = asset.get("size")?.as_u64().filter(|s| *s > 0 && *s <= MAX_ASSET_BYTES)?;
    let sha256 = asset.get("digest")?.as_str()?.strip_prefix("sha256:")?;
    if !valid_sha256(sha256) {
        return None;
    }
    let page = json.get("html_url").and_then(Value::as_str).filter(|p| p.starts_with(DOWNLOAD_HOST_PREFIX)).map(String::from);
    Some(Release { version, url, size, sha256: sha256.to_ascii_lowercase(), page })
}

#[derive(Debug)]
pub struct HttpError {
    pub status: Option<u32>,
    pub message: String,
}

impl HttpError {
    /// Worth retrying: network error, timeout, 5xx.
    pub fn transient(&self) -> bool {
        self.status.is_none_or(|s| s >= 500)
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "HTTP {s}"),
            None => write!(f, "{}", self.message),
        }
    }
}

/// Closes a WinHTTP handle on drop.
struct Handle(*mut std::ffi::c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

fn net_err(what: &str, e: windows::core::Error) -> HttpError {
    HttpError { status: None, message: format!("{what}: {e}") }
}

/// HTTPS GET; `sink` receives the body in chunks. Returns the status code (2xx only, 404 too).
fn http_get(url: &str, timeout: Duration, accept: Option<&str>, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>) -> Result<u32, HttpError> {
    let parsed: tauri::Url = url.parse().map_err(|e| HttpError { status: None, message: format!("bad url: {e}") })?;
    if parsed.scheme() != "https" {
        return Err(HttpError { status: None, message: "only https allowed".into() });
    }
    let host = parsed.host_str().ok_or(HttpError { status: None, message: "url without host".into() })?;
    let path = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_string(),
    };
    let ms = timeout.as_millis().min(i32::MAX as u128) as i32;
    unsafe {
        let session = Handle(WinHttpOpen(&HSTRING::from(USER_AGENT), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0));
        if session.0.is_null() {
            return Err(net_err("WinHttpOpen", windows::core::Error::from_win32()));
        }
        WinHttpSetTimeouts(session.0, ms, ms, ms, ms).map_err(|e| net_err("timeouts", e))?;
        let connect = Handle(WinHttpConnect(session.0, &HSTRING::from(host), 443, 0));
        if connect.0.is_null() {
            return Err(net_err("connect", windows::core::Error::from_win32()));
        }
        let request = Handle(WinHttpOpenRequest(connect.0, &HSTRING::from("GET"), &HSTRING::from(path.as_str()), PCWSTR::null(), PCWSTR::null(), std::ptr::null(), WINHTTP_FLAG_SECURE));
        if request.0.is_null() {
            return Err(net_err("open request", windows::core::Error::from_win32()));
        }
        let headers = match accept {
            Some(a) => format!("Accept: {a}\r\n"),
            None => String::new(),
        };
        let wide: Vec<u16> = headers.encode_utf16().collect();
        let header_slice = if wide.is_empty() { None } else { Some(wide.as_slice()) };
        WinHttpSendRequest(request.0, header_slice, None, 0, 0, 0).map_err(|e| net_err("send", e))?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(|e| net_err("receive", e))?;
        let mut status: u32 = 0;
        let mut len = std::mem::size_of::<u32>() as u32;
        WinHttpQueryHeaders(request.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, PCWSTR::null(), Some(&mut status as *mut u32 as *mut _), &mut len, std::ptr::null_mut())
            .map_err(|e| net_err("status", e))?;
        if status == 404 {
            return Ok(404);
        }
        if !(200..300).contains(&status) {
            return Err(HttpError { status: Some(status), message: format!("HTTP {status}") });
        }
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            let mut read: u32 = 0;
            WinHttpReadData(request.0, buf.as_mut_ptr() as *mut _, buf.len() as u32, &mut read).map_err(|e| net_err("read", e))?;
            if read == 0 {
                break;
            }
            sink(&buf[..read as usize]).map_err(|m| HttpError { status: None, message: m })?;
        }
        Ok(status)
    }
}

fn fetch_json(url: &str) -> Result<Option<Value>, HttpError> {
    let mut body = Vec::new();
    let status = http_get(url, CHECK_TIMEOUT, Some("application/vnd.github+json"), &mut |chunk| {
        if body.len() + chunk.len() > MAX_JSON_BYTES {
            return Err("response too large".into());
        }
        body.extend_from_slice(chunk);
        Ok(())
    })?;
    if status == 404 {
        // no published release yet, or the repository moved
        logger::warn("releases endpoint returned 404", json!({"url": url}));
        return Ok(None);
    }
    serde_json::from_slice(&body).map(Some).map_err(|e| HttpError { status: Some(status), message: format!("bad json: {e}") })
}

/// Newer release than `current`, or None. Never fails.
pub fn check_for_update(current: &str) -> Option<Release> {
    let started = Instant::now();
    for attempt in 0..=CHECK_RETRIES {
        match fetch_json(RELEASES_URL) {
            Ok(json) => {
                let rel = json.as_ref().and_then(parse_release);
                if let (Some(j), None) = (&json, &rel) {
                    logger::warn("update check: unusable release payload", json!({"tag": j.get("tag_name")}));
                }
                let newer = rel.filter(|r| compare_versions(&r.version, current) > 0);
                logger::info("update check done", json!({"current": current, "newer": newer.as_ref().map(|r| &r.version), "ms": started.elapsed().as_millis() as u64}));
                return newer;
            }
            Err(err) => {
                let transient = err.transient();
                logger::warn("update check failed", json!({"attempt": attempt, "transient": transient, "error": err.to_string()}));
                if !transient || attempt == CHECK_RETRIES {
                    return None;
                }
                std::thread::sleep(RETRY_BASE * 2u32.pow(attempt));
            }
        }
    }
    None
}

pub fn versioned_exe_name(version: &str) -> String {
    format!("Crosshair Z {version}.exe")
}

/// Download next to the running exe via `.part`; verify release origin, size and SHA-256 before installation.
pub fn download(release: &Release, dir: &Path) -> Result<PathBuf, String> {
    if version_of(&release.version).as_deref() != Some(release.version.as_str()) || !trusted_asset_url(&release.url, &release.version) ||
        !valid_sha256(&release.sha256) || release.size == 0 || release.size > MAX_ASSET_BYTES {
        return Err("invalid release".into());
    }
    let dest = dir.join(versioned_exe_name(&release.version));
    let part = dir.join(format!("{}.part", versioned_exe_name(&release.version)));
    let started = Instant::now();
    let deadline = started + DOWNLOAD_DEADLINE;
    logger::info("update download start", json!({"version": release.version, "dest": dest.display().to_string()}));
    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&part).map_err(|e| file_error(&e))?;
        let mut written: u64 = 0;
        let mut hash = Sha256::new();
        http_get(&release.url, DOWNLOAD_TIMEOUT, None, &mut |chunk| {
            if Instant::now() > deadline {
                return Err(format!("download did not finish within {} minutes", DOWNLOAD_DEADLINE.as_secs() / 60));
            }
            written += chunk.len() as u64;
            if written > MAX_ASSET_BYTES {
                return Err("download larger than allowed".into());
            }
            file.write_all(chunk).map_err(|e| file_error(&e))?;
            hash.update(chunk);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
        file.flush().map_err(|e| file_error(&e))?;
        file.sync_all().map_err(|e| file_error(&e))?; // on disk before the rename makes it the update
        drop(file);
        if written != release.size {
            return Err(format!("size mismatch: got {written}, expected {}", release.size));
        }
        let actual: [u8; 32] = hash.finalize().into();
        verify_sha256(&actual, &release.sha256)?;
        fs::rename(&part, &dest).map_err(|e| file_error(&e))
    })();
    match result {
        Ok(()) => {
            logger::info("update download done", json!({"dest": dest.display().to_string(), "ms": started.elapsed().as_millis() as u64}));
            Ok(dest)
        }
        Err(err) => {
            let _ = fs::remove_file(&part);
            logger::error("update download failed", json!({"version": release.version, "error": err}));
            Err(err)
        }
    }
}

fn verify_sha256(actual: &[u8], expected: &str) -> Result<(), String> {
    let hex: String = actual.iter().map(|b| format!("{b:02x}")).collect();
    if !valid_sha256(expected) || !hex.eq_ignore_ascii_case(expected) {
        return Err("SHA-256 mismatch: the update does not match the published release and was not installed.".into());
    }
    Ok(())
}

/// "Crosshair Z 1.2.3.exe" or its ".part" → (version, is_part).
fn parse_versioned(name: &str) -> Option<(&str, bool)> {
    let rest = name.strip_prefix("Crosshair Z ")?;
    let (ver, part) = match rest.strip_suffix(".exe.part") {
        Some(v) => (v, true),
        None => (rest.strip_suffix(".exe")?, false),
    };
    is_release_version(ver).then_some((ver, part))
}

/// True when `path` is known to be unmodified for at least `age` (unknown or future times: false).
fn unmodified_for(path: &Path, age: Duration) -> bool {
    fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a >= age)
}

/// Delete older "Crosshair Z <version>.exe" copies and stale ".part" downloads in `dir`.
/// Never touches the running exe, newer/equal versions, a `.part` that may still be downloading
/// or any other file.
pub fn cleanup_old_versions(dir: &Path, current_version: &str, current_exe: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let names: Vec<String> = entries.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    if names.iter().any(|n| n == "win-unpacked") {
        return Vec::new(); // electron-builder output folder, not an update location
    }
    let me = current_exe.to_string_lossy().to_lowercase();
    let mut removed = Vec::new();
    for name in names {
        let Some((ver, part)) = parse_versioned(&name) else { continue };
        let file = dir.join(&name);
        let keep = if part { !unmodified_for(&file, DOWNLOAD_TIMEOUT) } else { compare_versions(ver, current_version) >= 0 };
        if keep || file.to_string_lossy().to_lowercase() == me {
            continue;
        }
        match fs::remove_file(&file) {
            Ok(()) => removed.push(name),
            Err(err) => logger::warn("update cleanup: could not remove", json!({"file": file.display().to_string(), "error": err.to_string()})),
        }
    }
    if !removed.is_empty() {
        logger::info("update cleanup removed old versions", json!({"dir": dir.display().to_string(), "removed": removed}));
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel_json() -> Value {
        json!({
            "tag_name": "v2.1.0", "draft": false, "prerelease": false,
            "html_url": "https://github.com/Nn1ff/crosshair-z/releases/tag/v2.1.0",
            "assets": [
                {"name": "other.zip", "browser_download_url": "https://github.com/x/other.zip", "size": 5},
                {"name": "Crosshair-Z.exe", "browser_download_url": "https://github.com/Nn1ff/crosshair-z/releases/download/v2.1.0/Crosshair-Z.exe", "size": 4000000, "digest": format!("sha256:{}", "a".repeat(64))}
            ]
        })
    }

    #[test]
    fn compare() {
        assert!(compare_versions("2.0.0", "1.8.7") > 0);
        assert!(compare_versions("1.8.7", "1.8.10") < 0);
        assert_eq!(compare_versions("1.8", "1.8.0"), 0);
        assert!(compare_versions("2.0.0", "2.0.0-beta.1") > 0);
        assert!(compare_versions("2.0.0-beta.2", "2.0.0-beta.1") > 0);
        assert!(compare_versions("2.0.0-beta.1", "1.8.7") > 0);
    }

    #[test]
    fn parses_release() {
        let r = parse_release(&rel_json()).unwrap();
        assert_eq!(r.version, "2.1.0");
        assert_eq!(r.size, 4_000_000);
        assert!(r.url.ends_with("/Crosshair-Z.exe"));
        assert!(r.page.unwrap().starts_with("https://github.com/"));
    }

    #[test]
    fn rejects_bad_releases() {
        let mut j = rel_json();
        j["prerelease"] = json!(true);
        assert!(parse_release(&j).is_none());
        let mut j = rel_json();
        j["tag_name"] = json!("nightly");
        assert!(parse_release(&j).is_none());
        let mut j = rel_json();
        j["assets"][1]["browser_download_url"] = json!("https://evil.example/Crosshair-Z.exe");
        assert!(parse_release(&j).is_none());
        let mut j = rel_json();
        j["assets"][1]["size"] = json!(MAX_ASSET_BYTES + 1);
        assert!(parse_release(&j).is_none());
        let mut j = rel_json();
        j["assets"] = json!([]);
        assert!(parse_release(&j).is_none());
    }

    #[test]
    fn transient_errors() {
        assert!(HttpError { status: None, message: "x".into() }.transient());
        assert!(HttpError { status: Some(503), message: "x".into() }.transient());
        assert!(!HttpError { status: Some(403), message: "x".into() }.transient());
    }

    #[test]
    fn requires_correct_repository_version_and_digest() {
        let mut j = rel_json();
        j["assets"][1]["browser_download_url"] = json!("https://github.com/other/repo/releases/download/v2.1.0/Crosshair-Z.exe");
        assert!(parse_release(&j).is_none());
        let mut j = rel_json();
        j["assets"][1]["browser_download_url"] = json!("https://github.com/Nn1ff/crosshair-z/releases/download/v1.0.0/Crosshair-Z.exe");
        assert!(parse_release(&j).is_none());
        for digest in [Value::Null, json!("sha256:abc"), json!(format!("sha256:{}", "g".repeat(64))), json!(format!("sha1:{}", "a".repeat(64)))] {
            let mut j = rel_json();
            j["assets"][1]["digest"] = digest;
            assert!(parse_release(&j).is_none());
        }
    }

    #[test]
    fn validates_download_hash_even_when_size_is_unchanged() {
        let actual: [u8; 32] = Sha256::digest(b"original").into();
        let expected: String = actual.iter().map(|b| format!("{b:02x}")).collect();
        assert!(verify_sha256(&actual, &expected.to_uppercase()).is_ok());
        let tampered: [u8; 32] = Sha256::digest(b"modified").into();
        assert!(verify_sha256(&tampered, &expected).is_err());
        assert!(verify_sha256(&actual, "").is_err());
    }

    #[test]
    fn download_revalidates_metadata_before_creating_files() {
        let mut r = parse_release(&rel_json()).unwrap();
        r.url = "https://github.com/other/repo/app.exe".into();
        let dir = std::env::temp_dir().join(format!("cz-rejected-update-{}", std::process::id()));
        assert_eq!(download(&r, &dir).unwrap_err(), "invalid release");
        assert!(!dir.exists());
    }

    #[test]
    fn antivirus_errors_explain_block_without_suggesting_exclusions() {
        for code in [225, 226] {
            let text = file_error(&std::io::Error::from_raw_os_error(code));
            assert!(text.contains("Protection history"));
            assert!(text.contains("Keep protection enabled"));
        }
        let ordinary = std::io::Error::from_raw_os_error(5);
        assert_eq!(file_error(&ordinary), ordinary.to_string());
    }

    /// Backdate the last-write time of `path` by `age`.
    fn set_age(path: &Path, age: Duration) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(std::time::SystemTime::now() - age).unwrap();
    }

    #[test]
    fn version_needs_three_parts() {
        assert_eq!(version_of("v2.1"), None);
        assert_eq!(version_of("v2.0.6").as_deref(), Some("2.0.6"));
        assert_eq!(version_of(" 2.0.6 ").as_deref(), Some("2.0.6"));
        assert_eq!(version_of("v2.0.6.1"), None);
        assert_eq!(version_of("v2..6"), None);
    }

    #[test]
    fn cleanup_keeps_fresh_part() {
        let dir = std::env::temp_dir().join(format!("cz-upd-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for n in ["Crosshair Z 2.0.6.exe.part", "Crosshair Z 2.0.7.exe.part"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        set_age(&dir.join("Crosshair Z 2.0.7.exe.part"), Duration::from_secs(10 * 60));
        let removed = cleanup_old_versions(&dir, "2.0.5", &dir.join("Crosshair Z 2.0.5.exe"));
        assert_eq!(removed, vec!["Crosshair Z 2.0.7.exe.part"], "only the abandoned download is removed");
        assert!(dir.join("Crosshair Z 2.0.6.exe.part").exists(), "a download may still be writing a fresh .part");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_removes_only_older_copies() {
        let dir = std::env::temp_dir().join(format!("cz-upd-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for n in ["Crosshair Z 1.8.6.exe", "Crosshair Z 1.8.7.exe", "Crosshair Z 2.0.0.exe", "Crosshair Z 2.1.0.exe", "Crosshair Z 2.1.0.exe.part", "Crosshair-Z.exe", "notes.txt"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        set_age(&dir.join("Crosshair Z 2.1.0.exe.part"), Duration::from_secs(10 * 60)); // an abandoned download
        let mut removed = cleanup_old_versions(&dir, "2.0.0", &dir.join("Crosshair Z 2.0.0.exe"));
        removed.sort();
        assert_eq!(removed, vec!["Crosshair Z 1.8.6.exe", "Crosshair Z 1.8.7.exe", "Crosshair Z 2.1.0.exe.part"]);
        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["Crosshair Z 2.0.0.exe", "Crosshair Z 2.1.0.exe", "Crosshair-Z.exe", "notes.txt"]);
    }

    #[test]
    #[ignore = "network"]
    fn live_github_check() {
        // 0.0.1 is older than anything published → returns the latest release when one exists
        let r = check_for_update("0.0.1");
        println!("{r:?}");
    }
}
