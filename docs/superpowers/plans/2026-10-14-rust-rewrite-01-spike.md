# Rust Rewrite — Plan 1: Feasibility Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the four go/no-go questions of the Rust rewrite with measurements before any production Rust code is written.

**Architecture:** A throwaway Tauri 2 app in `native/spike/` that can (a) open/destroy a visible or hidden WebView on command, (b) receive large raw-binary IPC payloads, and (c) show a native Win32 layered topmost overlay. A PowerShell script measures private working set of the process tree. Results go into a results doc that decides Plan 2.

**Tech Stack:** Rust stable (MSVC), Tauri 2, `windows` crate 0.61, WebView2 Evergreen, PowerShell 5.1.

**Spec:** `docs/superpowers/specs/2026-10-14-rust-rewrite-design.md` (section 8, step 1)

## Plan series

| Plan | Content | Written when |
|---|---|---|
| **1 (this)** | Feasibility spike, go/no-go | now |
| 2 | Core runtime: config store, state, sprite codec + cache, compositor, layered overlay, mouse thread, hotkeys, tray, logging, single instance | after spike GO; uses spike numbers |
| 3 | UI: `bridge.js`, IPC parity (19 invoke + 5 event channels), `sprite-export.js`, hidden renderer, golden image tests, CX scan | after Plan 2 |
| 4 | Updater, autostart, 1.8.x handover + legacy kill, Electron leftover cleanup, perf script, beta + 2.0.0 release, Electron removal | after Plan 3 |

## Global Constraints

- Spike code is throwaway: it lives only in `native/spike/` and is deleted in Plan 2. Nothing in `src/` changes.
- Target budget (spec §1): settings closed → all Crosshair Z processes ≤ 15 MB private working set, idle CPU ≈ 0 %.
- Exe budget ≤ 10 MB (spec §1); measured on the spike release build as a rough indicator only.
- Overlay window styles exactly: `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` (spec §4).
- Sprite transport is Tauri 2 raw IPC body (ArrayBuffer), no base64 (spec §4).
- Worst-case SpriteSet = 32 MB (spec §4 budget).
- Startup cache-miss target: crosshair ~1 s later (spec §4) → hidden WebView cold start must be well below that.
- All shell commands are PowerShell 5.1 unless marked otherwise; prepend `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"` in every new shell.

## Go/No-Go criteria

| ID | Question | GO if |
|---|---|---|
| A | Does WebView2 release its processes/RAM after the last webview is destroyed? | ≤ 10 s after destroy: no `msedgewebview2` process left in our tree **and** tree private WS ≤ 15 MB |
| B | Does a layered window stay above a borderless fullscreen game? | Visible above 2 different borderless games for 10 min including alt-tab, no flicker |
| C | Is raw IPC fast enough for sprites? | 32 MB upload JS → Rust < 500 ms |
| D | Is a hidden WebView cold start fast enough for cache misses? | create → page script running < 1,500 ms |

Fallback if A fails: settings/renderer run in a child process (`Crosshair-Z.exe --ui`) that exits when its window closes. Task 5 measures the lower bound for that fallback (host that never created a webview), so the decision can be made from this spike alone.

## Review Focus

1. WebView2 processes may not be direct children of our exe (broker / grandchildren) → the measure script must walk the full descendant tree, not just direct children (Task 2 test step).
2. Measuring "private bytes" instead of "private working set" would overstate RAM 2–3× and wrongly fail A → script must use `WorkingSetPrivate` (Task 2).
3. Overlay at DPI 125/150 % on a secondary monitor may be placed wrong or blurry → spike window must be per-monitor-DPI aware and tested on the user's actual display setup (Task 4 manual step).
4. Tauri exits when the last window closes, which would fake a perfect result in A → `ExitRequested` must be prevented and the process confirmed alive after destroy (Task 3 step).
5. First-ever WebView2 start is slower (profile creation) than later ones → D must be measured cold after deleting the spike data dir, not only warm (Task 5).

---

### Task 1: Toolchain and spike scaffold

