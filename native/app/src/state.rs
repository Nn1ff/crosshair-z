//! Runtime visibility / profile rules, ported from `src/main/main.js` (`effective`, `equip`,
//! `keyboardToggle`, `cycleProfile`, `moveCrosshair`, `onMouse`, `needsMouse`). Pure functions on
//! `Config` + `Runtime`; persistence is the caller's job.

use serde_json::Value;

use crate::config::{Config, Profile, RcMode, ToggleMode};

pub const MOVE_STEP_PX: i32 = 1;

/// State that lives only while the app runs (never saved).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Runtime {
    /// keyboard toggle active (hide or switch)
    pub kb_alt: bool,
    /// right-click alternate active (hide or switch)
    pub rc_alt: bool,
    pub firing: bool,
    /// 'hide crosshair on launch' until the first toggle
    pub launch_hidden: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Buttons {
    pub left: bool,
    pub right: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MouseOutcome {
    /// new firing state when it changed
    pub firing: Option<bool>,
    /// right-click changed what is shown
    pub relayout: bool,
}

/// Visible flag + profile after applying keyboard / right-click alternates.
pub fn effective<'a>(c: &'a Config, rt: &Runtime) -> (bool, &'a Profile) {
    let mut visible = c.enabled && !rt.launch_hidden;
    let mut profile = c.active_profile();
    if rt.kb_alt {
        match c.toggle.mode {
            ToggleMode::Hide => visible = false,
            ToggleMode::Switch => profile = c.toggle.profile_id.as_deref().and_then(|id| c.profile(id)).unwrap_or(profile),
        }
    }
    if rt.rc_alt {
        if c.right_click.mode.is_hide() {
            visible = false;
        } else {
            profile = c.right_click.profile_id.as_deref().and_then(|id| c.profile(id)).unwrap_or(profile);
        }
    }
    (visible, profile)
}

/// Make a profile active and show it.
pub fn equip(c: &mut Config, rt: &mut Runtime, id: &str) {
    rt.kb_alt = false;
    rt.launch_hidden = false;
    c.active_profile_id = id.to_string();
    c.enabled = true;
}

/// Show/hide hotkey. In 'hide' mode it drives `enabled` (same flag as the app switch); when the
/// crosshair is off any mode turns it back on; 'switch' mode otherwise swaps to the alternate.
/// Returns true when `c` changed (must be saved).
pub fn keyboard_toggle(c: &mut Config, rt: &mut Runtime) -> bool {
    if rt.launch_hidden {
        rt.launch_hidden = false;
        if !c.enabled {
            c.enabled = true;
            return true;
        }
        false
    } else if c.toggle.mode == ToggleMode::Hide || !c.enabled {
        rt.kb_alt = false;
        c.enabled = !c.enabled;
        true
    } else {
        rt.kb_alt = !rt.kb_alt;
        false
    }
}

/// Tray "Show crosshair" checkbox.
pub fn tray_toggle_enabled(c: &mut Config, rt: &mut Runtime) {
    rt.launch_hidden = false;
    rt.kb_alt = false;
    c.enabled = !c.enabled;
}

/// Next / previous profile (wraps).
pub fn cycle_profile(c: &mut Config, rt: &mut Runtime, dir: i32) {
    let n = c.profiles.len() as i64;
    if n == 0 {
        return;
    }
    let i = c.profiles.iter().position(|p| p.id == c.active_profile_id).map(|i| i as i64).unwrap_or(-1);
    let next = (i + dir as i64 + n).rem_euclid(n) as usize;
    let id = c.profiles[next].id.clone();
    equip(c, rt, &id);
}

/// Nudge the crosshair (sanitize clamps the result).
pub fn move_crosshair(c: &mut Config, dx: i32, dy: i32) {
    c.display.offset_x = c.display.offset_x.saturating_add(dx * MOVE_STEP_PX);
    c.display.offset_y = c.display.offset_y.saturating_add(dy * MOVE_STEP_PX);
}

/// Mouse button change: left = firing; right = alternate per right-click mode.
pub fn on_mouse(c: &Config, rt: &mut Runtime, now: Buttons, prev: Buttons) -> MouseOutcome {
    let mut out = MouseOutcome::default();
    if now.left != prev.left && rt.firing != now.left {
        rt.firing = now.left;
        out.firing = Some(now.left);
    }
    if now.right == prev.right {
        return out;
    }
    let mode = c.right_click.mode;
    if mode == RcMode::Off {
        return out;
    }
    if mode.is_hold() {
        rt.rc_alt = now.right;
    } else if now.right {
        rt.rc_alt = !rt.rc_alt;
    } else {
        return out;
    }
    out.relayout = true;
    out
}

