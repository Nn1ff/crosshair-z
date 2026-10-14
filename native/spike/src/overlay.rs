//! Throwaway: native layered overlay window (spec §4 window styles).
use std::ffi::c_void;

use windows::core::w;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::*;

const OVERLAY_PX: i32 = 64;
const TOPMOST_TIMER_ID: usize = 1;
const TOPMOST_INTERVAL_MS: u32 = 1000;
const ARM_LEN: i32 = 12;
const GAP: i32 = 4;
const THICKNESS: i32 = 2;

pub fn spawn() {
    std::thread::spawn(|| unsafe {
        if let Err(err) = run() {
            println!("overlay failed: {err}");
        }
    });
}

unsafe fn run() -> windows::core::Result<()> {
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let hinst: HINSTANCE = GetModuleHandleW(None)?.into();
    let class = w!("CzSpikeOverlay");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: hinst,
        lpszClassName: class,
        ..Default::default()
    };
    RegisterClassW(&wc);

    let sw = GetSystemMetrics(SM_CXSCREEN);
    let sh = GetSystemMetrics(SM_CYSCREEN);
    let x = (sw - OVERLAY_PX) / 2;
    let y = (sh - OVERLAY_PX) / 2;
    let hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        class,
        w!(""),
        WS_POPUP,
        x,
        y,
        OVERLAY_PX,
        OVERLAY_PX,
        None,
        None,
        Some(hinst),
        None,
    )?;
    paint(hwnd, x, y)?;
    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    SetTimer(Some(hwnd), TOPMOST_TIMER_ID, TOPMOST_INTERVAL_MS, None);
    println!("overlay shown at {x},{y} on {sw}x{sh}");

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    Ok(())
}

/// Premultiplied BGRA plus sign, pushed with UpdateLayeredWindow(ULW_ALPHA).
unsafe fn paint(hwnd: HWND, x: i32, y: i32) -> windows::core::Result<()> {
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: OVERLAY_PX,
            biHeight: -OVERLAY_PX, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bmp = CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)?;
    let old = SelectObject(mem, bmp.into());

    let px = std::slice::from_raw_parts_mut(bits as *mut u32, (OVERLAY_PX * OVERLAY_PX) as usize);
    let c = OVERLAY_PX / 2;
    let red: u32 = 0xFF_FF_00_00; // 0xAARRGGBB; little-endian bytes = B G R A -> opaque red (premultiplied)
    for yy in 0..OVERLAY_PX {
        for xx in 0..OVERLAY_PX {
            let dx = xx - c;
            let dy = yy - c;
            let horiz = (dy >= -THICKNESS / 2 && dy < THICKNESS / 2) && dx.abs() >= GAP && dx.abs() < GAP + ARM_LEN;
            let vert = (dx >= -THICKNESS / 2 && dx < THICKNESS / 2) && dy.abs() >= GAP && dy.abs() < GAP + ARM_LEN;
            px[(yy * OVERLAY_PX + xx) as usize] = if horiz || vert { red } else { 0 };
        }
    }

    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let result = UpdateLayeredWindow(
        hwnd,
        Some(screen),
        Some(&POINT { x, y }),
        Some(&SIZE { cx: OVERLAY_PX, cy: OVERLAY_PX }),
        Some(mem),
        Some(&POINT { x: 0, y: 0 }),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );

    SelectObject(mem, old);
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    result
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_TIMER && wparam.0 == TOPMOST_TIMER_ID {
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
        // HWND_TOPMOST alone does not reorder within the topmost band; HWND_TOP raises us above
        // other topmost windows (spike experiment against a topmost-spamming fake game).
        let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, flags);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
