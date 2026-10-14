//! Windows integration: autostart (HKCU Run), Start Menu shortcut, the 1.x Electron handover
//! (stop a running legacy instance) and removal of Electron-only files from the data dir.

use std::path::{Path, PathBuf};

use serde_json::json;
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Registry::{RegCloseKey, RegDeleteValueW, RegEnumValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_SZ};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, TerminateProcess, PROCESS_TERMINATE};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

use crate::logger;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Run-key value name of our one autostart entry (= Electron build.appId, so 1.x's entry is reused).
pub const LOGIN_ITEM_NAME: &str = "com.crosshairz.app";
const LEGACY_LOGIN_ITEM_NAMES: [&str; 1] = ["electron.app.Crosshair Z"];
const START_MENU_LINK_NAME: &str = "Crosshair Z.lnk";
const LINK_DESCRIPTION: &str = "Crosshair overlay for Windows games";
const MAX_VALUE_CHARS: usize = 16_384;
/// Files and folders Chromium/Electron kept in the data dir; never config.json, logs, sprites.
pub const ELECTRON_LEFTOVERS: [&str; 15] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Local Storage",
    "Session Storage",
    "Network",
    "Shared Dictionary",
    "SharedStorage",
    "blob_storage",
    "Preferences",
    "Local State",
    "Crashpad",
];

/// Port of `CZ_EXE_RE = /crosshair[ _-]?z[^\\/"]*\.exe/i` (no regex crate needed).
pub fn mentions_cz_exe(text: &str) -> bool {
    let t = text.to_lowercase();
    let b = t.as_bytes();
    let mut from = 0;
    while let Some(off) = t[from..].find("crosshair") {
        let mut i = from + off + "crosshair".len();
        if matches!(b.get(i), Some(b' ' | b'_' | b'-')) {
            i += 1;
        }
        if b.get(i) == Some(&b'z') {
            let rest = &t[i + 1..];
            let stop = rest.find(['\\', '/', '"']).unwrap_or(rest.len());
            if rest[..stop].contains(".exe") {
                return true;
            }
        }
        from += off + 1;
    }
    false
}

/// Run-key names that start some Crosshair Z exe but are not ours (autostart.js `staleEntryNames`).
pub fn stale_entry_names(entries: &[(String, String)], own: &str) -> Vec<String> {
    let mut out: Vec<String> = entries.iter().filter(|(n, d)| n != own && mentions_cz_exe(d)).map(|(n, _)| n.clone()).collect();
    for legacy in LEGACY_LOGIN_ITEM_NAMES {
        if entries.iter().any(|(n, _)| n == legacy) && !out.iter().any(|n| n == legacy) {
            out.push(legacy.to_string());
        }
    }
    out
}

/// `"C:\path\Crosshair-Z.exe" --hidden`, the format Electron's setLoginItemSettings wrote.
pub fn login_command(exe: &Path) -> String {
    format!("\"{}\" --hidden", exe.display())
}

struct RunKey(HKEY);

impl RunKey {
    fn open() -> Result<RunKey, String> {
        let mut key = HKEY::default();
        let r = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(RUN_KEY), Some(0), KEY_READ | KEY_SET_VALUE, &mut key) };
        if r != ERROR_SUCCESS {
            return Err(format!("open Run key: {r:?}"));
        }
        Ok(RunKey(key))
    }

    fn entries(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for index in 0u32.. {
            let mut name = vec![0u16; MAX_VALUE_CHARS];
            let mut name_len = name.len() as u32;
            let mut data = vec![0u8; MAX_VALUE_CHARS * 2];
            let mut data_len = data.len() as u32;
            let mut kind: u32 = 0;
            let r = unsafe {
                RegEnumValueW(self.0, index, Some(windows::core::PWSTR(name.as_mut_ptr())), &mut name_len, None, Some(&mut kind as *mut u32), Some(data.as_mut_ptr()), Some(&mut data_len))
            };
            if r == ERROR_NO_MORE_ITEMS {
                break;
            }
            if r != ERROR_SUCCESS {
                logger::warn("reading autostart entries failed", json!({"error": format!("{r:?}")}));
                break;
            }
            let wide: Vec<u16> = data[..data_len as usize].as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).take_while(|c| *c != 0).collect();
            out.push((String::from_utf16_lossy(&name[..name_len as usize]), String::from_utf16_lossy(&wide)));
        }
        out
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes: Vec<u8> = wide.iter().flat_map(|c| c.to_le_bytes()).collect();
        let r = unsafe { RegSetValueExW(self.0, &HSTRING::from(name), Some(0), REG_SZ, Some(&bytes)) };
        if r == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("{r:?}"))
        }
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        let r = unsafe { RegDeleteValueW(self.0, &HSTRING::from(name)) };
        if r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("{r:?}"))
        }
    }
}

