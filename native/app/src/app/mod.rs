//! The app thread: the single owner of config, runtime state, sprite cache and the overlay.
//! Every input (hotkey, mouse, tray, renderer, display change) arrives as an `AppEvent`.

use std::collections::{BTreeMap, HashSet};
mod ipc;
mod settings;
mod updates;

pub use updates::integrates_with_system;

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::config::{ConfigStore, Defaults, HOTKEY_ACTIONS};
use crate::input::hotkeys::{Hotkeys, Status};
use crate::input::mouse::MousePoller;
use crate::logger;
use crate::overlay::monitors::{self, Monitor};
use crate::overlay::window::OverlayWindow;
use crate::overlay::Overlay;
use crate::paths;
use crate::sprites::cache::{cache_key, SpriteCache};
use crate::sprites::codec::SpriteSet;
use crate::sprites::renderer::{Job, RenderEvent, SpriteRenderer};
use crate::state::{self, Buttons, Runtime};
use crate::tray::Tray;

pub enum AppEvent {
    Hotkey(String),
    Mouse { now: Buttons, prev: Buttons },
    TrayToggle,
    TrayEquip(String),
    Render(RenderEvent),
    DisplaysChanged,
    /// settings page request (bridge.js → cz_invoke)
    Ipc { channel: String, payload: Value, reply: Sender<ipc::IpcResult> },
    OpenSettings,
    InstallUpdate,
    CheckUpdates,
    Housekeeping,
    Update(updates::UpdateEvent),
    /// another start of the exe; reply true = hand over and quit
    SecondInstance { hello: crate::instance::Hello, reply: Sender<bool> },
    /// user closed the settings window: let the page flush first
    SettingsCloseRequested,
    /// the page did not answer the close request in time
    ForceCloseSettings(u64),
    SettingsClosed,
    Quit,
}

const IPC_TIMEOUT: Duration = Duration::from_secs(30);

/// Managed state for `cz_invoke`.
pub struct IpcBridge(pub Sender<AppEvent>);

pub use settings::LABEL as SETTINGS_LABEL;

