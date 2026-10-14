//! The overlay window: a click-through, topmost, layered popup on its own thread. It only shows
//! premultiplied BGRA frames handed to it (`UpdateLayeredWindow`), reasserts topmost every
//! 2 s and whenever the foreground window changes, and reports display changes.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;

use serde_json::json;
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostQuitMessage, PostThreadMessageW, RegisterClassW, SetTimer,
    SetWindowPos, ShowWindow, TranslateMessage, UpdateLayeredWindow, EVENT_SYSTEM_FOREGROUND, HWND_TOP, HWND_TOPMOST, MSG, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE, ULW_ALPHA, WINEVENT_OUTOFCONTEXT, WM_APP, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_TIMER, WNDCLASSW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

use crate::logger;

pub const CLASS_NAME: &str = "CrosshairZOverlay";
const TOPMOST_TIMER_ID: usize = 1;
const TOPMOST_REASSERT_MS: u32 = 2000;
const WM_APP_CMD: u32 = WM_APP + 1;

pub enum WindowCmd {
    Show { x: i32, y: i32, size: u32, pixels: Vec<u32> },
    Quit,
}

/// Cheap, cloneable sender to the window thread.
#[derive(Clone)]
pub struct WindowHandle {
    tx: Sender<WindowCmd>,
    thread_id: u32,
}

impl WindowHandle {
    pub fn send(&self, cmd: WindowCmd) {
        if self.tx.send(cmd).is_err() {
            logger::error("overlay window thread gone", None);
            return;
        }
        unsafe {
            if let Err(err) = PostThreadMessageW(self.thread_id, WM_APP_CMD, WPARAM(0), LPARAM(0)) {
                logger::error("overlay window wake failed", json!({"error": err.to_string()}));
            }
        }
    }
}

pub struct OverlayWindow {
    handle: WindowHandle,
    thread: Option<JoinHandle<()>>,
}

impl OverlayWindow {
    /// Create the window thread. `on_display_change` runs on that thread.
    pub fn spawn(on_display_change: Box<dyn Fn() + Send>) -> Result<OverlayWindow, String> {
        let (tx, rx) = mpsc::channel::<WindowCmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let thread = std::thread::Builder::new()
            .name("overlay-window".into())
            .spawn(move || unsafe { run(rx, ready_tx, on_display_change) })
            .map_err(|e| e.to_string())?;
        let thread_id = ready_rx.recv().map_err(|_| "overlay window thread died during start".to_string())??;
        Ok(OverlayWindow { handle: WindowHandle { tx, thread_id }, thread: Some(thread) })
    }

    pub fn handle(&self) -> WindowHandle {
        self.handle.clone()
    }
}

impl Drop for OverlayWindow {
    fn drop(&mut self) {
        self.handle.send(WindowCmd::Quit);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Per-thread window state (the window procedure and WinEvent hook have no user pointer).
struct Ctx {
    hwnd: HWND,
    rx: Receiver<WindowCmd>,
    on_display_change: Box<dyn Fn() + Send>,
    surface: Option<Surface>,
    shown: bool,
}

thread_local! {
    static CTX: RefCell<Option<Ctx>> = const { RefCell::new(None) };
}

/// A DIB section the size of the overlay, reused while the size stays the same.
struct Surface {
    dc: HDC,
    bmp: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u32,
    size: u32,
}

impl Surface {
    unsafe fn new(size: u32) -> Option<Surface> {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        ReleaseDC(None, screen);
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size as i32,
                biHeight: -(size as i32), // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        match CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bmp) if !bits.is_null() => {
                let old = SelectObject(dc, bmp.into());
                Some(Surface { dc, bmp, old, bits: bits as *mut u32, size })
            }
            other => {
                logger::error("overlay surface creation failed", json!({"size": size, "error": format!("{:?}", other.err())}));
                let _ = DeleteDC(dc);
                None
            }
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bmp.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

unsafe fn reassert_topmost(hwnd: HWND) {
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
    // HWND_TOPMOST alone does not reorder within the topmost band (spike B); HWND_TOP does.
    let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, flags);
}

unsafe fn show_frame(ctx: &mut Ctx, x: i32, y: i32, size: u32, pixels: &[u32]) {
    if size == 0 || pixels.len() != (size * size) as usize {
        logger::error("overlay frame has wrong size", json!({"size": size, "pixels": pixels.len()}));
        return;
    }
    if ctx.surface.as_ref().map(|s| s.size) != Some(size) {
        ctx.surface = None;
        ctx.surface = Surface::new(size);
    }
    let Some(s) = ctx.surface.as_ref() else { return };
    std::ptr::copy_nonoverlapping(pixels.as_ptr(), s.bits, pixels.len());
    let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
    let screen = GetDC(None);
    let result = UpdateLayeredWindow(
        ctx.hwnd,
        Some(screen),
        Some(&POINT { x, y }),
        Some(&SIZE { cx: size as i32, cy: size as i32 }),
        Some(s.dc),
        Some(&POINT { x: 0, y: 0 }),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );
    ReleaseDC(None, screen);
    if let Err(err) = result {
        logger::error("UpdateLayeredWindow failed", json!({"error": err.to_string(), "x": x, "y": y, "size": size}));
        return;
    }
    if !ctx.shown {
        let _ = ShowWindow(ctx.hwnd, SW_SHOWNOACTIVATE);
        ctx.shown = true;
    }
    reassert_topmost(ctx.hwnd);
}

/// Apply queued commands; only the newest frame matters. Returns false on Quit.
unsafe fn drain() -> bool {
    CTX.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some(ctx) = guard.as_mut() else { return false };
        let mut latest: Option<(i32, i32, u32, Vec<u32>)> = None;
        let mut keep_running = true;
        while let Ok(cmd) = ctx.rx.try_recv() {
            match cmd {
                WindowCmd::Show { x, y, size, pixels } => latest = Some((x, y, size, pixels)),
                WindowCmd::Quit => keep_running = false,
            }
        }
        if let Some((x, y, size, pixels)) = latest {
            show_frame(ctx, x, y, size, &pixels);
        }
        if !keep_running {
            ctx.surface = None;
            let _ = DestroyWindow(ctx.hwnd);
        }
        keep_running
    })
}