**Files:**
- Create: `native/spike/Cargo.toml`
- Create: `native/spike/build.rs`
- Create: `native/spike/tauri.conf.json`
- Create: `native/spike/capabilities/default.json`
- Create: `native/spike/ui/index.html`
- Create: `native/spike/src/main.rs`
- Create: `native/spike/icons/` (generated)
- Modify: `.gitignore`

**Interfaces:**
- Produces: binary `cz-spike` that starts with zero windows and reads commands from stdin (extended in Tasks 3–5).

- [ ] **Step 1: Repair Rust toolchain**

`rustc` component is currently broken ("not applicable to the stable-x86_64-pc-windows-msvc toolchain").

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
rustup update stable
rustc --version
```
Expected: `rustc 1.9x.x (...)`. If it still fails:
```powershell
rustup toolchain uninstall stable
rustup toolchain install stable
rustc --version
```

- [ ] **Step 2: Install Tauri CLI**

```powershell
cargo install tauri-cli --version "^2" --locked
cargo tauri --version
```
Expected: `tauri-cli 2.x.x`.

- [ ] **Step 3: Write the crate files**

`native/spike/Cargo.toml`:
```toml
[package]
name = "cz-spike"
version = "0.0.0"
edition = "2021"
publish = false

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde_json = "1"
windows = { version = "0.61", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_System_LibraryLoader",
  "Win32_UI_HiDpi",
  "Win32_UI_WindowsAndMessaging",
] }

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

`native/spike/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`native/spike/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "cz-spike",
  "version": "0.0.0",
  "identifier": "com.crosshairz.spike",
  "build": { "frontendDist": "ui" },
  "app": {
    "withGlobalTauri": true,
    "windows": [],
    "security": { "csp": null }
  },
  "bundle": { "active": false, "icon": ["icons/icon.ico"] }
}
```

`native/spike/capabilities/default.json`:
```json
{
  "identifier": "default",
  "windows": ["*"],
  "permissions": ["core:default"]
}
```

`native/spike/ui/index.html`:
```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>cz-spike</title></head>
<body>
<p>cz-spike webview</p>
<script>
  window.__TAURI__.core.invoke('ready');
</script>
</body>
</html>
```

`native/spike/src/main.rs` (minimal; `ready` is extended in Task 3):
```rust
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
```

- [ ] **Step 4: Generate icons and ignore build output**

```powershell
cd native/spike
cargo tauri icon ../../assets/icon.png
cd ../..
Add-Content -Encoding utf8 .gitignore "`nnative/**/target/"
```
Expected: `native/spike/icons/icon.ico` exists.

- [ ] **Step 5: Build and run**

```powershell
cd native/spike
cargo build
.\target\debug\cz-spike.exe
```
Expected: process starts, no window, no panic, keeps running. Stop it with Ctrl+C.

- [ ] **Step 6: Commit**

```powershell
git add .gitignore native/spike
git commit -m "spike: scaffold throwaway Tauri 2 app for rewrite feasibility"
```

---

### Task 2: Process-tree memory measurement script

**Files:**
- Create: `native/spike/measure.ps1`

**Interfaces:**
- Produces: `measure.ps1 -Name <processName> [-CpuSeconds <n>]` → prints process count, total private working set (MB), per-process lines, and CPU % over the window.

- [ ] **Step 1: Write the script**

`native/spike/measure.ps1`:
```powershell
<#
.SYNOPSIS
  Private working set + CPU of a process and ALL its descendants (WebView2 spawns grandchildren).
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$CpuSeconds = 10
)
$ErrorActionPreference = 'Stop'

$roots = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
if ($roots.Count -eq 0) { throw "no process named '$Name'" }

$all = @(Get-CimInstance Win32_Process)

function Get-Descendants([int]$procId) {
  $procId
  foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $procId })) {
    Get-Descendants ([int]$child.ProcessId)
  }
}

