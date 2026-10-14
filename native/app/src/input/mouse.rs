//! Global mouse buttons via `GetAsyncKeyState` (works while games have focus), polled every 8 ms
//! on a thread that only runs while firing / right-click features need it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};

use crate::logger;
use crate::state::Buttons;

const POLL: Duration = Duration::from_millis(8);
const KEY_DOWN_BIT: u16 = 0x8000;

fn read() -> Buttons {
    unsafe {
        Buttons {
            left: (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & KEY_DOWN_BIT) != 0,
            right: (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & KEY_DOWN_BIT) != 0,
        }
    }
}

pub struct MousePoller {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MousePoller {
    /// Start polling; `on_change(now, prev)` fires only when a button changes.
    pub fn start(on_change: Box<dyn Fn(Buttons, Buttons) + Send>) -> MousePoller {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("mouse-poll".into())
            .spawn(move || {
                let mut last = read();
                while !flag.load(Ordering::Relaxed) {
                    std::thread::sleep(POLL);
                    let now = read();
                    if now != last {
                        let prev = last;
                        last = now;
                        on_change(now, prev);
                    }
                }
            })
            .map_err(|err| logger::error("mouse poller thread failed to start", serde_json::json!({"error": err.to_string()})))
            .ok();
        logger::info("mouse polling started", None);
        MousePoller { stop, thread }
    }

    pub fn is_running(&self) -> bool {
        self.thread.is_some()
    }
}

impl Drop for MousePoller {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
            logger::info("mouse polling stopped", None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_and_stops_cleanly() {
        let p = MousePoller::start(Box::new(|_, _| {}));
        assert!(p.is_running());
        std::thread::sleep(Duration::from_millis(30));
        drop(p);
    }
}
