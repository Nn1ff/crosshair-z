//! Plain-text clipboard (share codes). Retries briefly when another app holds the clipboard.

use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

const OPEN_ATTEMPTS: u32 = 10;
const OPEN_RETRY: Duration = Duration::from_millis(20);
pub const MAX_CHARS: usize = 10_000;

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

fn truncate(s: &str) -> String {
    s.chars().take(MAX_CHARS).collect()
}

pub fn write_text(text: &str) -> Result<(), String> {
    let wide: Vec<u16> = truncate(text).encode_utf16().chain(std::iter::once(0)).collect();
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
        let mut len = 0usize;
        while len < MAX_CHARS * 2 && *src.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(src, len));
        let _ = GlobalUnlock(mem);
        Ok(truncate(&text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_truncate() {
        // the clipboard is shared with the desktop: restore what was there
        let before = read_text().unwrap_or_default();
        write_text("CZ3-test äöü 🎯").unwrap();
        assert_eq!(read_text().unwrap(), "CZ3-test äöü 🎯");
        write_text(&"x".repeat(MAX_CHARS + 50)).unwrap();
        assert_eq!(read_text().unwrap().chars().count(), MAX_CHARS);
        let _ = write_text(&before);
    }
}