# Root = topmost process with this name (portable launchers start a second copy of themselves).
$rootIds = $roots | ForEach-Object { $_.Id }
$top = $roots | Where-Object {
  $parent = ($all | Where-Object ProcessId -eq $_.Id).ParentProcessId
  $rootIds -notcontains $parent
} | Select-Object -First 1
$ids = @(Get-Descendants $top.Id | Sort-Object -Unique)

function Get-Perf { @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains [int]$_.IDProcess }) }

$perf = Get-Perf
$totalMb = (($perf | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB
'{0} processes, private working set {1:N1} MB' -f $ids.Count, $totalMb
$perf | Sort-Object WorkingSetPrivate -Descending | ForEach-Object {
  '  {0,-28} pid {1,-7} {2,8:N1} MB' -f $_.Name, $_.IDProcess, ($_.WorkingSetPrivate / 1MB)
}

# Measure-Object cannot read nested properties (TotalProcessorTime.TotalMilliseconds) → sum by loop
$cpu0 = 0
foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $cpu0 += $p.TotalProcessorTime.TotalMilliseconds }
$t0 = Get-Date
Start-Sleep -Seconds $CpuSeconds
$cpu1 = 0
foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $cpu1 += $p.TotalProcessorTime.TotalMilliseconds }
$wallMs = ((Get-Date) - $t0).TotalMilliseconds
$cores = [Environment]::ProcessorCount
'CPU over {0}s: {1:N2} % of total machine' -f $CpuSeconds, (100 * ($cpu1 - $cpu0) / ($wallMs * $cores))
```

- [ ] **Step 2: Test against a known tree (descendant walk, Review Focus 1)**

Start a process with grandchildren and check all are counted:
```powershell
Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Process notepad; Start-Sleep 60' -WindowStyle Hidden
Start-Sleep 2
powershell -NoProfile -File native/spike/measure.ps1 -Name powershell -CpuSeconds 2
```
Expected: output lists the outer `powershell`, and `notepad` as descendant. Close notepad afterwards.

- [ ] **Step 3: Check the metric (Review Focus 2)**

Compare one process against Task Manager → Details → column "Memory (active private working set)". Values must match within ±1 MB.

- [ ] **Step 4: Baseline Electron 1.8.7**

Start `release-1.8.7/Crosshair-Z.exe`, close its settings window, wait 30 s:
```powershell
powershell -NoProfile -File native/spike/measure.ps1 -Name 'Crosshair-Z' -CpuSeconds 10
```
If no match, use the name shown in Task Manager (e.g. `Crosshair Z`). Record output in the results doc (Task 6). Quit Crosshair Z from the tray afterwards.

- [ ] **Step 5: Commit**

```powershell
git add native/spike/measure.ps1
git commit -m "spike: add process-tree private working set measurement"
```

---

### Task 3: Question A — WebView2 lifecycle

**Files:**
- Modify: `native/spike/src/main.rs`

**Interfaces:**
- Consumes: `cz-spike` scaffold (Task 1), `measure.ps1` (Task 2).
- Produces: stdin commands `open`, `hidden`, `close`, `quit`; command `ready` prints elapsed ms since the last `open`/`hidden`.

- [ ] **Step 1: Replace `src/main.rs`**

```rust
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
            println!("cz-spike ready: open | hidden | close | quit");
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
```

- [ ] **Step 2: Build release**

```powershell
cd native/spike
cargo build --release
(Get-Item target/release/cz-spike.exe).Length / 1MB
```
Expected: builds; record exe size in MB.

- [ ] **Step 3: Measure the cycle**

Terminal 1:
```powershell
.\target\release\cz-spike.exe
```
Terminal 2, run after each action below:
```powershell
powershell -NoProfile -File measure.ps1 -Name cz-spike -CpuSeconds 10
```
Sequence and what to record:
1. Right after start (never opened a webview) → baseline.
2. Type `open` in terminal 1, wait for `[js] ready after N ms` → record N and measurement.
3. Type `close` → measure at +1 s, +10 s, +60 s.
4. Repeat `open` / `close` 5 times, measure after the 5th `close` at +10 s (leak check).

- [ ] **Step 4: Confirm the process is still alive (Review Focus 4)**

After step 3.3, `Get-Process cz-spike` must still return the process, and typing `open` must open a window again. If the process exited, the measurement is invalid → fix `ExitRequested` handling before continuing.

- [ ] **Step 5: Commit**

```powershell
git add native/spike/src/main.rs
git commit -m "spike: webview open/destroy cycle for WebView2 lifecycle measurement"
```

---

### Task 4: Question B — native layered overlay

**Files:**
- Create: `native/spike/src/overlay.rs`
- Modify: `native/spike/src/main.rs`

**Interfaces:**
- Consumes: stdin loop from Task 3.
- Produces: stdin command `overlay` → spawns a thread running a topmost, click-through, per-monitor-DPI-aware 64×64 layered window at the primary monitor center, showing a red plus; topmost reasserted every 1 s.

- [ ] **Step 1: Write `src/overlay.rs`**

```rust
//! Throwaway: native layered overlay window (spec §4 window styles).
use std::ffi::c_void;