/// True when a layer of this crosshair animates while firing (core `hasFiring`).
pub fn crosshair_has_firing(ch: &Value) -> bool {
    ch.get("layers").and_then(Value::as_array).is_some_and(|layers| {
        layers.iter().any(|l| l.get("visible") == Some(&Value::Bool(true)) && l.pointer("/firing/enabled") == Some(&Value::Bool(true)))
    })
}

/// Mouse polling is needed for right-click modes or any profile that can be shown with firing.
pub fn needs_mouse(c: &Config) -> bool {
    if c.right_click.mode != RcMode::Off {
        return true;
    }
    [Some(c.active_profile_id.as_str()), c.toggle.profile_id.as_deref(), c.right_click.profile_id.as_deref()]
        .into_iter()
        .flatten()
        .filter_map(|id| c.profile(id))
        .any(|p| crosshair_has_firing(&p.crosshair))
}

/// Profiles that can appear without opening settings (sprites worth keeping ready).
pub fn relevant_profile_ids(c: &Config) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |id: &str| {
        if c.profile(id).is_some() && !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    };
    push(&c.active_profile_id);
    if let Some(id) = c.toggle.profile_id.as_deref() {
        push(id);
    }
    if let Some(id) = c.right_click.profile_id.as_deref() {
        push(id);
    }
    for p in c.profiles.iter().filter(|p| !p.hotkey.is_empty()) {
        push(&p.id);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{sanitize, Defaults};
    use serde_json::json;

    fn cfg(extra: Value) -> Config {
        let d = Defaults {
            default_crosshair: json!({"layers": []}),
            first_preset_name: "F".into(),
            first_preset_crosshair: json!({"layers": []}),
        };
        let mut raw = json!({
            "profiles": [
                {"id": "a", "name": "A", "crosshair": {"layers": [{"visible": true, "firing": {"enabled": false}}]}},
                {"id": "b", "name": "B", "hotkey": "F2", "crosshair": {"layers": [{"visible": true, "firing": {"enabled": true}}]}},
                {"id": "c", "name": "C", "crosshair": {"layers": [{"visible": false, "firing": {"enabled": true}}]}}
            ],
            "activeProfileId": "a"
        });
        for (k, v) in extra.as_object().unwrap() {
            raw[k] = v.clone();
        }
        sanitize(&raw, &d)
    }

    const DOWN: bool = true;

    #[test]
    fn effective_plain_and_launch_hidden() {
        let c = cfg(json!({}));
        let mut rt = Runtime::default();
        assert!(effective(&c, &rt).0);
        assert_eq!(effective(&c, &rt).1.id, "a");
        rt.launch_hidden = true;
        assert!(!effective(&c, &rt).0);
    }

    #[test]
    fn keyboard_toggle_hide_mode_drives_enabled() {
        let mut c = cfg(json!({}));
        let mut rt = Runtime::default();
        assert!(keyboard_toggle(&mut c, &mut rt));
        assert!(!c.enabled && !effective(&c, &rt).0);
        assert!(keyboard_toggle(&mut c, &mut rt));
        assert!(c.enabled);
    }

    #[test]
    fn keyboard_toggle_launch_hidden_first() {
        let mut c = cfg(json!({"enabled": false}));
        let mut rt = Runtime { launch_hidden: true, ..Default::default() };
        assert!(keyboard_toggle(&mut c, &mut rt));
        assert!(c.enabled && !rt.launch_hidden);

        let mut c = cfg(json!({}));
        let mut rt = Runtime { launch_hidden: true, ..Default::default() };
        assert!(!keyboard_toggle(&mut c, &mut rt), "already enabled: only clears launch_hidden");
        assert!(effective(&c, &rt).0);
    }

    #[test]
    fn keyboard_toggle_switch_mode() {
        let mut c = cfg(json!({"toggle": {"mode": "switch", "profileId": "b"}}));
        let mut rt = Runtime::default();
        assert!(!keyboard_toggle(&mut c, &mut rt));
        assert_eq!(effective(&c, &rt).1.id, "b");
        keyboard_toggle(&mut c, &mut rt);
        assert_eq!(effective(&c, &rt).1.id, "a");
        // disabled → any mode turns it back on
        c.enabled = false;
        rt.kb_alt = true;
        assert!(keyboard_toggle(&mut c, &mut rt));
        assert!(c.enabled && !rt.kb_alt);
    }

    #[test]
    fn switch_without_alt_profile_keeps_active() {
        let c = cfg(json!({"toggle": {"mode": "switch"}}));
        let rt = Runtime { kb_alt: true, ..Default::default() };
        assert_eq!(effective(&c, &rt).1.id, "a");
        assert!(effective(&c, &rt).0);
    }

    #[test]
    fn equip_and_cycle() {
        let mut c = cfg(json!({"enabled": false}));
        let mut rt = Runtime { kb_alt: true, launch_hidden: true, ..Default::default() };
        equip(&mut c, &mut rt, "c");
        assert_eq!(c.active_profile_id, "c");
        assert!(c.enabled && !rt.kb_alt && !rt.launch_hidden);
        cycle_profile(&mut c, &mut rt, 1);
        assert_eq!(c.active_profile_id, "a", "wraps forward");
        cycle_profile(&mut c, &mut rt, -1);
        assert_eq!(c.active_profile_id, "c", "wraps backward");
    }

    #[test]
    fn move_adds_step() {
        let mut c = cfg(json!({}));
        move_crosshair(&mut c, 1, -1);
        assert_eq!((c.display.offset_x, c.display.offset_y), (1, -1));
    }

    #[test]
    fn mouse_left_fires_once_per_change() {
        let c = cfg(json!({}));
        let mut rt = Runtime::default();
        let up = Buttons::default();
        let left = Buttons { left: DOWN, right: false };
        assert_eq!(on_mouse(&c, &mut rt, left, up).firing, Some(true));
        assert_eq!(on_mouse(&c, &mut rt, up, left).firing, Some(false));
        assert_eq!(on_mouse(&c, &mut rt, Buttons { left: false, right: DOWN }, up), MouseOutcome::default(), "rc off");
    }

    #[test]
    fn right_click_hold_and_toggle() {
        let c = cfg(json!({"rightClick": {"mode": "hideHold"}}));
        let mut rt = Runtime::default();
        let up = Buttons::default();
        let right = Buttons { left: false, right: DOWN };
        assert!(on_mouse(&c, &mut rt, right, up).relayout);
        assert!(!effective(&c, &rt).0);
        assert!(on_mouse(&c, &mut rt, up, right).relayout);
        assert!(effective(&c, &rt).0);

        let c = cfg(json!({"rightClick": {"mode": "switchToggle", "profileId": "b"}}));
        let mut rt = Runtime::default();
        assert!(on_mouse(&c, &mut rt, right, up).relayout);
        assert_eq!(effective(&c, &rt).1.id, "b");
        assert!(!on_mouse(&c, &mut rt, up, right).relayout, "release ignored in toggle mode");
        assert_eq!(effective(&c, &rt).1.id, "b");
        on_mouse(&c, &mut rt, right, up);
        assert_eq!(effective(&c, &rt).1.id, "a");
    }

    #[test]
    fn firing_and_mouse_need() {
        let c = cfg(json!({}));
        assert!(!crosshair_has_firing(&c.profiles[0].crosshair));
        assert!(crosshair_has_firing(&c.profiles[1].crosshair));
        assert!(!crosshair_has_firing(&c.profiles[2].crosshair), "hidden layer does not count");
        assert!(!needs_mouse(&c));
        assert!(needs_mouse(&cfg(json!({"activeProfileId": "b"}))));
        assert!(needs_mouse(&cfg(json!({"toggle": {"mode": "switch", "profileId": "b"}}))));
        assert!(needs_mouse(&cfg(json!({"rightClick": {"mode": "hideHold"}}))));
    }

    #[test]
    fn relevant_profiles() {
        let c = cfg(json!({"toggle": {"mode": "switch", "profileId": "c"}, "rightClick": {"mode": "switchHold", "profileId": "a"}}));
        assert_eq!(relevant_profile_ids(&c), vec!["a", "c", "b"]);
    }

    #[test]
    fn tray_toggle() {
        let mut c = cfg(json!({}));
        let mut rt = Runtime { kb_alt: true, launch_hidden: true, ..Default::default() };
        tray_toggle_enabled(&mut c, &mut rt);
        assert!(!c.enabled && !rt.kb_alt && !rt.launch_hidden);
    }
}
