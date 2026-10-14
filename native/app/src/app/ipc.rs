//! Settings window IPC — the `ipcMain.handle` channels of `src/main/main.js`, same names and
//! payloads. Crosshairs arrive already sanitized by `src/native/bridge.js`.

use std::path::Path;

use serde_json::{json, Map, Value};

use super::App;
use crate::config::{clean_accel, clean_name, new_id, sanitize, Config, Profile, HOTKEY_ACTIONS, MAX_PROFILES};
use crate::input::hotkeys::Status;
use crate::overlay::monitors::{self, Monitor};
use crate::{clipboard, logger};

const PATCH_FLAGS: [&str; 5] = ["enabled", "launchAtLogin", "startHidden", "hideOnLaunch", "checkUpdates"];
const PATCH_OBJECTS: [&str; 3] = ["display", "toggle", "rightClick"];
const CX_MAX_FILE_BYTES: u64 = 1024 * 1024;
const CX_MAX_FILES: usize = 500;
const PRESET_PACK: &str = include_str!("../../../../src/shared/default-pack.json");

pub type IpcResult = Result<Value, String>;

/// Canonical identity of a crosshair design (store.js `fingerprint`; inputs are JS-sanitized).
pub fn fingerprint(crosshair: &Value) -> String {
    serde_json::to_string(crosshair).unwrap_or_default()
}

/// main.js `applyPatch` on the JSON form: shallow-merge display/toggle/rightClick, copy boolean flags.
pub fn apply_patch(config: &Value, patch: &Value) -> Value {
    let mut out = config.clone();
    let (Some(target), Some(p)) = (out.as_object_mut(), patch.as_object()) else { return out };
    for key in PATCH_OBJECTS {
        if let (Some(Value::Object(src)), Some(Value::Object(dst))) = (p.get(key), target.get_mut(key)) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
    }
    for key in PATCH_FLAGS {
        if let Some(Value::Bool(b)) = p.get(key) {
            target.insert(key.to_string(), Value::Bool(*b));
        }
    }
    out
}

/// store.js `dedupeProfiles`: keep the active profile and profiles with a hotkey in preference,
/// otherwise the first occurrence; original order preserved.
pub fn dedupe_profiles(profiles: &[Profile], active_id: &str) -> Vec<Profile> {
    let rank = |p: &Profile| (if p.id == active_id { 2 } else { 0 }) + u8::from(!p.hotkey.is_empty());
    let mut order: Vec<&Profile> = profiles.iter().collect();
    order.sort_by_key(|p| std::cmp::Reverse(rank(p))); // stable, like Array#sort
    let mut seen = std::collections::HashSet::new();
    let mut keep = std::collections::HashSet::new();
    for p in order {
        if seen.insert(fingerprint(&p.crosshair)) {
            keep.insert(p.id.clone());
        }
    }
    profiles.iter().filter(|p| keep.contains(&p.id)).cloned().collect()
}

pub fn display_label(index: usize, m: &Monitor) -> String {
    format!(
        "Display {}{} — {}×{} @ {}%",
        index + 1,
        if m.primary { " (primary)" } else { "" },
        m.rect.width(),
        m.rect.height(),
        m.scale_percent
    )
}

fn require_str<'a>(v: Option<&'a Value>, name: &str) -> Result<&'a str, String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s),
        _ => Err(format!("{name} must be non-empty string")),
    }
}

/// Crosshair X saved + workshop crosshair files (crosshairx-scan.js); JS converts the texts.
pub fn scan_crosshair_x(data_dir: &Path) -> Value {
    let mut sources: Vec<(&str, std::path::PathBuf)> = vec![("Saved", data_dir.join("crosshair-store"))];
    if let Ok(mods) = std::fs::read_dir(data_dir.join("mods")) {
        let mut dirs: Vec<_> = mods.filter_map(Result::ok).filter(|e| e.path().is_dir()).map(|e| e.path().join("crosshairs")).collect();
        dirs.sort();
        sources.extend(dirs.into_iter().map(|d| ("Workshop", d)));
    }
    let mut files = Vec::new();
    for (label, dir) in sources {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut paths: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json") && p.file_name().is_some_and(|n| n != "manifest.json"))
            .collect();
        paths.sort();
        for path in paths {
            if files.len() >= CX_MAX_FILES {
                break;
            }
            let id = path.strip_prefix(data_dir).unwrap_or(&path).display().to_string();
            let entry = match std::fs::metadata(&path) {
                Ok(m) if m.len() > CX_MAX_FILE_BYTES => json!({"id": id, "source": label, "error": "file too large"}),
                Ok(_) => match std::fs::read_to_string(&path) {
                    Ok(text) => json!({"id": id, "source": label, "text": text}),
                    Err(e) => json!({"id": id, "source": label, "error": e.to_string()}),
                },
                Err(e) => json!({"id": id, "source": label, "error": e.to_string()}),
            };
            files.push(entry);
        }
    }
    json!({"dataDir": data_dir.display().to_string(), "exists": data_dir.exists(), "files": files})
}