use windows::core::w;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::*;

const OVERLAY_PX: i32 = 64;
const TOPMOST_TIMER_ID: usize = 1;
const TOPMOST_INTERVAL_MS: u32 = 1000;
const ARM_LEN: i32 = 12;
const GAP: i32 = 4;
const THICKNESS: i32 = 2;

pub fn spawn() {
    std::thread::spawn(|| unsafe {
        if let Err(err) = run() {
            println!("overlay failed: {err}");
        }
    });
}

unsafe fn run() -> windows::core::Result<()> {
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let hinst: HINSTANCE = GetModuleHandleW(None)?.into();
    let class = w!("CzSpikeOverlay");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: hinst,
        lpszClassName: class,
        ..Default::default()
    };
    RegisterClassW(&wc);

    let sw = GetSystemMetrics(SM_CXSCREEN);
    let sh = GetSystemMetrics(SM_CYSCREEN);
    let x = (sw - OVERLAY_PX) / 2;
    let y = (sh - OVERLAY_PX) / 2;
    let hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        class,
        w!(""),
        WS_POPUP,
        x,
        y,
        OVERLAY_PX,
        OVERLAY_PX,
        None,
        None,
        Some(hinst),
        None,
    )?;
    paint(hwnd, x, y)?;
    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    SetTimer(Some(hwnd), TOPMOST_TIMER_ID, TOPMOST_INTERVAL_MS, None);
    println!("overlay shown at {x},{y} on {sw}x{sh}");

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    Ok(())
}