unsafe extern "system" fn on_foreground(_hook: HWINEVENTHOOK, _event: u32, _hwnd: HWND, _obj: i32, _child: i32, _thread: u32, _time: u32) {
    CTX.with(|cell| {
        if let Ok(guard) = cell.try_borrow() {
            if let Some(ctx) = guard.as_ref().filter(|c| c.shown) {
                reassert_topmost(ctx.hwnd);
            }
        }
    });
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER if wparam.0 == TOPMOST_TIMER_ID => {
            reassert_topmost(hwnd);
            LRESULT(0)
        }
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            CTX.with(|cell| {
                if let Ok(guard) = cell.try_borrow() {
                    if let Some(ctx) = guard.as_ref() {
                        (ctx.on_display_change)();
                    }
                }
            });
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn run(rx: Receiver<WindowCmd>, ready: Sender<Result<u32, String>>, on_display_change: Box<dyn Fn() + Send>) {
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let hinst: HINSTANCE = match GetModuleHandleW(None) {
        Ok(m) => m.into(),
        Err(err) => {
            let _ = ready.send(Err(format!("GetModuleHandleW: {err}")));
            return;
        }
    };
    let class = w!("CrosshairZOverlay");
    let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinst, lpszClassName: class, ..Default::default() };
    RegisterClassW(&wc); // fails harmlessly if a previous overlay thread registered it
    let hwnd = match CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        class,
        w!("Crosshair Z overlay"),
        WS_POPUP,
        0,
        0,
        1,
        1,
        None,
        None,
        Some(hinst),
        None,
    ) {
        Ok(h) => h,
        Err(err) => {
            let _ = ready.send(Err(format!("CreateWindowExW: {err}")));
            return;
        }
    };
    SetTimer(Some(hwnd), TOPMOST_TIMER_ID, TOPMOST_REASSERT_MS, None);
    let hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
    if hook.is_invalid() {
        logger::warn("foreground hook unavailable, topmost reassert timer only", None);
    }
    CTX.with(|cell| *cell.borrow_mut() = Some(Ctx { hwnd, rx, on_display_change, surface: None, shown: false }));
    let _ = ready.send(Ok(GetCurrentThreadId()));
    logger::info("overlay window ready", None);

    let mut msg = MSG::default();
    loop {
        let r = GetMessageW(&mut msg, None, 0, 0);
        if r.0 <= 0 {
            break; // WM_QUIT or error
        }
        if msg.hwnd.is_invalid() && msg.message == WM_APP_CMD {
            if !drain() {
                PostQuitMessage(0);
            }
            continue;
        }
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    if !hook.is_invalid() {
        let _ = UnhookWinEvent(hook);
    }
    CTX.with(|cell| *cell.borrow_mut() = None);
    logger::info("overlay window closed", None);
}
