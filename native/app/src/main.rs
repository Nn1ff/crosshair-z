#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::mpsc;

use crosshair_z::app::{self, App, AppEvent, IpcBridge};
use crosshair_z::overlay::monitors;
use crosshair_z::sprites::renderer::{self, SpriteRenderer};
use crosshair_z::{instance, logger, paths, tray};
use serde_json::json;
use tauri::Manager;

/// Tray icon @2x from 150 % primary scale (Electron picked tray@2x by DPI the same way).
const HIDPI_TRAY_PERCENT: u32 = 150;

fn main() {
    logger::init(&paths::logs_dir());
    logger::info("boot", json!({"version": env!("CARGO_PKG_VERSION"), "dataDir": paths::data_dir().display().to_string()}));
    std::panic::set_hook(Box::new(|info| logger::error("panic", json!({"info": info.to_string()}))));

    let Some(_instance) = instance::acquire() else {
        logger::info("another instance is running, exiting", None);
        return;
    };

    let (tx, rx) = mpsc::channel::<AppEvent>();
    let app_tx = tx.clone();
    let window_tx = tx.clone();
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app::cz_invoke,
            renderer::sprite_jobs,
            renderer::sprite_result,
            renderer::sprite_failed,
            renderer::sprite_idle
        ])
        .on_window_event(move |window, event| {
            if window.label() != app::SETTINGS_LABEL {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window_tx.send(AppEvent::SettingsCloseRequested);
                }
                tauri::WindowEvent::Destroyed => {
                    let _ = window_tx.send(AppEvent::SettingsClosed);
                }
                _ => {}
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let render_tx = app_tx.clone();
            let sprite_renderer = SpriteRenderer::new(
                handle.clone(),
                paths::webview_dir(),
                Box::new(move |ev| {
                    let _ = render_tx.send(AppEvent::Render(ev));
                }),
            );
            app.manage(sprite_renderer.clone());
            app.manage(IpcBridge(app_tx.clone()));

            let mut core = App::new(handle.clone(), app_tx.clone(), sprite_renderer).inspect_err(|e| logger::error("app start failed", json!({"error": e})))?;
            let hidpi = monitors::list().iter().find(|m| m.primary).is_some_and(|m| m.scale_percent >= HIDPI_TRAY_PERCENT);
            match tray::Tray::create(&handle, core.config(), app_tx.clone(), hidpi) {
                Ok(t) => core.set_tray(Some(t)),
                Err(err) => logger::error("tray creation failed", json!({"error": err.to_string()})),
            }
            std::thread::Builder::new().name("app".into()).spawn(move || core.run(rx))?;
            Ok(())
        })
        .build(tauri::generate_context!());

    match result {
        Ok(app) => app.run(|_app, event| {
            // Tray app: stay alive with zero windows (the renderer webview comes and goes).
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        }),
        Err(err) => logger::error("tauri failed to start", json!({"error": err.to_string()})),
    }
    drop(tx);
}

