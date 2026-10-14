//! One running Crosshair Z per user session (named mutex). The 1.x handover protocol and legacy
//! Electron cleanup come with the updater work (Plan 4).

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

use crate::logger;

/// Held for the process lifetime; releasing it lets another instance start.
pub struct InstanceGuard(HANDLE);

// The mutex handle is only closed on drop; Windows handles are process-wide.
unsafe impl Send for InstanceGuard {}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// `None` when another instance already holds the mutex.
pub fn acquire() -> Option<InstanceGuard> {
    unsafe {
        match CreateMutexW(None, true, w!("Local\\CrosshairZ.Instance")) {
            Ok(h) => {
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = CloseHandle(h);
                    None
                } else {
                    Some(InstanceGuard(h))
                }
            }
            Err(err) => {
                // Without a mutex we cannot tell; running is better than refusing to start.
                logger::error("single-instance mutex failed, continuing", serde_json::json!({"error": err.to_string()}));
                Some(InstanceGuard(HANDLE::default()))
            }
        }
    }
}