/// The one command behind `window.cz.invoke(channel, payload)`; answered on the app thread.
#[tauri::command]
pub async fn cz_invoke(channel: String, payload: Value, bridge: State<'_, IpcBridge>) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    bridge.0.send(AppEvent::Ipc { channel, payload, reply: tx }).map_err(|_| "app is shutting down".to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(IPC_TIMEOUT).map_err(|_| "app did not answer".to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

const PROFILE_HOTKEY_PREFIX: &str = "profile:";

/// Everything the tray menu shows.
fn tray_signature(c: &crate::config::Config) -> String {
    let names: Vec<&str> = c.profiles.iter().map(|p| p.name.as_str()).collect();
    format!("{}|{}|{}", c.enabled, c.active_profile_id, names.join(""))
}

pub struct App {
    handle: AppHandle,
    events: Sender<AppEvent>,
    store: ConfigStore,
    rt: Runtime,
    cache: SpriteCache,
    overlay: Overlay,
    _window: OverlayWindow,
    hotkeys: Option<Hotkeys>,
    hotkey_status: BTreeMap<String, Status>,
    mouse: Option<MousePoller>,
    renderer: Arc<SpriteRenderer>,
    tray: Option<Tray>,
    monitors: Vec<Monitor>,
    /// keys whose rendering gave up: show the fallback instead of retrying forever
    failed: HashSet<String>,
    fallback: Arc<SpriteSet>,
    /// what the tray menu currently shows; rebuilt only when this changes (not on every right-click)
    tray_sig: String,
    hotkeys_suspended: bool,
    settings_open: bool,
    settings_close_guard: settings::CloseGuard,
    update: updates::UpdateState,
}

impl App {
    pub fn new(handle: AppHandle, events: Sender<AppEvent>, renderer: Arc<SpriteRenderer>) -> Result<App, String> {
        let store = ConfigStore::open(&paths::data_dir(), Defaults::embedded());
        if store.is_new {
            store.flush(); // only the very first start counts as first
        }
        let rt = Runtime { launch_hidden: store.get().hide_on_launch, ..Default::default() };
        let display_tx = events.clone();
        let window = OverlayWindow::spawn(Box::new(move || {
            let _ = display_tx.send(AppEvent::DisplaysChanged);
        }))?;
        let overlay = Overlay::spawn(Box::new(window.handle()));
        let hk_tx = events.clone();
        let hotkeys = Hotkeys::spawn(Box::new(move |key| {
            let _ = hk_tx.send(AppEvent::Hotkey(key));
        }))
        .map_err(|e| logger::error("hotkeys unavailable", json!({"error": e})))
        .ok();
        Ok(App {
            handle,
            events,
            store,
            rt,
            cache: SpriteCache::new(&paths::sprites_dir()),
            overlay,
            _window: window,
            hotkeys,
            hotkey_status: BTreeMap::new(),
            mouse: None,
            renderer,
            tray: None,
            monitors: monitors::list(),
            failed: HashSet::new(),
            fallback: Arc::new(SpriteSet::fallback()),
            tray_sig: String::new(),
            hotkeys_suspended: false,
            settings_open: false,
            settings_close_guard: settings::CloseGuard::default(),
            update: updates::UpdateState::default(),
        })
    }

    pub fn config(&self) -> &crate::config::Config {
        self.store.get()
    }

    pub fn set_tray(&mut self, tray: Option<Tray>) {
        self.tray = tray;
    }

    /// Process events until Quit.
    pub fn run(mut self, rx: Receiver<AppEvent>) {
        self.register_hotkeys();
        self.apply();
        self.prewarm();
        // very first start always opens the window so new users can customize right away
        let hidden = !self.store.is_new && (std::env::args().any(|a| a == "--hidden") || self.store.get().start_hidden);
        if !hidden {
            self.open_settings();
        }
        self.start_background_tasks();
        logger::info("app ready", json!({"profiles": self.store.get().profiles.len(), "monitors": self.monitors.len()}));
        while let Ok(ev) = rx.recv() {
            if !self.handle_event(ev) {
                break;
            }
        }
        self.store.flush();
        logger::info("app loop finished", None);
        self.handle.exit(0);
    }

    fn handle_event(&mut self, ev: AppEvent) -> bool {
        match ev {
            AppEvent::Quit => return false,
            AppEvent::Hotkey(key) => self.on_hotkey(&key),
            AppEvent::Mouse { now, prev } => {
                let out = state::on_mouse(self.store.get(), &mut self.rt, now, prev);
                if let Some(on) = out.firing {
                    self.overlay.set_firing(on);
                }
                if out.relayout {
                    self.apply();
                }
            }
            AppEvent::TrayToggle => {
                let rt = &mut self.rt;
                self.store.update(|c| state::tray_toggle_enabled(c, rt));
                self.changed();
            }
            AppEvent::TrayEquip(id) => self.equip(&id),
            AppEvent::Render(RenderEvent::Done { key, bytes }) => match self.cache.put(&key, &bytes) {
                Ok(_) => {
                    self.failed.remove(&key);
                    self.apply();
                }
                Err(err) => {
                    logger::error("rendered sprites invalid", json!({"error": err.to_string()}));
                    self.failed.insert(key);
                    self.apply();
                }
            },
            AppEvent::Render(RenderEvent::Failed { key, error }) => {
                logger::error("crosshair could not be rendered, showing fallback", json!({"error": error}));
                self.failed.insert(key);
                self.apply();
            }
            AppEvent::Ipc { channel, payload, reply } => {
                let result = self.ipc(&channel, payload);
                if let Err(err) = &result {
                    logger::error(&format!("ipc {channel} failed"), json!({"error": err}));
                }
                let _ = reply.send(result);
            }
            AppEvent::OpenSettings => self.open_settings(),
            AppEvent::InstallUpdate => self.install_update(),
            AppEvent::CheckUpdates => self.run_update_check(),
            AppEvent::Housekeeping => self.housekeeping(),
            AppEvent::Update(ev) => self.on_update_event(ev),
            AppEvent::SecondInstance { hello, reply } => {
                let handover = self.on_second_instance(&hello);
                let _ = reply.send(handover);
                if handover {
                    return false;
                }
            }
            AppEvent::SettingsCloseRequested => self.request_close_settings(),
            AppEvent::ForceCloseSettings(request) => {
                if self.settings_open && self.settings_close_guard.consume(request) {
                    logger::warn("settings page did not confirm close, closing anyway", None);
                    self.close_settings_now();
                }
            }
            AppEvent::SettingsClosed => self.on_settings_closed(),
            AppEvent::DisplaysChanged => {
                self.monitors = monitors::list();
                logger::info("displays changed", json!({"count": self.monitors.len()}));
                self.apply();
            }
        }
        true
    }

    fn equip(&mut self, id: &str) {
        if self.store.get().profile(id).is_none() {
            logger::warn("equip of unknown profile ignored", json!({"id": id}));
            return;
        }
        let rt = &mut self.rt;
        self.store.update(|c| state::equip(c, rt, id));
        self.changed();
    }

    fn on_hotkey(&mut self, key: &str) {
        if let Some(id) = key.strip_prefix(PROFILE_HOTKEY_PREFIX) {
            let id = id.to_string();
            self.equip(&id);
            return;
        }
        let rt = &mut self.rt;
        match key {
            "toggle" => {
                let mut next = self.store.get().clone();
                let changed = state::keyboard_toggle(&mut next, rt);
                if changed {
                    self.store.set(next); // switch-mode toggles only change runtime state
                }
                logger::info("keyboard toggle", json!({"enabled": self.store.get().enabled, "alt": self.rt.kb_alt, "saved": changed}));
                self.emit("runtime:changed", self.runtime_value());
            }
            "next" => {
                self.store.update(|c| state::cycle_profile(c, rt, 1));
            }
            "prev" => {
                self.store.update(|c| state::cycle_profile(c, rt, -1));
            }
            "moveUp" | "moveDown" | "moveLeft" | "moveRight" => {
                let (dx, dy) = match key {
                    "moveUp" => (0, -1),
                    "moveDown" => (0, 1),
                    "moveLeft" => (-1, 0),
                    _ => (1, 0),
                };
                self.store.update(|c| state::move_crosshair(c, dx, dy));
            }
            "settings" => self.open_settings(),
            other => logger::warn("unknown hotkey action", json!({"key": other})),
        }
        self.changed();
    }

    /// After any config change (main.js `broadcast`).
    fn changed(&mut self) {
        self.apply();
        self.prewarm();
        self.emit("config:changed", self.store.get().to_value());
    }

    /// Push an event to the settings page (if open).
    fn emit(&self, event: &str, payload: Value) {
        if self.settings_open {
            if let Err(err) = self.handle.emit_to(settings::LABEL, event, payload) {
                logger::warn("emit to settings failed", json!({"event": event, "error": err.to_string()}));
            }
        }
    }

    fn register_hotkeys(&mut self) {
        let Some(hk) = self.hotkeys.as_ref() else { return };
        if self.hotkeys_suspended {
            hk.register(Vec::new()); // recording a new hotkey in settings: nothing may fire
            return;
        }
        let c = self.store.get();
        let mut bindings: Vec<(String, String)> = HOTKEY_ACTIONS.iter().map(|a| (a.to_string(), c.hotkeys.get(a).unwrap_or("").to_string())).collect();
        bindings.extend(c.profiles.iter().filter(|p| !p.hotkey.is_empty()).map(|p| (format!("{PROFILE_HOTKEY_PREFIX}{}", p.id), p.hotkey.clone())));
        self.hotkey_status = hk.register(bindings);
        let problems: Vec<String> = self.hotkey_status.iter().filter(|(_, s)| !matches!(s, Status::Ok | Status::Empty)).map(|(k, s)| format!("{k}={s:?}")).collect();
        if !problems.is_empty() {
            logger::warn("some hotkeys not registered", json!({"problems": problems}));
        }
        self.emit("hotkeys:status", self.hotkey_status_value());
    }

    fn sprites_for(&mut self, crosshair: &serde_json::Value, scale: f64) -> Option<Arc<SpriteSet>> {
        let key = cache_key(crosshair, scale);
        if let Some(set) = self.cache.get(&key) {
            return Some(set);
        }
        if self.failed.contains(&key) {
            return Some(self.fallback.clone());
        }
        self.renderer.request(Job { key, crosshair: crosshair.clone(), scale });
        None
    }

    /// Show what the config + runtime say (main.js `layoutOverlay` + tray + mouse polling).
    fn apply(&mut self) {
        let c = self.store.get().clone();
        let (visible, profile) = state::effective(&c, &self.rt);
        let crosshair = profile.crosshair.clone();
        if let Some(set) = self.sprites_for(&crosshair, c.display.scale) {
            match monitors::pick(&self.monitors, c.display.monitor_id) {
                Some(m) => {
                    let (x, y) = monitors::layout(m, c.display.offset_x, c.display.offset_y, set.size_px);
                    self.overlay.set_sprites(set, x, y);
                }
                None => logger::error("no monitor found, overlay not placed", None),
            }
        }
        // until new sprites arrive the previous crosshair stays (no flash of nothing)
        self.overlay.set_visible(visible);
        self.refresh_tray();
        self.update_mouse_polling(&c);
    }

    /// Rebuild the tray menu only when what it shows changed (not on every right-click).
    fn refresh_tray(&mut self) {
        let c = self.store.get();
        let update = (self.update.status == updates::UpdateStatus::Available).then(|| self.update.release.as_ref().map(|r| r.version.clone())).flatten();
        let sig = format!("{}|{}", tray_signature(c), update.as_deref().unwrap_or(""));
        if sig != self.tray_sig {
            if let Some(t) = self.tray.as_ref() {
                t.refresh(c, update.as_deref());
            }
            self.tray_sig = sig;
        }
    }

    fn update_mouse_polling(&mut self, c: &crate::config::Config) {
        let need = state::needs_mouse(c);
        match (need, self.mouse.is_some()) {
            (true, false) => {
                let tx = self.events.clone();
                self.mouse = Some(MousePoller::start(Box::new(move |now, prev| {
                    let _ = tx.send(AppEvent::Mouse { now, prev });
                })));
            }
            (false, true) => {
                self.mouse = None;
                self.rt.rc_alt = false;
                if self.rt.firing {
                    self.rt.firing = false;
                    self.overlay.set_firing(false);
                }
            }
            _ => {}
        }
    }

    /// Render sprites of every profile that can appear without settings, keep only those in RAM.
    fn prewarm(&mut self) {
        let c = self.store.get().clone();
        let mut keep = HashSet::new();
        for id in state::relevant_profile_ids(&c) {
            if let Some(p) = c.profile(&id) {
                keep.insert(cache_key(&p.crosshair, c.display.scale));
                let _ = self.sprites_for(&p.crosshair, c.display.scale);
            }
        }
        self.cache.retain_mem(&keep);
    }
}
