//! Where Crosshair Z keeps its data. Same folder as the Electron builds (`%APPDATA%\Crosshair Z`),
//! so `config.json` carries over; `CZ_USERDATA` overrides it for isolated dev/test runs.

use std::ffi::OsString;
use std::path::PathBuf;

const APP_DIR_NAME: &str = "Crosshair Z";
const USERDATA_ENV: &str = "CZ_USERDATA";

/// Resolve the data dir from the two environment values (pure, testable).
pub fn resolve_data_dir(userdata_override: Option<OsString>, appdata: Option<OsString>) -> PathBuf {
    if let Some(dir) = userdata_override.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    match appdata.filter(|d| !d.is_empty()) {
        Some(appdata) => PathBuf::from(appdata).join(APP_DIR_NAME),
        // No APPDATA (should not happen on Windows): stay next to the working dir rather than fail.
        None => PathBuf::from(APP_DIR_NAME),
    }
}

/// Data dir for this process.
pub fn data_dir() -> PathBuf {
    resolve_data_dir(std::env::var_os(USERDATA_ENV), std::env::var_os("APPDATA"))
}

/// True when running with an isolated data dir (dev/test): must not touch autostart etc.
pub fn is_isolated() -> bool {
    std::env::var_os(USERDATA_ENV).is_some_and(|d| !d.is_empty())
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

pub fn sprites_dir() -> PathBuf {
    data_dir().join("sprites")
}

pub fn webview_dir() -> PathBuf {
    data_dir().join("webview2")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_wins() {
        let d = resolve_data_dir(Some("D:\\tmp\\cz".into()), Some("C:\\Users\\x\\AppData\\Roaming".into()));
        assert_eq!(d, PathBuf::from("D:\\tmp\\cz"));
    }

    #[test]
    fn appdata_default() {
        let d = resolve_data_dir(None, Some("C:\\Users\\x\\AppData\\Roaming".into()));
        assert_eq!(d, PathBuf::from("C:\\Users\\x\\AppData\\Roaming\\Crosshair Z"));
    }

    #[test]
    fn empty_override_ignored() {
        let d = resolve_data_dir(Some("".into()), Some("C:\\R".into()));
        assert_eq!(d, PathBuf::from("C:\\R\\Crosshair Z"));
    }

    #[test]
    fn no_appdata_falls_back_to_relative() {
        assert_eq!(resolve_data_dir(None, None), PathBuf::from("Crosshair Z"));
    }
}
