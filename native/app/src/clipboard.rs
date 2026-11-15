//! Plain-text clipboard (share codes). Retries briefly when another app holds the clipboard.
//! Both directions stop at `MAX_CHARS`: longer text is an error, never silently truncated.

use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

const OPEN_ATTEMPTS: u32 = 10;
const OPEN_RETRY: Duration = Duration::from_millis(20);
/// Longest clipboard text in UTF-16 units (JS `length`); the largest legit share code is ≈ 1.9 M
/// (measured 1,884,166).
pub const MAX_CHARS: usize = 2_000_000;

/// Keeps the clipboard open; closes it on every exit path.
struct Open;

impl Open {
    fn new() -> Result<Open, String> {
        for _ in 0..OPEN_ATTEMPTS {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(Open);
            }
            std::thread::sleep(OPEN_RETRY);
        }
        Err("clipboard is busy".into())
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

/// Units before the first NUL; `None` when `units` contains none.
fn nul_terminated_len(units: &[u16]) -> Option<usize> {
    units.iter().position(|&u| u == 0)
}

/// Text of a `CF_UNICODETEXT` allocation seen as `units` (at most `MAX_CHARS + 1` of them): up to
/// the first NUL. Some apps omit the terminator: an allocation without one is read whole while it
/// fits the cap (2.0.5 read such text too); above the cap it is an error.
fn decode_units(units: &[u16]) -> Result<String, String> {
    match nul_terminated_len(units) {
        Some(len) => Ok(String::from_utf16_lossy(&units[..len])),
        None if units.len() > MAX_CHARS => Err("clipboard text too long".into()),
        None => Ok(String::from_utf16_lossy(units)),
    }
}

pub fn write_text(text: &str) -> Result<(), String> {
    // checked before the clipboard is opened: a rejected text leaves the clipboard untouched
    if text.encode_utf16().count() > MAX_CHARS {
        return Err("text too long for the clipboard".into());
    }
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let _open = Open::new()?;
    unsafe {
        EmptyClipboard().map_err(|e| e.to_string())?;
        let mem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.to_string())?;
        let dst = GlobalLock(mem) as *mut u16;
        if dst.is_null() {
            let _ = GlobalFree(Some(mem));
            return Err("clipboard memory lock failed".into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
        let _ = GlobalUnlock(mem);
        if let Err(err) = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(mem.0))) {
            let _ = GlobalFree(Some(mem)); // ownership only passes to the clipboard on success
            return Err(err.to_string());
        }
    }
    Ok(())
}

pub fn read_text() -> Result<String, String> {
    let _open = Open::new()?;
    unsafe {
        let Ok(h) = GetClipboardData(CF_UNICODETEXT.0 as u32) else { return Ok(String::new()) };
        let mem = HGLOBAL(h.0);
        let src = GlobalLock(mem) as *const u16;
        if src.is_null() {
            return Ok(String::new());
        }
        // never past the allocation, and at most one unit beyond the cap
        let units = std::slice::from_raw_parts(src, (GlobalSize(mem) / 2).min(MAX_CHARS + 1));
        let text = decode_units(units);
        let _ = GlobalUnlock(mem);
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nul_scan_is_bounded() {
        assert_eq!(nul_terminated_len(&[65, 66, 0, 67]), Some(2));
        assert_eq!(nul_terminated_len(&[0]), Some(0));
        assert_eq!(nul_terminated_len(&[65; 8]), None);
        assert_eq!(nul_terminated_len(&[]), None);
    }

    #[test]
    fn unterminated_text_is_read_whole_up_to_the_cap() {
        // pure helper: the allocation as `read_text` sees it, never the real clipboard
        assert_eq!(decode_units(&[65, 66, 0, 67]), Ok("AB".to_string()), "up to the first NUL");
        assert_eq!(decode_units(&[65, 66]), Ok("AB".to_string()), "no NUL in the allocation: all of it, as 2.0.5 read it");
        assert_eq!(decode_units(&[]), Ok(String::new()));
        assert_eq!(decode_units(&vec![65; MAX_CHARS]).map(|t| t.len()), Ok(MAX_CHARS), "unterminated at the cap");
        let err = decode_units(&vec![65; MAX_CHARS + 1]).unwrap_err();
        assert!(err.contains("too long"), "{err}");
    }

    #[test]
    fn over_long_write_rejected_before_open() {
        // rejected before the clipboard is opened, so this never touches the real clipboard
        let err = write_text(&"a".repeat(MAX_CHARS + 1)).unwrap_err();
        assert!(err.contains("too long"), "{err}");
    }

    #[test]
    #[ignore = "writes the real clipboard"]
    fn roundtrip_real_clipboard() {
        // the clipboard is shared with the desktop: restore what was there
        let before = read_text().unwrap_or_default();
        write_text("CZ3-test äöü 🎯").unwrap();
        assert_eq!(read_text().unwrap(), "CZ3-test äöü 🎯");
        let longest = "x".repeat(MAX_CHARS);
        write_text(&longest).unwrap();
        assert_eq!(read_text().unwrap(), longest, "text at the cap is not truncated");
        let _ = write_text(&before);
    }
}
