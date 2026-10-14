//! Electron accelerator strings (as recorded by `settings.js toAccelerator`, e.g.
//! `CommandOrControl+Shift+X`, `Alt+num5`, `F13`, `Plus`) → `RegisterHotKey` modifiers + virtual key.

use windows::Win32::UI::Input::KeyboardAndMouse::{VkKeyScanW, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN};

fn modifier(token: &str) -> Option<u32> {
    Some(match token.to_ascii_lowercase().as_str() {
        "commandorcontrol" | "cmdorctrl" | "control" | "ctrl" => MOD_CONTROL.0,
        "alt" | "option" | "altgr" => MOD_ALT.0,
        "shift" => MOD_SHIFT.0,
        "super" | "meta" | "cmd" | "command" => MOD_WIN.0,
        _ => return None,
    })
}

fn named_key(token: &str) -> Option<u32> {
    let t = token.to_ascii_lowercase();
    if let Some(n) = t.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(0x70 + n - 1); // VK_F1..VK_F24
    }
    if let Some(d) = t.strip_prefix("num").and_then(|n| n.parse::<u32>().ok()).filter(|n| *n <= 9) {
        return Some(0x60 + d); // VK_NUMPAD0..9
    }
    Some(match t.as_str() {
        "space" => 0x20,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "plus" => 0xBB,
        "esc" | "escape" => 0x1B,
        "return" | "enter" => 0x0D,
        "tab" => 0x09,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" | "ins" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "printscreen" => 0x2C,
        "capslock" => 0x14,
        "numlock" => 0x90,
        "scrolllock" => 0x91,
        "pause" => 0x13,
        "numadd" => 0x6B,
        "numsub" => 0x6D,
        "nummult" => 0x6A,
        "numdiv" => 0x6F,
        "numdec" => 0x6E,
        _ => return None,
    })
}

/// Single character key: A–Z / 0–9 directly, anything else through the active keyboard layout
/// (German `ß`, `#`, `<` … work as recorded).
fn char_key(token: &str) -> Option<u32> {
    let mut chars = token.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    if c.is_ascii_alphabetic() {
        return Some(c.to_ascii_uppercase() as u32);
    }
    if c.is_ascii_digit() {
        return Some(c as u32);
    }
    for candidate in [c, c.to_lowercase().next().unwrap_or(c)] {
        let mut buf = [0u16; 2];
        if candidate.encode_utf16(&mut buf).len() != 1 {
            continue;
        }
        let r = unsafe { VkKeyScanW(buf[0]) };
        if r != -1 {
            return Some((r as u16 & 0xFF) as u32);
        }
    }
    None
}

/// Parse an accelerator into `(modifiers, virtual key)`.
pub fn parse(accel: &str) -> Result<(u32, u32), String> {
    let tokens: Vec<&str> = accel.split('+').map(str::trim).collect();
    if tokens.iter().any(|t| t.is_empty()) {
        return Err(format!("malformed accelerator '{accel}'"));
    }
    let (key, mods) = tokens.split_last().ok_or_else(|| "empty accelerator".to_string())?;
    let mut m = 0u32;
    for t in mods {
        m |= modifier(t).ok_or_else(|| format!("unknown modifier '{t}' in '{accel}'"))?;
    }
    if modifier(key).is_some() {
        return Err(format!("accelerator '{accel}' has no key"));
    }
    let vk = named_key(key).or_else(|| char_key(key)).ok_or_else(|| format!("unknown key '{key}' in '{accel}'"))?;
    Ok((m, vk))
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: u32 = MOD_CONTROL.0;
    const A: u32 = MOD_ALT.0;
    const S: u32 = MOD_SHIFT.0;

    #[test]
    fn recorded_forms() {
        let table: &[(&str, u32, u32)] = &[
            ("Alt+Shift+X", A | S, 0x58),
            ("CommandOrControl+Shift+Right", C | S, 0x27),
            ("CommandOrControl+Alt+5", C | A, 0x35),
            ("F5", 0, 0x74),
            ("F24", 0, 0x87),
            ("Alt+num5", A, 0x65),
            ("Shift+Space", S, 0x20),
            ("Plus", 0, 0xBB),
            ("Esc", 0, 0x1B),
            ("Return", 0, 0x0D),
            ("Alt+PageDown", A, 0x22),
            ("Ctrl+Delete", C, 0x2E),
            ("alt+shift+x", A | S, 0x58),
        ];
        for (s, m, vk) in table {
            assert_eq!(parse(s), Ok((*m, *vk)), "{s}");
        }
    }

    #[test]
    fn punctuation_uses_layout() {
        // every layout has a key for ',' and '.'
        assert!(parse("Alt+,").is_ok());
        assert!(parse("Alt+.").is_ok());
    }

    #[test]
    fn rejects_bad_input() {
        for s in ["", "+", "Alt+", "Alt+Shift", "Hyper+X", "F25", "num10", "Alt+Banana", "Alt++X"] {
            assert!(parse(s).is_err(), "{s}");
        }
    }
}
