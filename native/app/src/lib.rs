//! Crosshair Z native runtime. All logic lives here (unit-tested); `main.rs` only boots Tauri.

pub mod logger;
pub mod paths;
pub mod config;
pub mod state;
pub mod sprites;
pub mod overlay;
pub mod input;
pub mod app;
pub mod instance;
pub mod tray;
pub mod clipboard;
pub mod system;
pub mod updater;
