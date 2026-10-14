# Crosshair Z 2.0 — Rust Rewrite (Hybrid) Design

Date: 2026-10-14
Status: approved design, pending spec review

## 1. Goal

Make Crosshair Z as light as possible **while a game is running**. Today (Electron 1.8.7) the
portable exe is 68 MB and the always-running Chromium processes use roughly 150–300 MB RAM.

Primary driver: RAM/CPU in-game. Secondary: smaller exe.

### Success criteria

- Settings window closed: private working set of all Crosshair Z processes **≤ 15 MB**, idle CPU ≈ 0 %.
- Portable exe **≤ 10 MB**.
- Overlay output pixel-identical to 1.8.7 (golden test tolerance ≤ 1 per channel), except fire
  animation levels are quantized to 1/32 steps.
- Feature parity with 1.8.7 (profiles, designer, hotkeys, toggle / right-click modes, firing
  animation, multi-display, offsets, Crosshair X import, share codes, updater, autostart, tray).
- Existing users upgrade via the 1.8.x updater without manual steps; their `config.json` keeps working.

### Constraints

- No Game Bar, no injection (lightweight principle).
- Settings / designer UI may stay HTML/JS running in WebView2.
- Same data dir `%APPDATA%\Crosshair Z\`, same `config.json` schema, same share codes.
- Electron build stays in the repo until 2.0.0 is released (parallel build, then switch).

## 2. Chosen approach

**Hybrid:** Tauri 2 host process in Rust + a native Win32 layered overlay window that composites
pre-rendered sprites. All crosshair rendering stays in `crosshair-core.js` (single source of truth);
JS renders per-layer sprites, Rust only composites them.

Rejected:
- *Tauri with WebView overlay* — overlay keeps WebView2 alive in-game (~50–80 MB), misses the goal.
- *Native renderer port (tiny-skia etc.)* — duplicates 1,345 lines of render logic; Canvas2D blur,
  antialiasing and text would drift from the designer preview.

## 3. Architecture

```
native/                      Cargo workspace (Tauri 2)
  src-tauri/src/
    main.rs        bootstrap, single instance + handover, event loop
    config/        store for %APPDATA%\Crosshair Z\config.json (serde, unknown fields preserved)
    overlay/       Win32 layered window, compositor, topmost watch, display layout
    sprites/       sprite cache (RAM + disk), render requests to a renderer WebView
    input/         mouse poll thread (GetAsyncKeyState, 8 ms), global hotkeys
    tray.rs        tray icon + menu
    state.rs       effective(): active profile, toggle, right-click modes, visibility
    ipc.rs         Tauri commands = today's 19 invoke channels + 5 event channels, same names/payloads
    updater.rs     GitHub latest release, asset Crosshair-Z.exe
    autostart.rs   HKCU Run key (winreg), stale-entry cleanup, Start menu link
    cx_import.rs   Crosshair X scan
    log.rs         tracing, file output in logs/
  ui/              today's src/renderer + src/shared (unchanged JS)
    bridge.js      window.cz.invoke/on mapped to Tauri invoke/listen (replaces preload.js)
    sprite-export.js     renders a SpriteSet from a crosshair
    sprite-render.html   headless renderer page used when settings are closed
```

Principles:
- `window.cz` API stays identical, so `settings.js`, `designer.js` and `crosshair-core.js` stay unchanged.
- Rust treats crosshairs as opaque `serde_json::Value`. Sanitizing (`sanitizeCrosshair`) happens in JS
  before data reaches Rust (profile create/update/import). Rust enforces only structural limits:
  payload size, ≤ 64 layers, JSON depth.
- `overlaySizePx` and `hasFiring` are computed in JS and shipped inside the SpriteSet, so Rust needs
  no port of geometry code.
- In-game process list: only `Crosshair-Z.exe`. WebView2 processes exist only while settings is
  open or a sprite render is running.

## 4. Sprite pipeline

### SpriteSet

Rendered in physical pixels for one crosshair + `display.scale` (DPI-independent).

```
SpriteSet {
  version, size_px, has_firing,
  layers: [ { fire: Option<{ speed_ms }>, frames: [ { x, y, w, h, bgra_premultiplied } ] } ]
}
```

- Layer without firing: 1 frame. With firing: 33 frames (levels 0, 1/32 … 1).
- Each frame: the layer is drawn solo with `drawCrosshair` into a `size_px²` canvas at exactly the
  same center the overlay uses, then cropped to its alpha bounding box. Layers in `drawCrosshair`
  are drawn sequentially with `source-over` onto a shared context, so compositing cropped frames at
  integer offsets reproduces the original image.
- Budget: if a SpriteSet exceeds 32 MB, use 17 levels instead and log a warning.
- Hidden layers are omitted.

### Producing sprites (JS)

- Settings open: the settings WebView renders sprites itself.
- Settings closed and cache miss: Rust creates a hidden WebView with `sprite-render.html`, renders,
  then destroys it.
- Before rasterizing, wait for image decode (`onImageLoaded`) and `document.fonts.ready`.
- Transport: Tauri 2 raw IPC body (ArrayBuffer), no base64.

### Cache

- Key: SHA-256 of canonical crosshair JSON + `display.scale` + sprite format version.
- RAM: SpriteSets for all relevant profiles (active, toggle target, right-click target, profiles
  with a hotkey).
- Disk: `%APPDATA%\Crosshair Z\sprites\<key>.bin`, LRU max 64 files, atomic write (tmp + rename).
- Prewarm: after each config/profile change while settings is open, render all relevant profiles.
- Startup: disk hit → crosshair visible immediately. Miss (e.g. first 2.0 start) → hidden WebView,
  crosshair appears ~1 s later.

### Runtime data flow

```
mouse thread (8 ms) ─┐
hotkey (WM_HOTKEY) ──┼─► state (effective) ─► compositor ─► UpdateLayeredWindow
display change ──────┘                           ▲
                                    sprite cache ┘
