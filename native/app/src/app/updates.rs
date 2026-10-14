//! Updates, autostart, Start Menu shortcut and handover (main.js `runUpdateCheck`, `installUpdate`,
//! `applyLoginItem`, `ensureStartMenuShortcut`, `onSecondInstance`). Network work runs on helper
//! threads and reports back as `AppEvent`s; the app thread owns the state.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use super::ipc::IpcResult;
use super::{App, AppEvent};
use crate::instance::{self, Hello};
use crate::updater::{self, Release};
use crate::{logger, paths, system};

pub const UPDATE_CHECK_DELAY: Duration = Duration::from_secs(5);
pub const UPDATE_HANDOVER_TIMEOUT: Duration = Duration::from_secs(30);
pub const UPDATE_CLEANUP_DELAY: Duration = Duration::from_secs(15);
const CURRENT: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateStatus {
    Idle,
    Checking,
    None,
    Available,
    Downloading,
    Launched,
    Error,
}

impl UpdateStatus {
    fn as_str(self) -> &'static str {
        match self {
            UpdateStatus::Idle => "idle",
            UpdateStatus::Checking => "checking",
            UpdateStatus::None => "none",
            UpdateStatus::Available => "available",
            UpdateStatus::Downloading => "downloading",
            UpdateStatus::Launched => "launched",
            UpdateStatus::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub struct UpdateState {
    pub status: UpdateStatus,
    pub release: Option<Release>,
    pub error: Option<String>,
}

impl Default for UpdateState {
    fn default() -> Self {
        UpdateState { status: UpdateStatus::Idle, release: None, error: None }
    }
}

/// Results of helper threads.
pub enum UpdateEvent {
    Checked(Option<Release>),
    Downloaded(Result<PathBuf, String>),
    HandoverTimeout,
}

/// Real installs only: dev builds and isolated test runs never touch autostart, shortcuts or
/// other running instances.
pub fn integrates_with_system() -> bool {
    !cfg!(debug_assertions) && !paths::is_isolated()
}

fn after(delay: Duration, tx: std::sync::mpsc::Sender<AppEvent>, ev: impl FnOnce() -> AppEvent + Send + 'static) {
    let _ = std::thread::Builder::new().name("delayed".into()).spawn(move || {
        std::thread::sleep(delay);
        let _ = tx.send(ev());
    });
}

impl App {
    pub(super) fn update_value(&self) -> Value {
        let u = &self.update;
        json!({"status": u.status.as_str(), "version": u.release.as_ref().map(|r| &r.version), "error": u.error, "current": CURRENT})
    }

    fn set_update(&mut self, status: UpdateStatus, error: Option<String>) {
        self.update.status = status;
        self.update.error = error;
        self.emit("runtime:changed", self.runtime_value());
        self.refresh_tray();
    }

    /// Boot-time housekeeping (after the overlay is up, so startup is never slowed down).
    pub(super) fn start_background_tasks(&mut self) {
        if self.store.get().check_updates {
            let tx = self.events.clone();
            after(UPDATE_CHECK_DELAY, tx, || AppEvent::CheckUpdates);
        }
        if !integrates_with_system() {
            logger::info("system integration skipped (dev build or isolated data dir)", None);
            return;
        }
        let exe = instance::current_exe();
        self.apply_login_item();
        system::ensure_start_menu_shortcut(&exe);
        let tx = self.events.clone();
        after(UPDATE_CLEANUP_DELAY, tx, || AppEvent::Housekeeping);
    }

    pub(super) fn housekeeping(&mut self) {
        let exe = instance::current_exe();
        if let Some(dir) = exe.parent() {
            updater::cleanup_old_versions(dir, CURRENT, &exe);
        }
        system::remove_electron_leftovers(&paths::data_dir());
    }

    pub(super) fn apply_login_item(&mut self) {
        if !integrates_with_system() {
            logger::info("login item untouched (dev build or isolated data dir)", None);
            return;
        }
        system::apply_login_item(self.store.get().launch_at_login, &instance::current_exe());
    }

    pub(super) fn on_check_updates_enabled(&mut self) {
        if matches!(self.update.status, UpdateStatus::Idle | UpdateStatus::Error) {
            self.run_update_check();
        }
    }

    pub(super) fn run_update_check(&mut self) {
        if matches!(self.update.status, UpdateStatus::Checking | UpdateStatus::Downloading | UpdateStatus::Launched) {
            return;
        }
        self.set_update(UpdateStatus::Checking, None);
        let tx = self.events.clone();
        let spawned = std::thread::Builder::new().name("update-check".into()).spawn(move || {
            let _ = tx.send(AppEvent::Update(UpdateEvent::Checked(updater::check_for_update(CURRENT))));
        });
        if spawned.is_err() {
            self.set_update(UpdateStatus::Error, Some("could not start update check".into()));
        }
    }

    /// Download the new exe next to the running one and start it; its handover quits this one.
    pub(super) fn install_update(&mut self) {
        let Some(release) = self.update.release.clone() else { return };
        if self.update.status == UpdateStatus::Downloading {
            return;
        }
        let dir = instance::current_exe().parent().map(PathBuf::from).unwrap_or_default();
        self.set_update(UpdateStatus::Downloading, None);
        let tx = self.events.clone();
        let spawned = std::thread::Builder::new().name("update-download".into()).spawn(move || {
            let _ = tx.send(AppEvent::Update(UpdateEvent::Downloaded(updater::download(&release, &dir))));
        });
        if spawned.is_err() {
            self.set_update(UpdateStatus::Error, Some("could not start download".into()));
        }
    }

    pub(super) fn on_update_event(&mut self, ev: UpdateEvent) {
        match ev {
            UpdateEvent::Checked(release) => {
                let status = if release.is_some() { UpdateStatus::Available } else { UpdateStatus::None };
                self.update.release = release;
                self.set_update(status, None);
            }
            UpdateEvent::Downloaded(Err(err)) => self.set_update(UpdateStatus::Error, Some(format!("Download failed: {err}"))),
            UpdateEvent::Downloaded(Ok(exe)) => match std::process::Command::new(&exe).spawn() {
                Ok(_) => {
                    logger::info("update launched, waiting for handover", json!({"exe": exe.display().to_string()}));
                    self.set_update(UpdateStatus::Launched, None);
                    after(UPDATE_HANDOVER_TIMEOUT, self.events.clone(), || AppEvent::Update(UpdateEvent::HandoverTimeout));
                }
                Err(err) => {
                    logger::error("update launch failed", json!({"exe": exe.display().to_string(), "error": err.to_string()}));
                    self.set_update(UpdateStatus::Error, Some(format!("Could not start the new version: {err}")));
                }
            },
            UpdateEvent::HandoverTimeout => {
                if self.update.status == UpdateStatus::Launched {
                    let version = self.update.release.as_ref().map(|r| r.version.clone()).unwrap_or_default();
                    logger::warn("update handover timed out", json!({"version": version}));
                    self.set_update(
                        UpdateStatus::Error,
                        Some(format!("Version {version} was saved next to this one but did not take over. Quit from the tray and start it.")),
                    );
                }
            }
        }
    }

    pub(super) fn update_command(&mut self, channel: &str) -> IpcResult {
        match channel {
            "update:check" => self.run_update_check(),
            _ => self.install_update(),
        }
        Ok(Value::Null)
    }

    /// Another Crosshair Z was started. A newer version takes over (true: this instance quits);
    /// otherwise the user just wanted the window.
    pub(super) fn on_second_instance(&mut self, hello: &Hello) -> bool {
        let newer = updater::compare_versions(&hello.version, CURRENT) > 0;
        if newer && PathBuf::from(&hello.exe).is_file() && system::mentions_cz_exe(&hello.exe) {
            logger::info("newer version launched, handing over", json!({"from": CURRENT, "to": hello.version, "exe": hello.exe}));
            self.store.flush();
            return true;
        }
        self.open_settings();
        false
    }
}

