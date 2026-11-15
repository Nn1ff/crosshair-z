//! One running Crosshair Z per user session. A second start tells the running one its version and
//! exe over a named pipe. The running app answers "stay" (it opens its settings, the new process
//! exits) or "handover" (newer version, e.g. an in-app update: it quits, and the new process waits
//! for the mutex and takes over) — main.js `onSecondInstance`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use windows::core::{HRESULT, HSTRING};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, E_ACCESSDENIED, ERROR_ALREADY_EXISTS, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows::Win32::Storage::FileSystem::{CreateFileW, FlushFileBuffers, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::Threading::CreateMutexW;

use crate::logger;

const MAX_MESSAGE: usize = 4096;
const PIPE_BUFFER: u32 = 4096;
const REPLY_HANDOVER: &[u8] = b"handover";
const REPLY_STAY: &[u8] = b"stay";
const TAKEOVER_TIMEOUT: Duration = Duration::from_secs(15);
const TAKEOVER_POLL: Duration = Duration::from_millis(200);
/// Wait after the first failed pipe creation; doubles per failure up to `PIPE_RETRY_MAX`.
const PIPE_RETRY_FIRST: Duration = Duration::from_secs(1);
const PIPE_RETRY_MAX: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub version: String,
    pub exe: String,
}

fn user_suffix() -> String {
    let username = std::env::var("USERNAME").unwrap_or_default();
    let isolated = std::env::var("CZ_USERDATA").ok();
    let suffix = instance_suffix(&username, isolated.as_deref());
    // Unit-test pipe listeners must never exchange handover messages with the real app.
    if cfg!(test) {
        format!("{suffix}.test.{}", std::process::id())
    } else {
        suffix
    }
}

fn instance_suffix(username: &str, isolated_dir: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let user: String = username.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    match isolated_dir.filter(|p| !p.is_empty()) {
        Some(dir) => format!("{user}.isolated.{:x}", Sha256::digest(dir.as_bytes())),
        None => user,
    }
}

fn mutex_name() -> String {
    format!("Local\\CrosshairZ.Instance.{}", user_suffix())
}

fn pipe_name() -> String {
    format!("\\\\.\\pipe\\CrosshairZ.Instance.{}", user_suffix())
}

/// Held for the process lifetime; releasing it lets another instance start.
pub struct InstanceGuard(HANDLE);

// Windows handles are process-wide; the guard only closes it on drop.
unsafe impl Send for InstanceGuard {}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// A `CreateMutexW` failure that still proves another instance exists: access denied means the
/// mutex is there but was created with other rights (an elevated instance, for example).
fn mutex_error_means_running(code: HRESULT) -> bool {
    code == E_ACCESSDENIED
}

/// Wait before creating the instance pipe again after `attempt` failures in a row.
fn pipe_retry_delay(attempt: u32) -> Duration {
    PIPE_RETRY_FIRST.saturating_mul(2u32.saturating_pow(attempt)).min(PIPE_RETRY_MAX)
}

/// `None` when another instance already holds the mutex.
pub fn acquire() -> Option<InstanceGuard> {
    unsafe {
        match CreateMutexW(None, true, &HSTRING::from(mutex_name())) {
            Ok(h) => {
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = CloseHandle(h);
                    None
                } else {
                    Some(InstanceGuard(h))
                }
            }
            Err(err) if mutex_error_means_running(err.code()) => {
                logger::info("single-instance mutex not accessible, another instance is running", json!({"error": err.to_string()}));
                None
            }
            Err(err) => {
                // Without a mutex we cannot tell; running is better than refusing to start.
                logger::error("single-instance mutex failed, continuing", json!({"error": err.to_string()}));
                Some(InstanceGuard(HANDLE::default()))
            }
        }
    }
}

/// After a "handover" answer: wait until the old instance released the mutex, then own it.
pub fn take_over() -> Option<InstanceGuard> {
    let end = Instant::now() + TAKEOVER_TIMEOUT;
    while Instant::now() < end {
        if let Some(g) = acquire() {
            return Some(g);
        }
        std::thread::sleep(TAKEOVER_POLL);
    }
    logger::error("previous instance did not quit in time", None);
    None
}

/// Second instance: tell the running one who we are. True when it hands over to us.
pub fn notify_running(hello: &Hello) -> bool {
    let Ok(body) = serde_json::to_vec(hello) else { return false };
    unsafe {
        let h = match CreateFileW(&HSTRING::from(pipe_name()), GENERIC_READ.0 | GENERIC_WRITE.0, FILE_SHARE_NONE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None) {
            Ok(h) => h,
            Err(err) => {
                logger::warn("running instance not reachable", json!({"error": err.to_string()}));
                return false;
            }
        };
        let mut handover = false;
        match WriteFile(h, Some(&body), None, None) {
            Err(err) => logger::warn("handover message not sent", json!({"error": err.to_string()})),
            Ok(()) => {
                let mut buf = [0u8; 16];
                let mut read = 0u32;
                if ReadFile(h, Some(&mut buf), Some(&mut read), None).is_ok() {
                    handover = &buf[..read as usize] == REPLY_HANDOVER;
                }
            }
        }
        let _ = CloseHandle(h);
        handover
    }
}

