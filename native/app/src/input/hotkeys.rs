//! Global hotkeys via `RegisterHotKey` on a dedicated thread (WM_HOTKEY arrives in its queue).
//! Statuses match `tryRegister` in main.js: empty | duplicate | ok | taken | invalid.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS};
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_APP, WM_HOTKEY, WM_USER};

use super::accel;
use crate::logger;

const WM_APP_CMD: u32 = WM_APP + 2;
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Empty,
    Duplicate,
    Ok,
    Taken,
    Invalid,
}

enum Cmd {
    Register(Vec<(String, String)>, Sender<BTreeMap<String, Status>>),
    Quit,
}

pub struct Hotkeys {
    tx: Sender<Cmd>,
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Hotkeys {
    /// `on_hotkey(key)` runs on the hotkey thread for every press.
    pub fn spawn(on_hotkey: Box<dyn Fn(String) + Send>) -> Result<Hotkeys, String> {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<u32>();
        let thread = std::thread::Builder::new()
            .name("hotkeys".into())
            .spawn(move || unsafe { run(rx, ready_tx, on_hotkey) })
            .map_err(|e| e.to_string())?;
        let thread_id = ready_rx.recv_timeout(REPLY_TIMEOUT).map_err(|_| "hotkey thread did not start".to_string())?;
        Ok(Hotkeys { tx, thread_id, thread: Some(thread) })
    }

    fn post(&self, cmd: Cmd) -> bool {
        if self.tx.send(cmd).is_err() {
            return false;
        }
        unsafe { PostThreadMessageW(self.thread_id, WM_APP_CMD, WPARAM(0), LPARAM(0)).is_ok() }
    }

    /// Replace all registrations with `(key, accelerator)` pairs (order = priority).
    pub fn register(&self, bindings: Vec<(String, String)>) -> BTreeMap<String, Status> {
        let keys: Vec<String> = bindings.iter().map(|(k, _)| k.clone()).collect();
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.post(Cmd::Register(bindings, reply_tx)) {
            if let Ok(status) = reply_rx.recv_timeout(REPLY_TIMEOUT) {
                return status;
            }
        }
        logger::error("hotkey registration did not complete", None);
        keys.into_iter().map(|k| (k, Status::Taken)).collect()
    }
}

impl Drop for Hotkeys {
    fn drop(&mut self) {
        self.post(Cmd::Quit);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

unsafe fn register_all(bindings: Vec<(String, String)>, active: &mut HashMap<i32, String>) -> BTreeMap<String, Status> {
    for id in active.keys() {
        let _ = UnregisterHotKey(None, *id);
    }
    active.clear();
    let mut used: HashSet<String> = HashSet::new();
    let mut status = BTreeMap::new();
    for (i, (key, accel_str)) in bindings.into_iter().enumerate() {
        let s = if accel_str.is_empty() {
            Status::Empty
        } else if used.contains(&accel_str) {
            Status::Duplicate
        } else {
            match accel::parse(&accel_str) {
                Err(err) => {
                    logger::warn("hotkey invalid", json!({"accel": accel_str, "error": err}));
                    Status::Invalid
                }
                Ok((mods, vk)) => {
                    let id = i as i32 + 1;
                    match RegisterHotKey(None, id, HOT_KEY_MODIFIERS(mods), vk) {
                        Ok(()) => {
                            used.insert(accel_str.clone());
                            active.insert(id, key.clone());
                            Status::Ok
                        }
                        Err(_) => Status::Taken,
                    }
                }
            }
        };
        status.insert(key, s);
    }
    logger::info("hotkeys registered", json!({"count": active.len()}));
    status
}

unsafe fn run(rx: Receiver<Cmd>, ready: Sender<u32>, on_hotkey: Box<dyn Fn(String) + Send>) {
    let mut msg = MSG::default();
    // make sure this thread has a message queue before anyone posts to it
    let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
    let _ = ready.send(GetCurrentThreadId());
    let mut active: HashMap<i32, String> = HashMap::new();
    loop {
        if GetMessageW(&mut msg, None, 0, 0).0 <= 0 {
            break;
        }
        match msg.message {
            WM_HOTKEY => {
                if let Some(key) = active.get(&(msg.wParam.0 as i32)) {
                    on_hotkey(key.clone());
                }
            }
            WM_APP_CMD => {
                let mut quit = false;
                while let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        Cmd::Register(bindings, reply) => {
                            let _ = reply.send(register_all(bindings, &mut active));
                        }
                        Cmd::Quit => quit = true,
                    }
                }
                if quit {
                    break;
                }
            }
            _ => {}
        }
    }
    for id in active.keys() {
        let _ = UnregisterHotKey(None, *id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unusual combos so the test never collides with real hotkeys on the machine.
    const RARE: &str = "Ctrl+Alt+Shift+F23";
    const RARE2: &str = "Ctrl+Alt+Shift+F22";

    fn noop() -> Box<dyn Fn(String) + Send> {
        Box::new(|_| {})
    }

    #[test]
    fn statuses() {
        let hk = Hotkeys::spawn(noop()).unwrap();
        let s = hk.register(vec![
            ("toggle".into(), RARE.into()),
            ("next".into(), "".into()),
            ("prev".into(), RARE.into()),
            ("settings".into(), "Hyper+Q".into()),
            ("profile:a".into(), RARE2.into()),
        ]);
        assert_eq!(s["toggle"], Status::Ok);
        assert_eq!(s["next"], Status::Empty);
        assert_eq!(s["prev"], Status::Duplicate);
        assert_eq!(s["settings"], Status::Invalid);
        assert_eq!(s["profile:a"], Status::Ok);
    }

    #[test]
    fn taken_by_other_registrant_and_released_on_reregister() {
        let first = Hotkeys::spawn(noop()).unwrap();
        let second = Hotkeys::spawn(noop()).unwrap();
        assert_eq!(first.register(vec![("t".into(), "Ctrl+Alt+Shift+F21".into())])["t"], Status::Ok);
        assert_eq!(second.register(vec![("t".into(), "Ctrl+Alt+Shift+F21".into())])["t"], Status::Taken);
        first.register(vec![]);
        assert_eq!(second.register(vec![("t".into(), "Ctrl+Alt+Shift+F21".into())])["t"], Status::Ok);
    }
}
