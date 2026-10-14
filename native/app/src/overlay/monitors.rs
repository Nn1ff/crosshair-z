//! Monitors in physical pixels and where the overlay goes on them.
//! Ids are a hash of the device name (`\\.\DISPLAY1`), stable across restarts. Electron's display
//! ids from 1.x configs are unknown here and fall back to the primary monitor.

use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

const BASE_DPI: u32 = 96;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Monitor {
    pub id: i64,
    pub name: String,
    pub rect: Rect,
    pub primary: bool,
    pub scale_percent: u32,
}

/// FNV-1a 64 of the device name, masked to 53 bits so the settings UI (JS numbers) keeps it exact.
pub fn monitor_id(device_name: &str) -> i64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in device_name.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h & 0x001F_FFFF_FFFF_FFFF) as i64
}

/// Configured monitor, else primary, else the first one.
pub fn pick(list: &[Monitor], id: Option<i64>) -> Option<&Monitor> {
    id.and_then(|id| list.iter().find(|m| m.id == id)).or_else(|| list.iter().find(|m| m.primary)).or_else(|| list.first())
}

/// Top-left of a `size` px overlay whose center = monitor center + offset (physical px).
pub fn layout(m: &Monitor, offset_x: i32, offset_y: i32, size: u32) -> (i32, i32) {
    let cx = m.rect.left + m.rect.width() / 2 + offset_x;
    let cy = m.rect.top + m.rect.height() / 2 + offset_y;
    (cx - size as i32 / 2, cy - size as i32 / 2)
}

unsafe extern "system" fn collect(hmon: HMONITOR, _hdc: HDC, _rect: *mut RECT, data: LPARAM) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<Monitor>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
        let len = info.szDevice.iter().position(|c| *c == 0).unwrap_or(info.szDevice.len());
        let name = String::from_utf16_lossy(&info.szDevice[..len]);
        let r = info.monitorInfo.rcMonitor;
        let (mut dx, mut dy) = (BASE_DPI, BASE_DPI);
        let dpi = if GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy).is_ok() { dx } else { BASE_DPI };
        out.push(Monitor {
            id: monitor_id(&name),
            name,
            rect: Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            scale_percent: dpi * 100 / BASE_DPI,
        });
    }
    BOOL(1)
}

/// All monitors in physical pixels (per-monitor DPI aware while enumerating).
pub fn list() -> Vec<Monitor> {
    let mut out: Vec<Monitor> = Vec::new();
    unsafe {
        let prev = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut out as *mut Vec<Monitor> as isize));
        if !prev.0.is_null() {
            SetThreadDpiAwarenessContext(prev);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(id: i64, left: i32, primary: bool) -> Monitor {
        Monitor { id, name: format!("m{id}"), rect: Rect { left, top: 0, right: left + 1920, bottom: 1080 }, primary, scale_percent: 100 }
    }

    #[test]
    fn ids_stable_and_js_safe() {
        assert_eq!(monitor_id("\\\\.\\DISPLAY1"), monitor_id("\\\\.\\DISPLAY1"));
        assert_ne!(monitor_id("\\\\.\\DISPLAY1"), monitor_id("\\\\.\\DISPLAY2"));
        assert!(monitor_id("\\\\.\\DISPLAY1") >= 0 && monitor_id("\\\\.\\DISPLAY1") < (1i64 << 53));
    }

    #[test]
    fn pick_falls_back_to_primary() {
        let list = vec![mon(1, 0, false), mon(2, 1920, true)];
        assert_eq!(pick(&list, Some(1)).unwrap().id, 1);
        assert_eq!(pick(&list, Some(2779098405)).unwrap().id, 2, "electron id unknown → primary");
        assert_eq!(pick(&list, None).unwrap().id, 2);
        assert_eq!(pick(&[mon(7, 0, false)], None).unwrap().id, 7, "no primary flag → first");
        assert!(pick(&[], None).is_none());
    }

    #[test]
    fn layout_centers_with_offset() {
        let m = mon(1, 1920, true);
        assert_eq!(layout(&m, 0, 0, 64), (1920 + 960 - 32, 540 - 32));
        assert_eq!(layout(&m, 5, -3, 40), (1920 + 960 + 5 - 20, 540 - 3 - 20));
    }

    #[test]
    fn real_monitors_listed() {
        let list = list();
        assert!(!list.is_empty());
        assert!(list.iter().any(|m| m.primary));
        assert!(list.iter().all(|m| m.rect.width() > 0 && m.scale_percent >= 100));
    }
}
