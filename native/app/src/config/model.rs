//! Config schema v5 and its repair rules — a port of `sanitizeConfig` in `src/main/store.js`.
//! Crosshair objects stay opaque JSON (sanitized by `crosshair-core.js` before they reach Rust);
//! only their outer shape is checked here.

use serde::Serialize;
use serde_json::{Map, Value};

pub const CONFIG_VERSION: u32 = 5;
pub const MAX_PROFILES: usize = 200;
pub const MAX_NAME_LEN: usize = 40;
pub const MAX_OFFSET_PX: f64 = 4000.0;
pub const MAX_ACCEL_LEN: usize = 64;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_LAYERS: usize = 64;
const MIN_SCALE: f64 = 0.25;
const MAX_SCALE: f64 = 4.0;

/// Hotkey actions in config order (`DEFAULT_HOTKEYS` keys).
pub const HOTKEY_ACTIONS: [&str; 8] = ["toggle", "next", "prev", "settings", "moveUp", "moveDown", "moveLeft", "moveRight"];
pub const DEFAULT_TOGGLE_HOTKEY: &str = "Alt+Shift+X";
/// Toggle default before config v4.
const LEGACY_TOGGLE_DEFAULT: &str = "CommandOrControl+Shift+X";
/// Toggle default in config v4.
const V4_TOGGLE_DEFAULT: &str = "Alt+Shift+Z";
/// v1/v2 defaults of optional actions, cleared on migration to v3 unless changed by the user.
const LEGACY_DEFAULT_HOTKEYS: [(&str, &str); 7] = [
    ("next", "CommandOrControl+Shift+Right"),
    ("prev", "CommandOrControl+Shift+Left"),
    ("settings", "CommandOrControl+Shift+S"),
    ("moveUp", "Alt+Shift+Up"),
    ("moveDown", "Alt+Shift+Down"),
    ("moveLeft", "Alt+Shift+Left"),
    ("moveRight", "Alt+Shift+Right"),
];
const KNOWN_KEYS: [&str; 12] = [
    "version",
    "enabled",
    "activeProfileId",
    "profiles",
    "display",
    "hotkeys",
    "toggle",
    "rightClick",
    "launchAtLogin",
    "startHidden",
    "hideOnLaunch",
    "checkUpdates",
];

/// Values computed by JS and shipped as resources (`scripts/export-native-defaults.js`).
#[derive(Clone, Debug)]
pub struct Defaults {
    pub default_crosshair: Value,
    pub first_preset_name: String,
    pub first_preset_crosshair: Value,
}