impl Drop for RunKey {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

/// Exactly one autostart entry may exist (ours, pointing at `exe`) — or none. Never fails.
pub fn apply_login_item(enabled: bool, exe: &Path) {
    let key = match RunKey::open() {
        Ok(k) => k,
        Err(err) => {
            logger::error("autostart: Run key unavailable", json!({"error": err}));
            return;
        }
    };
    for name in stale_entry_names(&key.entries(), LOGIN_ITEM_NAME) {
        match key.delete(&name) {
            Ok(()) => logger::info("removed stale autostart entry", json!({"name": name})),
            Err(err) => logger::warn("removing stale autostart entry failed", json!({"name": name, "error": err})),
        }
    }
    let result = if enabled { key.set(LOGIN_ITEM_NAME, &login_command(exe)) } else { key.delete(LOGIN_ITEM_NAME) };
    match result {
        Ok(()) => logger::info("login item applied", json!({"openAtLogin": enabled, "path": exe.display().to_string()})),
        Err(err) => logger::error("login item update failed", json!({"error": err, "path": exe.display().to_string()})),
    }
}

/// Uninitializes COM on drop (only if this call initialized it).
struct Com(bool);

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn link_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs").join(START_MENU_LINK_NAME))
}

unsafe fn read_link_target(link: &IShellLinkW, file: &Path) -> Option<PathBuf> {
    let persist: IPersistFile = link.cast().ok()?;
    persist.Load(&HSTRING::from(file.as_os_str()), STGM_READ).ok()?;
    let mut buf = vec![0u16; 1024];
    let mut find = WIN32_FIND_DATAW::default();
    link.GetPath(&mut buf, &mut find, 0).ok()?;
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    (len > 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

/// Keep a per-user Start Menu shortcut pointing at the running exe (portable app: Windows search
/// does not know it otherwise). Re-pointed after an update or move. Never fails.
pub fn ensure_start_menu_shortcut(exe: &Path) {
    let Some(file) = link_path() else { return };
    unsafe {
        let _com = Com(CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok());
        let link: IShellLinkW = match CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) {
            Ok(l) => l,
            Err(err) => {
                logger::error("start menu shortcut: ShellLink unavailable", json!({"error": err.to_string()}));
                return;
            }
        };
        let current = if file.exists() { read_link_target(&link, &file) } else { None };
        if current.as_ref().is_some_and(|c| c.to_string_lossy().eq_ignore_ascii_case(&exe.to_string_lossy())) {
            return;
        }
        let exe_h = HSTRING::from(exe.as_os_str());
        let dir_h = HSTRING::from(exe.parent().unwrap_or(Path::new("")).as_os_str());
        let result = (|| -> windows::core::Result<()> {
            link.SetPath(&exe_h)?;
            link.SetWorkingDirectory(&dir_h)?;
            link.SetIconLocation(&exe_h, 0)?;
            link.SetDescription(&HSTRING::from(LINK_DESCRIPTION))?;
            let persist: IPersistFile = link.cast()?;
            persist.Save(&HSTRING::from(file.as_os_str()), true)
        })();
        match result {
            Ok(()) => logger::info("start menu shortcut written", json!({"link": file.display().to_string(), "target": exe.display().to_string(), "previous": current.map(|c| c.display().to_string())})),
            Err(err) => logger::error("start menu shortcut failed", json!({"link": file.display().to_string(), "error": err.to_string()})),
        }
    }
}

/// Stop Crosshair Z 1.x (Electron) processes. Called only while this process holds the
/// single-instance mutex, so any other Crosshair Z exe is a legacy build (or a 2.x copy that is
/// about to exit anyway). Config writes are atomic, so terminating is safe. Returns count.
pub fn stop_legacy_instances() -> usize {
    let me = unsafe { GetCurrentProcessId() };
    let mut stopped = 0;
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            logger::warn("process snapshot failed, legacy check skipped", None);
            return 0;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if entry.th32ProcessID != me && mentions_cz_exe(&name) {
                match OpenProcess(PROCESS_TERMINATE, false, entry.th32ProcessID) {
                    Ok(h) => {
                        let done = TerminateProcess(h, 0).is_ok();
                        let _ = CloseHandle(h);
                        logger::info("stopped legacy Crosshair Z process", json!({"name": name, "pid": entry.th32ProcessID, "ok": done}));
                        stopped += usize::from(done);
                    }
                    Err(err) => logger::warn("legacy Crosshair Z process not stoppable", json!({"name": name, "pid": entry.th32ProcessID, "error": err.to_string()})),
                }
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    stopped
}

/// Remove what Chromium/Electron stored in the data dir. Never touches our own files.
pub fn remove_electron_leftovers(data_dir: &Path) -> Vec<String> {
    let mut removed = Vec::new();
    for name in ELECTRON_LEFTOVERS {
        let p = data_dir.join(name);
        let result = if p.is_dir() {
            std::fs::remove_dir_all(&p)
        } else if p.is_file() {
            std::fs::remove_file(&p)
        } else {
            continue;
        };
        match result {
            Ok(()) => removed.push(name.to_string()),
            Err(err) => logger::warn("electron leftover not removed", json!({"path": p.display().to_string(), "error": err.to_string()})),
        }
    }
    if !removed.is_empty() {
        logger::info("removed Electron leftovers", json!({"removed": removed}));
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cz_exe_matcher_like_js_regex() {
        for yes in ["\"C:\\x\\Crosshair Z.exe\" --hidden", "crosshair-z.exe", "D:\\Crosshair_Z 1.8.7.exe", "CROSSHAIRZ.EXE", "Crosshair Z 2.0.0.exe"] {
            assert!(mentions_cz_exe(yes), "{yes}");
        }
        for no in ["C:\\Crosshair Z\\other.exe", "crosshair x.exe", "crosshair z", "notepad.exe", "Crosshair  Z.exe"] {
            assert!(!mentions_cz_exe(no), "{no}");
        }
    }

    #[test]
    fn stale_entries() {
        let entries = vec![
            ("com.crosshairz.app".to_string(), "\"C:\\a\\Crosshair-Z.exe\" --hidden".to_string()),
            ("Other copy".to_string(), "\"D:\\b\\Crosshair Z.exe\"".to_string()),
            ("Discord".to_string(), "C:\\discord.exe".to_string()),
            ("electron.app.Crosshair Z".to_string(), "C:\\weird\\path.exe".to_string()),
        ];
        assert_eq!(stale_entry_names(&entries, LOGIN_ITEM_NAME), vec!["Other copy", "electron.app.Crosshair Z"]);
    }

    #[test]
    fn login_command_format() {
        assert_eq!(login_command(Path::new("C:\\Games\\Crosshair-Z.exe")), "\"C:\\Games\\Crosshair-Z.exe\" --hidden");
    }

    #[test]
    fn leftovers_removed_but_own_files_kept() {
        let dir = std::env::temp_dir().join(format!("cz-left-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for d in ["Cache", "GPUCache", "logs", "sprites", "webview2"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in ["Preferences", "config.json"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let mut removed = remove_electron_leftovers(&dir);
        removed.sort();
        assert_eq!(removed, vec!["Cache", "GPUCache", "Preferences"]);
        for keep in ["logs", "sprites", "webview2", "config.json"] {
            assert!(dir.join(keep).exists(), "{keep}");
        }
    }

    #[test]
    fn run_key_readable() {
        // read-only check against the real registry
        let key = RunKey::open().expect("HKCU Run key");
        let _ = key.entries();
    }
}