/// Premultiplied BGRA plus sign, pushed with UpdateLayeredWindow(ULW_ALPHA).
unsafe fn paint(hwnd: HWND, x: i32, y: i32) -> windows::core::Result<()> {
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: OVERLAY_PX,
            biHeight: -OVERLAY_PX, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bmp = CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)?;
    let old = SelectObject(mem, bmp.into());

    let px = std::slice::from_raw_parts_mut(bits as *mut u32, (OVERLAY_PX * OVERLAY_PX) as usize);
    let c = OVERLAY_PX / 2;
    let red: u32 = 0xFF_FF_00_00; // 0xAARRGGBB; little-endian bytes = B G R A → opaque red (premultiplied)
    for yy in 0..OVERLAY_PX {
        for xx in 0..OVERLAY_PX {
            let dx = xx - c;
            let dy = yy - c;
            let horiz = (dy >= -THICKNESS / 2 && dy < THICKNESS / 2) && dx.abs() >= GAP && dx.abs() < GAP + ARM_LEN;
            let vert = (dx >= -THICKNESS / 2 && dx < THICKNESS / 2) && dy.abs() >= GAP && dy.abs() < GAP + ARM_LEN;
            px[(yy * OVERLAY_PX + xx) as usize] = if horiz || vert { red } else { 0 };
        }
    }

    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let result = UpdateLayeredWindow(
        hwnd,
        Some(screen),
        Some(&POINT { x, y }),
        Some(&SIZE { cx: OVERLAY_PX, cy: OVERLAY_PX }),
        Some(mem),
        Some(&POINT { x: 0, y: 0 }),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );

    SelectObject(mem, old);
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    result
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_TIMER && wparam.0 == TOPMOST_TIMER_ID {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
```

If the `windows` 0.61 signatures differ (e.g. `Option<HDC>` vs `HDC`, `HGDIOBJ` conversions), adjust to what `cargo build` reports; the calls and arguments stay the same.

- [ ] **Step 2: Wire into `main.rs`**

Add at top of `src/main.rs`:
```rust
mod overlay;
```
Add a match arm in `stdin_loop` before `"quit"`:
```rust
            "overlay" => overlay::spawn(),
```
Update the setup banner:
```rust
            println!("cz-spike ready: open | hidden | close | overlay | quit");
```

- [ ] **Step 3: Build and smoke test**

```powershell
cargo build --release
.\target\release\cz-spike.exe
```
Type `overlay`. Expected: red plus in screen center, clicks pass through it, it does not steal focus, no taskbar entry.

- [ ] **Step 4: Measure overlay cost**

With overlay shown and no webview ever opened: `measure.ps1 -Name cz-spike -CpuSeconds 30`. Record.

- [ ] **Step 5: Game test (Question B, Review Focus 3)**

With the overlay running, for 2 different games in borderless/windowed-fullscreen mode, 10 minutes each: alt-tab out and back 5 times, open and close the game's menu. Record per game: overlay visible throughout yes/no, any flicker. Then repeat once on the secondary monitor setup / with Windows display scale at 125 % (log off/on if required): overlay must be centered and sharp (no blur).

- [ ] **Step 6: Commit**

```powershell
git add native/spike/src
git commit -m "spike: native layered topmost overlay window"
```

---

### Task 5: Questions C + D — raw IPC throughput, hidden cold start

**Files:**
- Create: `native/spike/ui/bench.html`
- Modify: `native/spike/src/main.rs`

**Interfaces:**
- Consumes: stdin loop + `OPENED_AT` timing (Task 3).
- Produces: command `upload` (raw body → byte count), command `log_line(line: String)`, stdin command `bench` → hidden webview running `bench.html` which uploads 1 / 8 / 32 MB and prints timings.

- [ ] **Step 1: Add commands to `main.rs`**

```rust
#[tauri::command]
fn upload(request: tauri::ipc::Request<'_>) -> Result<usize, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.len()),
        tauri::ipc::InvokeBody::Json(_) => Err("expected raw body, got JSON (payload was base64/JSON-encoded)".into()),
    }
}

#[tauri::command]
fn log_line(line: String) {
    println!("[js] {line}");
}
```
Change the handler list:
```rust
        .invoke_handler(tauri::generate_handler![ready, upload, log_line])
```
Generalize `open_webview` to take a page and add the `bench` arm:
```rust
fn open_webview(app: &AppHandle, page: &str, visible: bool) {
    if app.get_webview_window(LABEL).is_some() {
        println!("already open");
        return;
    }
    *OPENED_AT.lock().unwrap() = Some(Instant::now());
    let result = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(page.into()))
        .title("cz-spike")
        .visible(visible)
        .build();
    if let Err(err) = result {
        println!("open failed: {err}");
    }
}
```
```rust
            "open" => open_webview(&app, "index.html", true),
            "hidden" => open_webview(&app, "index.html", false),
            "bench" => open_webview(&app, "bench.html", false),
```
Banner:
```rust
            println!("cz-spike ready: open | hidden | bench | close | overlay | quit");