impl App {
    fn config_value(&self) -> Value {
        self.store.get().to_value()
    }

    pub(super) fn runtime_value(&self) -> Value {
        json!({
            "kbAlt": self.rt.kb_alt,
            "launchHidden": self.rt.launch_hidden,
            "mouseAvailable": true,
            "update": self.update_value(),
        })
    }

    fn update_value(&self) -> Value {
        json!({"status": "idle", "version": null, "error": null, "current": env!("CARGO_PKG_VERSION")})
    }

    /// Apply a JSON-level edit, re-sanitize, save, react.
    fn set_from_value(&mut self, v: &Value) {
        let next: Config = sanitize(v, self.store.defaults());
        self.store.set(next);
    }

    pub(super) fn ipc(&mut self, channel: &str, p: Value) -> IpcResult {
        match channel {
            "config:get" => Ok(json!({
                "config": self.config_value(),
                "hotkeyStatus": self.hotkey_status,
                "presetPack": serde_json::from_str::<Value>(PRESET_PACK).unwrap_or(Value::Array(vec![])),
                "runtime": self.runtime_value(),
                "defaults": crate::config::Hotkeys::defaults(),
            })),
            "config:patch" => self.config_patch(&p),
            "profile:update" => self.profile_update(&p),
            "profile:create" => self.profile_create(&p),
            "profile:delete" => self.profile_delete(&p),
            "profile:importMany" => self.profile_import_many(&p),
            "profile:dedupe" => self.profile_dedupe(),
            "profile:activate" => {
                let id = require_str(Some(&p), "id")?.to_string();
                self.equip(&id);
                Ok(self.config_value())
            }
            "profile:move" => self.profile_move(&p),
            "cx:scan" => {
                let dir = std::env::var_os("APPDATA").map(std::path::PathBuf::from).unwrap_or_default().join("CrosshairX");
                let res = scan_crosshair_x(&dir);
                logger::info("crosshairx scan", json!({"dataDir": dir.display().to_string(), "files": res["files"].as_array().map_or(0, Vec::len)}));
                Ok(res)
            }
            "displays:list" => {
                self.monitors = monitors::list();
                Ok(Value::Array(self.monitors.iter().enumerate().map(|(i, m)| json!({"id": m.id, "label": display_label(i, m)})).collect()))
            }
            "hotkeys:set" => {
                let obj = p.as_object().ok_or("hotkeys must be object")?;
                let mut next = self.store.get().clone();
                for action in HOTKEY_ACTIONS {
                    if let Some(Value::String(s)) = obj.get(action) {
                        next.hotkeys.set(action, s.clone());
                    }
                }
                self.store.set(next);
                self.register_hotkeys();
                self.changed();
                Ok(json!(self.hotkey_status))
            }
            "hotkeys:suspend" => {
                self.hotkeys_suspended = p == Value::Bool(true);
                self.register_hotkeys();
                Ok(Value::Bool(self.hotkeys_suspended))
            }
            "clipboard:write" => {
                let text = match &p {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                clipboard::write_text(&text).map(|()| Value::Null)
            }
            "clipboard:read" => clipboard::read_text().map(Value::String),
            "log:path" => Ok(json!(logger::log_file().map(|p| p.display().to_string()))),
            "update:check" | "update:install" => self.update_command(channel),
            "window:close" => {
                self.close_settings_now();
                Ok(Value::Null)
            }
            other => Err(format!("blocked channel {other}")),
        }
    }

    fn config_patch(&mut self, p: &Value) -> IpcResult {
        if !p.is_object() {
            return Err("patch must be object".into());
        }
        // switching on in the app must win over launch-hidden / hotkey-hidden state
        if p.get("enabled") == Some(&Value::Bool(true)) {
            self.rt.launch_hidden = false;
            if self.store.get().toggle.mode == crate::config::ToggleMode::Hide {
                self.rt.kb_alt = false;
            }
        }
        let next = apply_patch(&self.config_value(), p);
        self.set_from_value(&next);
        if p.get("toggle").is_some() || p.get("rightClick").is_some() {
            self.rt.kb_alt = false;
            self.rt.rc_alt = false;
        }
        if p.get("launchAtLogin").is_some_and(Value::is_boolean) {
            self.apply_login_item();
        }
        if p.get("checkUpdates") == Some(&Value::Bool(true)) {
            self.on_check_updates_enabled();
        }
        self.changed();
        Ok(self.config_value())
    }

    fn profile_update(&mut self, p: &Value) -> IpcResult {
        let id = require_str(p.get("id"), "id")?.to_string();
        let mut next = self.store.get().clone();
        let prof = next.profiles.iter_mut().find(|x| x.id == id).ok_or_else(|| format!("profile {id} not found"))?;
        if let Some(ch) = p.get("crosshair").filter(|c| !c.is_null()) {
            prof.crosshair = ch.clone();
        }
        if p.get("name").is_some() {
            prof.name = clean_name(p.get("name"), &prof.name);
        }
        let hotkey_changed = p.get("hotkey").is_some();
        if hotkey_changed {
            prof.hotkey = clean_accel(p.get("hotkey"));
        }
        self.store.set(next);
        if hotkey_changed {
            self.register_hotkeys();
        }
        self.changed();
        Ok(self.config_value())
    }

    fn profile_create(&mut self, p: &Value) -> IpcResult {
        let activate = p.get("activate") != Some(&Value::Bool(false));
        let crosshair = p.get("crosshair").cloned().unwrap_or(Value::Null);
        // dedupe: an identical crosshair already saved → reuse it instead of adding a copy
        if p.get("dedupe").is_some_and(|d| d.as_bool() == Some(true)) {
            let fp = fingerprint(&crosshair);
            if let Some(existing) = self.store.get().profiles.iter().find(|x| fingerprint(&x.crosshair) == fp).map(|x| x.id.clone()) {
                if activate {
                    self.equip(&existing);
                }
                return Ok(json!({"id": existing, "config": self.config_value(), "existed": true}));
            }
        }
        if self.store.get().profiles.len() >= MAX_PROFILES {
            return Err(format!("max {MAX_PROFILES} crosshairs"));
        }
        let id = new_id();
        let mut next = self.store.get().clone();
        next.profiles.push(Profile { id: id.clone(), name: clean_name(p.get("name"), "New Crosshair"), hotkey: String::new(), crosshair });
        if activate {
            next.active_profile_id = id.clone();
            next.enabled = true;
            self.rt.kb_alt = false;
        }
        self.store.set(next);
        self.changed();
        Ok(json!({"id": id, "config": self.config_value()}))
    }

    fn profile_delete(&mut self, p: &Value) -> IpcResult {
        let id = require_str(Some(p), "id")?.to_string();
        if self.store.get().profiles.len() <= 1 {
            return Err("cannot delete last crosshair".into());
        }
        let mut next = self.store.get().clone();
        next.profiles.retain(|x| x.id != id);
        if next.active_profile_id == id {
            next.active_profile_id = next.profiles[0].id.clone();
        }
        self.store.set(next);
        self.register_hotkeys();
        self.changed();
        Ok(self.config_value())
    }

    fn profile_import_many(&mut self, p: &Value) -> IpcResult {
        let list = p.as_array().filter(|l| !l.is_empty()).ok_or("nothing to import")?;
        // Skip crosshairs already saved (and duplicates within the list itself).
        let mut seen: std::collections::HashSet<String> = self.store.get().profiles.iter().map(|x| fingerprint(&x.crosshair)).collect();
        let fresh: Vec<&Value> = list.iter().filter(|it| seen.insert(fingerprint(it.get("crosshair").unwrap_or(&Value::Null)))).collect();
        let duplicates = list.len() - fresh.len();
        let free = MAX_PROFILES.saturating_sub(self.store.get().profiles.len());
        let items: Vec<&Value> = fresh.iter().take(free).copied().collect();
        let over_limit = fresh.len() - items.len();
        if items.is_empty() {
            return Ok(json!({"config": self.config_value(), "imported": 0, "duplicates": duplicates, "overLimit": over_limit}));
        }
        let mut next = self.store.get().clone();
        let mut last = String::new();
        for it in &items {
            last = new_id();
            next.profiles.push(Profile {
                id: last.clone(),
                name: clean_name(it.get("name"), "Imported"),
                hotkey: String::new(),
                crosshair: it.get("crosshair").cloned().unwrap_or(Value::Null),
            });
        }
        next.active_profile_id = last;
        next.enabled = true;
        self.store.set(next);
        logger::info("imported crosshairs", json!({"count": items.len(), "duplicates": duplicates, "overLimit": over_limit}));
        self.changed();
        Ok(json!({"config": self.config_value(), "imported": items.len(), "duplicates": duplicates, "overLimit": over_limit}))
    }

    fn profile_dedupe(&mut self) -> IpcResult {
        let c = self.store.get();
        let kept = dedupe_profiles(&c.profiles, &c.active_profile_id);
        let removed = c.profiles.len() - kept.len();
        if removed == 0 {
            return Ok(json!({"config": self.config_value(), "removed": 0}));
        }
        let mut next = c.clone();
        next.profiles = kept;
        self.store.set(next);
        self.register_hotkeys();
        logger::info("removed duplicate crosshairs", json!({"removed": removed}));
        self.changed();
        Ok(json!({"config": self.config_value(), "removed": removed}))
    }

    fn profile_move(&mut self, p: &Value) -> IpcResult {
        let id = require_str(p.get("id"), "id")?.to_string();
        let dir = p.get("dir").and_then(Value::as_f64).unwrap_or(0.0);
        let mut next = self.store.get().clone();
        if let Some(i) = next.profiles.iter().position(|x| x.id == id) {
            let j = if dir > 0.0 { i as i64 + 1 } else { i as i64 - 1 };
            if j >= 0 && (j as usize) < next.profiles.len() {
                next.profiles.swap(i, j as usize);
                self.store.set(next);
                self.changed();
            }
        }
        Ok(self.config_value())
    }

    pub(super) fn hotkey_status_value(&self) -> Value {
        let map: Map<String, Value> = self.hotkey_status.iter().map(|(k, s): (&String, &Status)| (k.clone(), json!(s))).collect();
        Value::Object(map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay::monitors::Rect;

    fn prof(id: &str, hotkey: &str, ch: Value) -> Profile {
        Profile { id: id.into(), name: id.into(), hotkey: hotkey.into(), crosshair: ch }
    }

    #[test]
    fn patch_merges_objects_and_flags_only() {
        let cfg = json!({"display": {"offsetX": 1, "scale": 1}, "toggle": {"mode": "hide"}, "enabled": true, "version": 5});
        let out = apply_patch(&cfg, &json!({"display": {"offsetX": 9}, "toggle": {"mode": "switch"}, "enabled": false, "startHidden": "yes", "version": 99}));
        assert_eq!(out["display"], json!({"offsetX": 9, "scale": 1}));
        assert_eq!(out["toggle"]["mode"], "switch");
        assert_eq!(out["enabled"], false);
        assert!(out.get("startHidden").is_none(), "non-boolean flag ignored");
        assert_eq!(out["version"], 5, "not patchable");
    }

    #[test]
    fn dedupe_prefers_active_then_hotkey_keeps_order() {
        let a = json!({"layers": [1]});
        let b = json!({"layers": [2]});
        let list = vec![prof("1", "", a.clone()), prof("2", "F1", a.clone()), prof("3", "", b.clone()), prof("4", "", a.clone()), prof("5", "", b.clone())];
        let ids: Vec<String> = dedupe_profiles(&list, "4").into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["3", "4"], "active wins for a, first wins for b");
        let ids: Vec<String> = dedupe_profiles(&list, "x").into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["2", "3"], "hotkey wins when no active duplicate");
    }

    #[test]
    fn label_format() {
        let m = Monitor { id: 1, name: "d".into(), rect: Rect { left: 0, top: 0, right: 2560, bottom: 1440 }, primary: true, scale_percent: 125 };
        assert_eq!(display_label(0, &m), "Display 1 (primary) — 2560×1440 @ 125%");
    }

    #[test]
    fn crosshair_x_scan_lists_files() {
        let dir = std::env::temp_dir().join(format!("cz-cx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("crosshair-store")).unwrap();
        std::fs::create_dir_all(dir.join("mods").join("m1").join("crosshairs")).unwrap();
        std::fs::write(dir.join("crosshair-store").join("a.json"), "{\"model\":[]}").unwrap();
        std::fs::write(dir.join("crosshair-store").join("manifest.json"), "{}").unwrap();
        std::fs::write(dir.join("crosshair-store").join("big.json"), vec![b' '; (CX_MAX_FILE_BYTES + 1) as usize]).unwrap();
        std::fs::write(dir.join("mods").join("m1").join("crosshairs").join("w.json"), "{}").unwrap();
        let res = scan_crosshair_x(&dir);
        assert_eq!(res["exists"], true);
        let files = res["files"].as_array().unwrap();
        let ids: Vec<&str> = files.iter().map(|f| f["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["crosshair-store\\a.json", "crosshair-store\\big.json", "mods\\m1\\crosshairs\\w.json"]);
        assert_eq!(files[0]["text"], "{\"model\":[]}");
        assert_eq!(files[1]["error"], "file too large");
        assert_eq!(files[2]["source"], "Workshop");
        assert_eq!(scan_crosshair_x(&dir.join("missing"))["exists"], false);
    }

    #[test]
    fn preset_pack_embedded() {
        let v: Value = serde_json::from_str(PRESET_PACK).unwrap();
        assert!(v.as_array().unwrap().len() > 10);
    }
}
