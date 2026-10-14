//! Autostart and update hooks used by the settings IPC. Filled in by the updater/autostart work.

use serde_json::Value;

use super::ipc::IpcResult;
use super::App;
use crate::logger;

impl App {
    pub(super) fn apply_login_item(&mut self) {
        logger::info("autostart change requested", serde_json::json!({"launchAtLogin": self.store.get().launch_at_login}));
    }

    pub(super) fn on_check_updates_enabled(&mut self) {}

    pub(super) fn update_command(&mut self, channel: &str) -> IpcResult {
        logger::info("update command", serde_json::json!({"channel": channel}));
        Ok(Value::Null)
    }
}
