//! Tray icon + menu (main.js `createTray` / `refreshTray`). Clicks become `AppEvent`s.

use std::sync::mpsc::Sender;

use serde_json::json;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::app::AppEvent;
use crate::config::Config;
use crate::logger;

const MAX_MENU_PROFILES: usize = 30;
const ID_TOGGLE: &str = "toggle";
const ID_QUIT: &str = "quit";
const ID_OPEN: &str = "open";
const PROFILE_PREFIX: &str = "profile:";
const ICON_1X: &[u8] = include_bytes!("../resources/tray.png");
const ICON_2X: &[u8] = include_bytes!("../resources/tray@2x.png");

/// Event mapping kept pure for tests.
pub fn event_for(menu_id: &str) -> Option<AppEvent> {
    match menu_id {
        ID_TOGGLE => Some(AppEvent::TrayToggle),
        ID_QUIT => Some(AppEvent::Quit),
        ID_OPEN => Some(AppEvent::OpenSettings),
        id => id.strip_prefix(PROFILE_PREFIX).map(|p| AppEvent::TrayEquip(p.to_string())),
    }
}

fn build_menu(app: &AppHandle, c: &Config) -> tauri::Result<Menu<Wry>> {
    let toggle = CheckMenuItem::with_id(app, ID_TOGGLE, "Show crosshair", true, c.enabled, None::<&str>)?;
    let profiles: Vec<CheckMenuItem<Wry>> = c
        .profiles
        .iter()
        .take(MAX_MENU_PROFILES)
        .map(|p| CheckMenuItem::with_id(app, format!("{PROFILE_PREFIX}{}", p.id), &p.name, true, p.id == c.active_profile_id, None::<&str>))
        .collect::<tauri::Result<_>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = profiles.iter().map(|p| p as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let crosshairs = Submenu::with_items(app, "Crosshairs", true, &refs)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let open = MenuItem::with_id(app, ID_OPEN, "Open Crosshair Z", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&toggle, &crosshairs, &sep, &open, &quit])
}

pub struct Tray {
    icon: TrayIcon<Wry>,
    app: AppHandle,
}

impl Tray {
    pub fn create(app: &AppHandle, c: &Config, events: Sender<AppEvent>, hidpi: bool) -> tauri::Result<Tray> {
        let image = Image::from_bytes(if hidpi { ICON_2X } else { ICON_1X })?;
        let menu = build_menu(app, c)?;
        let click_tx = events.clone();
        let icon = TrayIconBuilder::with_id("main")
            .icon(image)
            .tooltip("Crosshair Z")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(move |_tray, ev| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                    let _ = click_tx.send(AppEvent::OpenSettings);
                }
            })
            .on_menu_event(move |_app, ev: MenuEvent| {
                if let Some(e) = event_for(ev.id().as_ref()) {
                    if events.send(e).is_err() {
                        logger::error("tray event dropped: app loop gone", None);
                    }
                }
            })
            .build(app)?;
        Ok(Tray { icon, app: app.clone() })
    }

    pub fn refresh(&self, c: &Config) {
        match build_menu(&self.app, c) {
            Ok(menu) => {
                if let Err(err) = self.icon.set_menu(Some(menu)) {
                    logger::error("tray menu update failed", json!({"error": err.to_string()}));
                }
            }
            Err(err) => logger::error("tray menu build failed", json!({"error": err.to_string()})),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_ids_map_to_events() {
        assert!(matches!(event_for("toggle"), Some(AppEvent::TrayToggle)));
        assert!(matches!(event_for("quit"), Some(AppEvent::Quit)));
        assert!(matches!(event_for("open"), Some(AppEvent::OpenSettings)));
        assert!(matches!(event_for("profile:abc"), Some(AppEvent::TrayEquip(id)) if id == "abc"));
        assert!(event_for("other").is_none());
    }
}
