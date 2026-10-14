//! Live check of the real layered window: draws a known frame at the primary monitor center and
//! reads the screen back. Needs an interactive desktop → `cargo test --test window_live -- --ignored`.

use std::time::Duration;

use crosshair_z::overlay::monitors;
use crosshair_z::overlay::window::{OverlayWindow, WindowCmd};
use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

const SIZE: u32 = 16;
const RED: u32 = 0xFFFF_0000; // premultiplied opaque red (BGRA in memory)

fn screen_rgb(x: i32, y: i32) -> (u8, u8, u8) {
    unsafe {
        let dc = GetDC(None);
        let c = GetPixel(dc, x, y).0; // 0x00BBGGRR
        ReleaseDC(None, dc);
        ((c & 0xFF) as u8, ((c >> 8) & 0xFF) as u8, ((c >> 16) & 0xFF) as u8)
    }
}

#[test]
#[ignore = "needs an interactive desktop"]
fn shows_frame_and_clears() {
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let list = monitors::list();
    let m = monitors::pick(&list, None).expect("a monitor");
    let (x, y) = monitors::layout(m, 0, 0, SIZE);
    let win = OverlayWindow::spawn(Box::new(|| {})).expect("window");
    let h = win.handle();

    let mut px = vec![0u32; (SIZE * SIZE) as usize];
    px[(8 * SIZE + 8) as usize] = RED;
    h.send(WindowCmd::Show { x, y, size: SIZE, pixels: px });
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(screen_rgb(x + 8, y + 8), (255, 0, 0), "red pixel visible at center");
    let neighbor = screen_rgb(x + 2, y + 2);

    h.send(WindowCmd::Show { x, y, size: SIZE, pixels: vec![0; (SIZE * SIZE) as usize] });
    std::thread::sleep(Duration::from_millis(300));
    assert_ne!(screen_rgb(x + 8, y + 8), (255, 0, 0), "cleared frame shows the desktop");
    assert_eq!(screen_rgb(x + 2, y + 2), neighbor, "transparent pixels untouched");
    drop(win);
}
