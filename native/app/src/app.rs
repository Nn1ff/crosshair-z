//! The app thread: the single owner of config, runtime state, sprite cache and the overlay.
//! Every input (hotkey, mouse, tray, renderer, display change) arrives as an `AppEvent`.

use std::collections::{BTreeMap, HashSet};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;

use serde_json::json;
use tauri::AppHandle;

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
    Quit,
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
            "settings" => logger::info("settings hotkey: settings window not available yet", None),
            other => logger::warn("unknown hotkey action", json!({"key": other})),
        }
        self.changed();
    }

    /// After any config change (main.js `broadcast`).
    fn changed(&mut self) {
        self.apply();
        self.prewarm();
    }

    fn register_hotkeys(&mut self) {
        let Some(hk) = self.hotkeys.as_ref() else { return };
        let c = self.store.get();
        let mut bindings: Vec<(String, String)> = HOTKEY_ACTIONS.iter().map(|a| (a.to_string(), c.hotkeys.get(a).unwrap_or("").to_string())).collect();
        bindings.extend(c.profiles.iter().filter(|p| !p.hotkey.is_empty()).map(|p| (format!("{PROFILE_HOTKEY_PREFIX}{}", p.id), p.hotkey.clone())));
        self.hotkey_status = hk.register(bindings);
        let problems: Vec<String> = self.hotkey_status.iter().filter(|(_, s)| !matches!(s, Status::Ok | Status::Empty)).map(|(k, s)| format!("{k}={s:?}")).collect();
        if !problems.is_empty() {
            logger::warn("some hotkeys not registered", json!({"problems": problems}));
        }
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
        let sig = tray_signature(&c);
        if sig != self.tray_sig {
            if let Some(t) = self.tray.as_ref() {
                t.refresh(&c);
            }
            self.tray_sig = sig;
        }
        self.update_mouse_polling(&c);
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