impl Defaults {
    /// Defaults embedded at build time.
    pub fn embedded() -> Defaults {
        let default_crosshair: Value =
            serde_json::from_str(include_str!("../../resources/default-crosshair.json")).expect("embedded default-crosshair.json is valid JSON");
        let first: Value = serde_json::from_str(include_str!("../../resources/first-preset.json")).expect("embedded first-preset.json is valid JSON");
        Defaults {
            default_crosshair,
            first_preset_name: first["name"].as_str().unwrap_or("Crosshair").to_string(),
            first_preset_crosshair: first["crosshair"].clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub hotkey: String,
    pub crosshair: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub monitor_id: Option<i64>,
    pub offset_x: i32,
    pub offset_y: i32,
    pub scale: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub toggle: String,
    pub next: String,
    pub prev: String,
    pub settings: String,
    pub move_up: String,
    pub move_down: String,
    pub move_left: String,
    pub move_right: String,
}

impl Hotkeys {
    pub fn defaults() -> Hotkeys {
        Hotkeys {
            toggle: DEFAULT_TOGGLE_HOTKEY.to_string(),
            next: String::new(),
            prev: String::new(),
            settings: String::new(),
            move_up: String::new(),
            move_down: String::new(),
            move_left: String::new(),
            move_right: String::new(),
        }
    }

    /// Accelerator of an action name from `HOTKEY_ACTIONS`.
    pub fn get(&self, action: &str) -> Option<&str> {
        Some(match action {
            "toggle" => &self.toggle,
            "next" => &self.next,
            "prev" => &self.prev,
            "settings" => &self.settings,
            "moveUp" => &self.move_up,
            "moveDown" => &self.move_down,
            "moveLeft" => &self.move_left,
            "moveRight" => &self.move_right,
            _ => return None,
        })
    }

    pub fn set(&mut self, action: &str, accel: String) -> bool {
        let slot = match action {
            "toggle" => &mut self.toggle,
            "next" => &mut self.next,
            "prev" => &mut self.prev,
            "settings" => &mut self.settings,
            "moveUp" => &mut self.move_up,
            "moveDown" => &mut self.move_down,
            "moveLeft" => &mut self.move_left,
            "moveRight" => &mut self.move_right,
            _ => return false,
        };
        *slot = accel;
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToggleMode {
    Hide,
    Switch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RcMode {
    Off,
    HideHold,
    HideToggle,
    SwitchHold,
    SwitchToggle,
}

impl RcMode {
    pub fn is_hold(self) -> bool {
        matches!(self, RcMode::HideHold | RcMode::SwitchHold)
    }

    pub fn is_hide(self) -> bool {
        matches!(self, RcMode::HideHold | RcMode::HideToggle)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toggle {
    pub mode: ToggleMode,
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RightClick {
    pub mode: RcMode,
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub enabled: bool,
    pub active_profile_id: String,
    pub profiles: Vec<Profile>,
    pub display: Display,
    pub hotkeys: Hotkeys,
    pub toggle: Toggle,
    pub right_click: RightClick,
    pub launch_at_login: bool,
    pub start_hidden: bool,
    pub hide_on_launch: bool,
    pub check_updates: bool,
    /// Top-level keys this version does not know; written back unchanged.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Config {
    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// Active profile; falls back to the first (sanitize guarantees at least one).
    pub fn active_profile(&self) -> &Profile {
        self.profile(&self.active_profile_id).unwrap_or(&self.profiles[0])
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Fresh config for a first start.
pub fn default_config(d: &Defaults) -> Config {
    let id = new_id();
    Config {
        version: CONFIG_VERSION,
        enabled: true,
        active_profile_id: id.clone(),
        profiles: vec![Profile { id, name: d.first_preset_name.clone(), hotkey: String::new(), crosshair: d.first_preset_crosshair.clone() }],
        display: Display { monitor_id: None, offset_x: 0, offset_y: 0, scale: 1.0 },
        hotkeys: Hotkeys::defaults(),
        toggle: Toggle { mode: ToggleMode::Hide, profile_id: None },
        right_click: RightClick { mode: RcMode::Off, profile_id: None },
        launch_at_login: false,
        start_hidden: false,
        hide_on_launch: false,
        check_updates: true,
        extra: Map::new(),
    }
}

/// JS `Number(v)` for the value kinds a config can contain; `None` = NaN.
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// `clampNum` from store.js: null / "" / non-finite → fallback.
fn clamp_num(v: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    match v {
        None | Some(Value::Null) => fallback,
        Some(Value::String(s)) if s.is_empty() => fallback,
        Some(v) => match js_number(v) {
            Some(n) if n.is_finite() => n.clamp(min, max),
            _ => fallback,
        },
    }
}

/// JS `Math.round` (halves round toward +∞).
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn clamp_int(v: Option<&Value>, min: f64, max: f64, fallback: f64) -> i32 {
    js_round(clamp_num(v, min, max, fallback)) as i32
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `cleanName`: control whitespace → space, trimmed, ≤ 40 chars, fallback when empty.
pub fn clean_name(v: Option<&Value>, fallback: &str) -> String {
    let s = match v {
        Some(Value::String(s)) => s.replace(['\r', '\n', '\t'], " ").trim().chars().take(MAX_NAME_LEN).collect::<String>(),
        _ => String::new(),
    };
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}

/// `cleanAccel`: strings up to 64 chars, anything else → "".
pub fn clean_accel(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) if utf16_len(s) <= MAX_ACCEL_LEN => s.clone(),
        _ => String::new(),
    }
}

/// Outer-shape check for an opaque crosshair; invalid → the JS default crosshair.
pub fn clean_crosshair(v: Option<&Value>, d: &Defaults) -> Value {
    match v {
        Some(Value::Object(o)) if o.get("layers").and_then(Value::as_array).is_some_and(|l| l.len() <= MAX_LAYERS) => Value::Object(o.clone()),
        _ => d.default_crosshair.clone(),
    }
}

fn obj(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    }
}

fn integer(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64)),
        _ => None,
    }
}

fn sanitize_profiles(src: &Map<String, Value>, d: &Defaults) -> Vec<Profile> {
    let mut seen = std::collections::HashSet::new();
    let list = src.get("profiles").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out: Vec<Profile> = list
        .iter()
        .take(MAX_PROFILES)
        .filter_map(Value::as_object)
        .enumerate()
        .map(|(i, p)| {
            let mut id = match p.get("id") {
                Some(Value::String(s)) if utf16_len(s) <= MAX_ID_LEN => s.clone(),
                _ => new_id(),
            };
            if seen.contains(&id) {
                id = new_id();
            }
            seen.insert(id.clone());
            Profile {
                id,
                name: clean_name(p.get("name"), &format!("Crosshair {}", i + 1)),
                hotkey: clean_accel(p.get("hotkey")),
                crosshair: clean_crosshair(p.get("crosshair"), d),
            }
        })
        .collect();
    if out.is_empty() {
        out = default_config(d).profiles;
    }
    out
}

fn sanitize_hotkeys(src: &Map<String, Value>, version: f64) -> Hotkeys {
    let hk = obj(src.get("hotkeys"));
    let defaults = Hotkeys::defaults();
    let mut out = Hotkeys::defaults();
    for action in HOTKEY_ACTIONS {
        let default = defaults.get(action).unwrap_or("");
        let mut v = match hk.get(action) {
            Some(Value::String(s)) if utf16_len(s) <= MAX_ACCEL_LEN => s.clone(),
            _ => default.to_string(),
        };
        if version < 3.0 && LEGACY_DEFAULT_HOTKEYS.iter().any(|(k, legacy)| *k == action && v == *legacy) {
            v.clear();
        }
        // Toggle default moved Ctrl+Shift+X (<v4) → Alt+Shift+Z (v4) → Alt+Shift+X (v5).
        // Only untouched defaults migrate; a key the user picked stays.
        if action == "toggle" && ((version < 4.0 && v == LEGACY_TOGGLE_DEFAULT) || (version == 4.0 && v == V4_TOGGLE_DEFAULT)) {
            v = DEFAULT_TOGGLE_HOTKEY.to_string();
        }
        out.set(action, v);
    }
    out
}

/// Validate a full config. Never fails; repairs instead (store.js `sanitizeConfig`).
pub fn sanitize(raw: &Value, d: &Defaults) -> Config {
    let src = obj(Some(raw));
    let profiles = sanitize_profiles(&src, d);
    let version = src.get("version").and_then(js_number).filter(|n| !n.is_nan()).unwrap_or(0.0);
    let hotkeys = sanitize_hotkeys(&src, version);

    let ids: std::collections::HashSet<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    let ref_id = |v: Option<&Value>| match v {
        Some(Value::String(s)) if ids.contains(s.as_str()) => Some(s.clone()),
        _ => None,
    };
    let disp = obj(src.get("display"));
    let tg = obj(src.get("toggle"));
    let rc = obj(src.get("rightClick"));
    let toggle_mode = match tg.get("mode").and_then(Value::as_str) {
        Some("switch") => ToggleMode::Switch,
        _ => ToggleMode::Hide,
    };
    let rc_mode = match rc.get("mode").and_then(Value::as_str) {
        Some("hideHold") => RcMode::HideHold,
        Some("hideToggle") => RcMode::HideToggle,
        Some("switchHold") => RcMode::SwitchHold,
        Some("switchToggle") => RcMode::SwitchToggle,
        _ => RcMode::Off,
    };
    let active_profile_id = match src.get("activeProfileId") {
        Some(Value::String(s)) if ids.contains(s.as_str()) => s.clone(),
        _ => profiles[0].id.clone(),
    };
    let toggle = Toggle { mode: toggle_mode, profile_id: ref_id(tg.get("profileId")) };
    let right_click = RightClick { mode: rc_mode, profile_id: ref_id(rc.get("profileId")) };
    let flag = |k: &str| src.get(k) == Some(&Value::Bool(true));
    let extra = src.iter().filter(|(k, _)| !KNOWN_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();

    Config {
        version: CONFIG_VERSION,
        enabled: src.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        active_profile_id,
        display: Display {
            monitor_id: integer(disp.get("monitorId")),
            offset_x: clamp_int(disp.get("offsetX"), -MAX_OFFSET_PX, MAX_OFFSET_PX, 0.0),
            offset_y: clamp_int(disp.get("offsetY"), -MAX_OFFSET_PX, MAX_OFFSET_PX, 0.0),
            scale: js_round(clamp_num(disp.get("scale"), MIN_SCALE, MAX_SCALE, 1.0) * 100.0) / 100.0,
        },
        hotkeys,
        toggle,
        right_click,
        launch_at_login: flag("launchAtLogin"),
        start_hidden: flag("startHidden"),
        hide_on_launch: flag("hideOnLaunch"),
        // optional update check: on unless the user turned it off
        check_updates: src.get("checkUpdates") != Some(&Value::Bool(false)),
        extra,
        profiles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d() -> Defaults {
        Defaults {
            default_crosshair: json!({"version": 3, "layers": [{"name": "default"}]}),
            first_preset_name: "First".into(),
            first_preset_crosshair: json!({"version": 3, "layers": [{"name": "first"}]}),
        }
    }

    fn ch(name: &str) -> Value {
        json!({"version": 3, "layers": [{"name": name}]})
    }

    fn prof(id: &str) -> Value {
        json!({"id": id, "name": id, "hotkey": "", "crosshair": ch(id)})
    }

    #[test]
    fn non_object_gives_defaults() {
        for raw in [Value::Null, json!(5), json!("x"), json!([])] {
            let c = sanitize(&raw, &d());
            assert_eq!(c.profiles.len(), 1);
            assert_eq!(c.profiles[0].name, "First");
            assert_eq!(c.profiles[0].crosshair, ch("first"));
            assert_eq!(c.active_profile_id, c.profiles[0].id);
            assert!(c.enabled && c.check_updates && !c.launch_at_login);
            assert_eq!(c.hotkeys.toggle, "Alt+Shift+X");
            assert_eq!(c.display, Display { monitor_id: None, offset_x: 0, offset_y: 0, scale: 1.0 });
        }
    }

    #[test]
    fn profile_cap_and_non_objects() {
        let mut list: Vec<Value> = (0..250).map(|i| prof(&format!("p{i}"))).collect();
        list.insert(0, json!("junk"));
        let c = sanitize(&json!({"profiles": list}), &d());
        // slice(0, 200) happens before dropping non-objects → 199 kept
        assert_eq!(c.profiles.len(), 199);
        assert_eq!(c.profiles[0].id, "p0");
    }

    #[test]
    fn ids_duplicate_or_oversize_replaced() {
        let long = "x".repeat(65);
        let c = sanitize(&json!({"profiles": [prof("a"), prof("a"), {"id": long, "crosshair": ch("l")}, {"id": 7}]}), &d());
        assert_eq!(c.profiles[0].id, "a");
        assert_ne!(c.profiles[1].id, "a");
        assert_eq!(c.profiles[2].id.len(), 36);
        assert_eq!(c.profiles[3].id.len(), 36);
    }

    #[test]
    fn names_cleaned() {
        let c = sanitize(
            &json!({"profiles": [
                {"id": "a", "name": "  a\tb\nc  "},
                {"id": "b", "name": "y".repeat(50)},
                {"id": "c", "name": "   "},
                {"id": "d"}
            ]}),
            &d(),
        );
        assert_eq!(c.profiles[0].name, "a b c");
        assert_eq!(c.profiles[1].name.chars().count(), 40);
        assert_eq!(c.profiles[2].name, "Crosshair 3");
        assert_eq!(c.profiles[3].name, "Crosshair 4");
    }

    #[test]
    fn crosshair_shape_checked() {
        let too_many: Vec<Value> = (0..65).map(|_| json!({})).collect();
        let c = sanitize(
            &json!({"profiles": [
                {"id": "a", "crosshair": ch("ok")},
                {"id": "b", "crosshair": "nope"},
                {"id": "c", "crosshair": {"layers": too_many}},
                {"id": "d", "crosshair": {"version": 3}}
            ]}),
            &d(),
        );
        assert_eq!(c.profiles[0].crosshair, ch("ok"));
        for p in &c.profiles[1..] {
            assert_eq!(p.crosshair, ch("default"), "{}", p.id);
        }
    }

    #[test]
    fn hotkey_values() {
        let c = sanitize(&json!({"version": 5, "profiles": [{"id": "a", "hotkey": "F5"}, {"id": "b", "hotkey": "x".repeat(65)}, {"id": "c", "hotkey": 3}]}), &d());
        assert_eq!(c.profiles[0].hotkey, "F5");
        assert_eq!(c.profiles[1].hotkey, "");
        assert_eq!(c.profiles[2].hotkey, "");
    }

    #[test]
    fn display_clamps_like_js() {
        let c = sanitize(&json!({"display": {"monitorId": 2779098405u64, "offsetX": "12", "offsetY": -9000, "scale": 9}}), &d());
        assert_eq!(c.display, Display { monitor_id: Some(2779098405), offset_x: 12, offset_y: -4000, scale: 4.0 });

        let c = sanitize(&json!({"display": {"monitorId": 1.5, "offsetX": 2.5, "offsetY": -2.5, "scale": 0.333}}), &d());
        assert_eq!(c.display, Display { monitor_id: None, offset_x: 3, offset_y: -2, scale: 0.33 });

        let c = sanitize(&json!({"display": {"monitorId": "1", "offsetX": "", "offsetY": null, "scale": "abc"}}), &d());
        assert_eq!(c.display, Display { monitor_id: None, offset_x: 0, offset_y: 0, scale: 1.0 });

        let c = sanitize(&json!({"display": {"offsetX": true, "scale": 0.1}}), &d());
        assert_eq!((c.display.offset_x, c.display.scale), (1, 0.25));
    }

    #[test]
    fn hotkey_migrations() {
        let legacy = json!({"version": 2, "hotkeys": {"toggle": "CommandOrControl+Shift+X", "next": "CommandOrControl+Shift+Right", "prev": "F7"}});
        let c = sanitize(&legacy, &d());
        assert_eq!((c.hotkeys.toggle.as_str(), c.hotkeys.next.as_str(), c.hotkeys.prev.as_str()), ("Alt+Shift+X", "", "F7"));

        let v3 = sanitize(&json!({"version": 3, "hotkeys": {"toggle": "CommandOrControl+Shift+X", "next": "CommandOrControl+Shift+Right"}}), &d());
        assert_eq!((v3.hotkeys.toggle.as_str(), v3.hotkeys.next.as_str()), ("Alt+Shift+X", "CommandOrControl+Shift+Right"));

        let v4 = sanitize(&json!({"version": 4, "hotkeys": {"toggle": "Alt+Shift+Z"}}), &d());
        assert_eq!(v4.hotkeys.toggle, "Alt+Shift+X");

        let v5 = sanitize(&json!({"version": 5, "hotkeys": {"toggle": "Alt+Shift+Z", "moveUp": 5}}), &d());
        assert_eq!((v5.hotkeys.toggle.as_str(), v5.hotkeys.move_up.as_str()), ("Alt+Shift+Z", ""));

        let picked = sanitize(&json!({"version": 3, "hotkeys": {"toggle": "F8"}}), &d());
        assert_eq!(picked.hotkeys.toggle, "F8");
        assert_eq!(picked.version, 5);
    }

    #[test]
    fn modes_and_refs() {
        let c = sanitize(
            &json!({"profiles": [prof("a"), prof("b")], "activeProfileId": "b",
                    "toggle": {"mode": "switch", "profileId": "a"},
                    "rightClick": {"mode": "switchToggle", "profileId": "zzz"}}),
            &d(),
        );
        assert_eq!(c.active_profile_id, "b");
        assert_eq!(c.toggle, Toggle { mode: ToggleMode::Switch, profile_id: Some("a".into()) });
        assert_eq!(c.right_click, RightClick { mode: RcMode::SwitchToggle, profile_id: None });

        let bad = sanitize(&json!({"profiles": [prof("a")], "activeProfileId": "x", "toggle": {"mode": "boom"}, "rightClick": {"mode": 1}}), &d());
        assert_eq!(bad.active_profile_id, "a");
        assert_eq!(bad.toggle.mode, ToggleMode::Hide);
        assert_eq!(bad.right_click.mode, RcMode::Off);
    }

    #[test]
    fn flags_strict() {
        let c = sanitize(&json!({"enabled": "yes", "launchAtLogin": "true", "startHidden": true, "hideOnLaunch": 1, "checkUpdates": 0}), &d());
        assert!(c.enabled && !c.launch_at_login && c.start_hidden && !c.hide_on_launch && c.check_updates);
        let off = sanitize(&json!({"enabled": false, "checkUpdates": false}), &d());
        assert!(!off.enabled && !off.check_updates);
    }

    #[test]
    fn unknown_keys_preserved_and_json_shape() {
        let c = sanitize(&json!({"profiles": [prof("a")], "futureThing": {"x": 1}}), &d());
        let v = c.to_value();
        assert_eq!(v["futureThing"], json!({"x": 1}));
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "version", "enabled", "activeProfileId", "profiles", "display", "hotkeys", "toggle", "rightClick",
                "launchAtLogin", "startHidden", "hideOnLaunch", "checkUpdates", "futureThing"
            ]
        );
        assert_eq!(v["hotkeys"]["moveUp"], "");
        assert_eq!(v["rightClick"]["mode"], "off");
        assert_eq!(v["display"]["monitorId"], Value::Null);
        // round trip is stable
        assert_eq!(sanitize(&v, &d()), c);
    }

    #[test]
    fn embedded_defaults_load() {
        let e = Defaults::embedded();
        assert!(e.default_crosshair["layers"].is_array());
        assert!(!e.first_preset_name.is_empty());
        assert!(e.first_preset_crosshair["layers"].is_array());
    }

    #[test]
    fn rc_mode_helpers() {
        assert!(RcMode::HideHold.is_hold() && RcMode::HideHold.is_hide());
        assert!(!RcMode::SwitchToggle.is_hold() && !RcMode::SwitchToggle.is_hide());
    }
}
