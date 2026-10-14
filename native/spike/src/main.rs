mod overlay;

use std::io::BufRead;
use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "w1";

static OPENED_AT: Mutex<Option<Instant>> = Mutex::new(None);

#[tauri::command]
fn ready() {
    let started = OPENED_AT.lock().unwrap().take();
    match started {
        Some(t) => println!("[js] ready after {} ms", t.elapsed().as_millis()),
        None => println!("[js] ready"),
    }
}

fn open_webview(app: &AppHandle, visible: bool) {
    if app.get_webview_window(LABEL).is_some() {
        println!("already open");
        return;
    }
    *OPENED_AT.lock().unwrap() = Some(Instant::now());
    let result = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("cz-spike")
        .visible(visible)
        .build();
    if let Err(err) = result {
        println!("open failed: {err}");
    }
}

fn close_webview(app: &AppHandle) {
    match app.get_webview_window(LABEL) {
        Some(w) => match w.destroy() {
            Ok(()) => println!("destroyed at {:?}", Instant::now()),
            Err(err) => println!("destroy failed: {err}"),
        },
        None => println!("nothing open"),
    }
}

/// Commands from the console; runs on its own thread, Tauri marshals window calls to the main thread.
fn stdin_loop(app: AppHandle) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        match line.trim() {
            "open" => open_webview(&app, true),
            "hidden" => open_webview(&app, false),
            "close" => close_webview(&app),
            "overlay" => overlay::spawn(),
            "quit" => app.exit(0),
            "" => {}
            other => println!("unknown command: {other}"),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ready])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || stdin_loop(handle));
            println!("cz-spike ready: open | hidden | close | overlay | quit");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
