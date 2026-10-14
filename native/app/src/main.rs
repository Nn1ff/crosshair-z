#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    crosshair_z::logger::init(&crosshair_z::paths::logs_dir());
    crosshair_z::logger::info("boot", None);
}