```

- Compositor: port of `FireAnimator` (per-layer level 0..1, own speed), frame index =
  `round(level * (L - 1))`, premultiplied src-over into a BGRA buffer, `UpdateLayeredWindow(ULW_ALPHA)`.
- Animation timer runs only while some layer is moving (same as today's rAF loop); idle = 0 % CPU.
- Window styles: `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`.
  Topmost reassert interval as today, each reassert = `SetWindowPos(HWND_TOPMOST)` followed by
  `SetWindowPos(HWND_TOP)` (TOPMOST alone does not re-raise within the topmost band — spike B), plus an
  immediate reassert on `EVENT_SYSTEM_FOREGROUND` via `SetWinEventHook`. Position = display center + offset (physical px), size = `size_px`.
- Visibility toggle draws an empty buffer instead of hiding the window (keeps today's race fix).

## 5. Error handling

| Case | Behavior |
|---|---|
| WebView2 runtime missing | Overlay runs from disk cache. Opening settings shows a dialog with the Evergreen installer link. Cache miss without WebView2 → native fallback dot + tray notice |
| Sprite render timeout (10 s) or JS error | 1 retry with backoff, then keep the previous SpriteSet, log error |
| Corrupt sprite file | Header check (magic, version, lengths) fails → delete, re-render |
| Corrupt `config.json` | Same as `store.js`: back up to `.corrupt-<ts>`, reset to defaults; writes are atomic tmp + rename |
| Mouse poll unavailable | Firing / right-click features off, logged (as today) |
| Hotkey taken | Status `conflict` / `duplicate` reported to UI (as today) |
| Worker thread panic | Panic hook logs. Mouse and compositor threads are supervised: restart with backoff, max 3, then feature off + log |
| Display / DPI change | `WM_DISPLAYCHANGE` / `WM_DPICHANGED` → relayout |
| Updater | Port of today's logic: 10 s timeout, 2 retries with exponential backoff, `github.com` host check, size limit |

No error may fail silently: every recovery path logs with context.

## 6. Migration 1.8.x → 2.0

- Same data dir; `config.json` read unchanged. Unknown fields are preserved on write, so a downgrade
  to Electron keeps working.
- **Handover.** Electron's handover uses `requestSingleInstanceLock` additional data, which Rust
  cannot speak. 2.0 instead:
  - holds a named mutex `Local\CrosshairZ.Instance`;
  - mutex taken → another 2.x runs → send `{version, exe}` over a named pipe; same semantics as
    today: newer version takes over, otherwise the running instance opens settings;
  - mutex free but a process with a Crosshair Z exe name (`/crosshair[ _-]?z[^\\/"]*\.exe/i`) other
    than itself runs → legacy Electron → `TerminateProcess`, logged. Safe because config writes are atomic.
- Autostart: same Run value name; stale-entry cleanup ported; dev runs (`CZ_USERDATA`) never touch autostart.
- After the first successful 2.0 start, delete Electron-only dirs in userData (`Cache`, `Code Cache`,
  `GPUCache`, `DawnCache`, `Local Storage`, `Session Storage`, `Network`, `Preferences`). Never touch
  `config.json`, `logs`, `sprites`.
- WebView2 user data dir: `%APPDATA%\Crosshair Z\webview2`.
- Accepted loss: designer UI prefs stored in `localStorage` (panel state only).

## 7. Testing

- JS tests stay: `core.test.js`, `crosshairx-import.test.js` (`node --test`) run against `native/ui/`.
- Rust unit tests, ported from existing cases: store (atomic write, corrupt recovery, unknown-field
  passthrough), updater (`parseRelease`, `compareVersions`, retry), autostart (`parseRunKey`,
  `staleEntryNames`), FireAnimator stepping, `effective()` state logic, sprite codec (roundtrip, bad headers).
- Golden image test: a script renders every default-pack preset with Playwright Chromium at fire
  levels {0, 0.5, 1}, producing (a) SpriteSets and (b) reference full images via `drawCrosshair`.
  Fixtures are committed. `cargo test` composites (a) and compares with (b), tolerance ≤ 1 per channel.
- Perf acceptance script (PowerShell, private working set): settings closed ≤ 15 MB, idle CPU ≈ 0 %, exe ≤ 10 MB.
- Manual checklist: borderless fullscreen games, multi-monitor, DPI 100/125/150 %, all hotkeys,
  right-click modes, update handover from 1.8.7.

## 8. Release plan

1. **Spike (throwaway code), go/no-go:** (a) WebView2 frees its processes / RAM after the last
   webview is destroyed; (b) layered window stays above a borderless fullscreen game; (c) raw IPC
   throughput is fine for a worst-case SpriteSet.
2. Build Rust app in `native/`, Electron untouched next to it.
3. `2.0.0-beta.N` as GitHub prereleases (updater ignores prereleases → manual testers only).
4. `2.0.0` as latest with asset `Crosshair-Z.exe` → 1.8.x users get it through the updater.
5. `2.0.1`: remove Electron code and npm runtime dependencies from the repo.

Build: `cargo tauri build` with `bundle.active = false`, portable exe renamed to `Crosshair-Z.exe`,
same icon.

## 9. Out of scope (YAGNI)

- `CZ_CAPTURE_DIR` screenshot mode is not ported; README screenshots come from Playwright against
  `ui/` with a mock bridge.
- No installer, no code signing changes, no new features.
