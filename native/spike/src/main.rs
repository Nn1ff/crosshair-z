#[tauri::command]
fn ready() {
    println!("[js] ready");
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ready])
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|_app, event| {
            // Tray-style app: stay alive with zero windows; only an explicit exit(code) ends it.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