```

- [ ] **Step 2: Write `ui/bench.html`**

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>cz-spike bench</title></head>
<body>
<script>
  const { invoke } = window.__TAURI__.core;
  const SIZES_MB = [1, 8, 32];
  const RUNS = 3;

  async function bench(mb) {
    const buf = new Uint8Array(mb * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 4096) buf[i] = i & 255;
    const times = [];
    for (let r = 0; r < RUNS; r++) {
      const t = performance.now();
      const n = await invoke('upload', buf);
      times.push(performance.now() - t);
      if (n !== buf.length) throw new Error(`size mismatch ${n} != ${buf.length}`);
    }
    await invoke('log_line', { line: `upload ${mb} MB: ${times.map((x) => x.toFixed(1)).join(' / ')} ms` });
  }

  (async () => {
    await invoke('ready');
    try {
      for (const mb of SIZES_MB) await bench(mb);
      await invoke('log_line', { line: 'bench done' });
    } catch (err) {
      await invoke('log_line', { line: `bench failed: ${err}` });
    }
  })();
</script>
</body>
</html>
```

- [ ] **Step 3: Run C**

```powershell
cargo build --release
.\target\release\cz-spike.exe
```
Type `bench`. Expected output: `[js] ready after N ms`, then three `upload ... MB` lines, then `bench done`. A line `expected raw body, got JSON` means raw IPC is not used → C fails as written; record it. Type `close`.

- [ ] **Step 4: Run D cold and warm (Review Focus 5)**

Quit the spike. Delete its WebView2 data dir (Tauri default: `%LOCALAPPDATA%\com.crosshairz.spike`):
```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.crosshairz.spike" -ErrorAction SilentlyContinue
```
Start the spike, type `hidden` → record `ready after N ms` (cold). Type `close`, then `hidden` again → record (warm). Repeat warm 3×.

- [ ] **Step 5: Commit**

```powershell
git add native/spike
git commit -m "spike: raw IPC throughput and hidden webview cold start bench"
```

---

### Task 6: Results and go/no-go decision

**Files:**
- Create: `docs/superpowers/specs/2026-10-14-rust-rewrite-spike-results.md`

- [ ] **Step 1: Write the results doc**

Fill in every value measured in Tasks 2–5 using this structure:
```markdown
# Rust Rewrite — Spike Results

Date: <date>  Machine: <CPU, RAM, Windows build, WebView2 version>  Spike exe: <MB>

## Baseline Electron 1.8.7 (settings closed, 30 s idle)
<measure.ps1 output>

## A — WebView2 lifecycle
| Moment | Processes | Private WS MB | CPU % |
|---|---|---|---|
| start, no webview | | | |
| webview open | | | |
| close +1 s | | | |
| close +10 s | | | |
| close +60 s | | | |
| after 5 cycles, +10 s | | | |
Verdict: GO / NO-GO (criterion: no msedgewebview2 left and ≤ 15 MB at +10 s)

## B — Layered overlay
Overlay only, 30 s: <MB, CPU %>
| Game | Mode | 10 min visible | Flicker | Notes |
|---|---|---|---|---|
DPI 125 % / secondary monitor: <centered, sharp?>
Verdict: GO / NO-GO

## C — Raw IPC
| Size | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
Verdict: GO / NO-GO (32 MB < 500 ms)

## D — Hidden webview cold start
Cold: <ms>  Warm: <ms, ms, ms>
Verdict: GO / NO-GO (< 1,500 ms)

## Decision
<GO / GO with fallback (settings in child process) / NO-GO> and what changes in Plan 2.
```

- [ ] **Step 2: Apply the decision rule**

- All four GO → Plan 2 as specified.
- Only A fails but "start, no webview" + overlay ≤ 15 MB → GO with fallback: settings and sprite renderer run in a child process `Crosshair-Z.exe --ui`; update spec §3 and §6 before Plan 2.
- C fails (JSON body or > 500 ms) → GO with change: sprites written by JS are transferred as a PNG per frame via a custom URI scheme upload; update spec §4.
- D fails → GO with change: render all relevant profiles' sprites eagerly on every config save so startup never misses; update spec §4.
- B fails or overlay-only > 15 MB → NO-GO; stop and discuss.

- [ ] **Step 3: Commit**

```powershell
git add docs/superpowers/specs/2026-10-14-rust-rewrite-spike-results.md
git commit -m "docs: rust rewrite spike results and go/no-go decision"
```