/// Running instance: answer hellos forever on a background thread. `on_hello` returns true to
/// hand over (this instance will quit).
pub fn listen(on_hello: Box<dyn Fn(Hello) -> bool + Send>) {
    let spawned = std::thread::Builder::new().name("instance-pipe".into()).spawn(move || unsafe {
        let mut failures: u32 = 0;
        loop {
            let pipe = CreateNamedPipeW(
                &HSTRING::from(pipe_name()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER,
                PIPE_BUFFER,
                0,
                None,
            );
            if pipe == INVALID_HANDLE_VALUE {
                if failures == 0 {
                    let error = windows::core::Error::from_win32().to_string();
                    logger::error("instance pipe unavailable, retrying; second starts cannot hand over meanwhile", json!({"error": error}));
                }
                std::thread::sleep(pipe_retry_delay(failures));
                failures = failures.saturating_add(1);
                continue;
            }
            if failures > 0 {
                logger::info("instance pipe available again", json!({"failedAttempts": failures}));
                failures = 0;
            }
            let connected = ConnectNamedPipe(pipe, None).is_ok() || GetLastError() == ERROR_PIPE_CONNECTED;
            if connected {
                let mut buf = vec![0u8; MAX_MESSAGE];
                let mut read = 0u32;
                if ReadFile(pipe, Some(&mut buf), Some(&mut read), None).is_ok() {
                    let handover = match serde_json::from_slice::<Hello>(&buf[..read as usize]) {
                        Ok(hello) => on_hello(hello),
                        Err(err) => {
                            logger::warn("bad handover message", json!({"error": err.to_string()}));
                            false
                        }
                    };
                    let _ = WriteFile(pipe, Some(if handover { REPLY_HANDOVER } else { REPLY_STAY }), None, None);
                    let _ = FlushFileBuffers(pipe);
                }
            }
            let _ = DisconnectNamedPipe(pipe);
            let _ = CloseHandle(pipe);
        }
    });
    if let Err(err) = spawned {
        logger::error("instance pipe thread failed", json!({"error": err.to_string()}));
    }
}

pub fn current_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_default()
}

/// What this process tells a running instance.
pub fn own_hello() -> Hello {
    Hello { version: env!("CARGO_PKG_VERSION").to_string(), exe: current_exe().display().to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn isolated_data_directories_have_separate_instance_endpoints() {
        let normal = instance_suffix("User", None);
        let first = instance_suffix("User", Some("C:/isolated-a"));
        let second = instance_suffix("User", Some("C:/isolated-b"));
        assert_eq!(normal, "User");
        assert_ne!(normal, first);
        assert_ne!(first, second);
        assert_eq!(first, instance_suffix("User", Some("C:/isolated-a")));
    }

    #[test]
    fn access_denied_mutex_counts_as_running() {
        use windows::Win32::Foundation::E_FAIL;
        assert!(mutex_error_means_running(E_ACCESSDENIED), "a mutex we may not open belongs to a running instance");
        assert!(!mutex_error_means_running(E_FAIL));
    }

    #[test]
    fn pipe_retry_backoff() {
        let secs: Vec<u64> = [0, 1, 5, 6, 20].into_iter().map(|attempt| pipe_retry_delay(attempt).as_secs()).collect();
        assert_eq!(secs, [1, 2, 32, 60, 60]);
        assert_eq!(pipe_retry_delay(u32::MAX), Duration::from_secs(60));
    }

    #[test]
    fn hello_and_reply_over_pipe() {
        let (tx, rx) = mpsc::channel();
        listen(Box::new(move |h| {
            let newer = h.version == "9.9.9";
            let _ = tx.send(h);
            newer
        }));
        let hello = Hello { version: "9.9.9".into(), exe: "C:\\x\\Crosshair-Z.exe".into() };
        // the server thread needs a moment to create the pipe
        let mut got = None;
        let mut handover = false;
        for _ in 0..50 {
            handover = notify_running(&hello);
            if let Ok(h) = rx.recv_timeout(Duration::from_millis(100)) {
                got = Some(h);
                break;
            }
        }
        assert_eq!(got, Some(hello));
        assert!(handover, "server answered handover");
        assert!(!notify_running(&Hello { version: "0.0.1".into(), exe: "x".into() }), "server answered stay");
    }
}
