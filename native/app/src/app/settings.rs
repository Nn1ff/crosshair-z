//! The settings window: shared `src/renderer/settings.html` in WebView2 with `bridge.js` as
//! `window.cz`. Created on demand and destroyed on close, so in-game only the overlay remains.

use std::time::Duration;

use serde_json::json;
use tauri::webview::Color;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use super::{App, AppEvent};
use crate::{logger, paths};

pub const LABEL: &str = "settings";
const PAGE: &str = "src/renderer/settings.html";
const BRIDGE_JS: &str = include_str!("../../../../src/native/bridge.js");
const WIDTH: f64 = 1240.0;
const HEIGHT: f64 = 800.0;
const MIN_WIDTH: f64 = 1000.0;
const MIN_HEIGHT: f64 = 640.0;
const BACKGROUND: Color = Color(0x19, 0x1c, 0x22, 0xff); // settings.css --bg, no white flash
const CLOSE_GRACE: Duration = Duration::from_secs(3);

/// A delayed fallback close belongs only to the request that scheduled it.
#[derive(Default)]
pub(super) struct CloseGuard {
    next: u64,
    pending: Option<u64>,
}

impl CloseGuard {
    pub(super) fn request(&mut self) -> u64 {
        self.next = self.next.wrapping_add(1);
        self.pending = Some(self.next);
        self.next
    }

    pub(super) fn invalidate(&mut self) {
        self.pending = None;
    }

    pub(super) fn consume(&mut self, request: u64) -> bool {
        if self.pending != Some(request) {
            return false;
        }
        self.pending = None;
        true
    }
}

/// Only the app's own pages may load in the settings webview.
pub fn allowed_url(url: &tauri::Url) -> bool {
    matches!(url.host_str(), Some("tauri.localhost")) || url.scheme() == "tauri"
}

impl App {
    pub(super) fn open_settings(&mut self) {
        if let Some(w) = self.handle.get_webview_window(LABEL) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let result = WebviewWindowBuilder::new(&self.handle, LABEL, WebviewUrl::App(PAGE.into()))
            .title("Crosshair Z")
            .inner_size(WIDTH, HEIGHT)
            .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
            .decorations(false)
            .background_color(BACKGROUND)
            .initialization_script(BRIDGE_JS)
            .data_directory(paths::webview_dir())
            .on_navigation(|url| {
                let ok = allowed_url(url);
                if !ok {
                    logger::warn("settings navigation blocked", json!({"url": url.as_str()}));
                }
                ok
            })
            .focused(true)
            .build();
        match result {
            Ok(_) => {
                self.settings_close_guard.invalidate();
                self.settings_open = true;
                self.renderer.set_keep_alive(true);
                logger::info("settings window opened", None);
            }
            Err(err) => logger::error("settings window could not open (WebView2 missing?)", json!({"error": err.to_string()})),
        }
    }

    /// Close button / Alt+F4: the page flushes pending edits, then calls `window:close`.
    pub(super) fn request_close_settings(&mut self) {
        let Some(w) = self.handle.get_webview_window(LABEL) else { return };
        if let Err(err) = w.eval("window.czRequestClose ? window.czRequestClose() : window.cz.invoke('window:close')") {
            logger::warn("settings close request failed, closing directly", json!({"error": err.to_string()}));
            self.close_settings_now();
            return;
        }
        let request = self.settings_close_guard.request();
        let tx = self.events.clone();
        let _ = std::thread::Builder::new().name("settings-close-grace".into()).spawn(move || {
            std::thread::sleep(CLOSE_GRACE);
            let _ = tx.send(AppEvent::ForceCloseSettings(request));
        });
    }

    pub(super) fn close_settings_now(&mut self) {
        self.settings_close_guard.invalidate();
        if let Some(w) = self.handle.get_webview_window(LABEL) {
            if let Err(err) = w.destroy() {
                logger::error("settings window destroy failed", json!({"error": err.to_string()}));
            }
        }
    }

    pub(super) fn on_settings_closed(&mut self) {
        self.settings_close_guard.invalidate();
        if !self.settings_open {
            return;
        }
        self.settings_open = false;
        self.renderer.set_keep_alive(false);
        if self.hotkeys_suspended {
            // closed while recording a hotkey: never leave hotkeys off
            self.hotkeys_suspended = false;
            self.register_hotkeys();
        }
        self.store.flush();
        logger::info("settings window closed", None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_close_timeout_does_not_close_reopened_settings() {
        let mut guard = CloseGuard::default();
        let old = guard.request();
        guard.invalidate(); // the page confirmed close
        guard.invalidate(); // a new settings window opened
        assert!(!guard.consume(old));
        let current = guard.request();
        assert!(!guard.consume(old));
        assert!(guard.consume(current), "a hung page still closes after its own grace period");
        assert!(!guard.consume(current), "the timeout only closes once");
    }

    #[test]
    fn only_app_urls_allowed() {
        assert!(allowed_url(&"http://tauri.localhost/src/renderer/settings.html".parse().unwrap()));
        assert!(!allowed_url(&"https://example.com/".parse().unwrap()));
        assert!(!allowed_url(&"file:///C:/x.html".parse().unwrap()));
    }
}
