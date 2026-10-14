# Rust Rewrite — Plan 2: Core Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust/Tauri 2 tray app (`native/app`) that reads the existing `config.json`, shows the active crosshair pixel-exactly through a native layered overlay built from JS-rendered sprites, and supports hotkeys, firing animation, right-click modes, tray menu, multi-monitor layout and single instance — without a settings UI (Plan 3).

**Architecture:** Crate `crosshair-z` = library (all logic, unit-tested) + thin `main.rs`. Pure modules (config, state, sprite codec, compositor, cache, accelerator parser) are tested with `cargo test`. Win32 parts (overlay window, hotkey thread, mouse thread, monitors) run on their own threads and talk to one app thread through an `AppEvent` channel. Sprites are rendered by `crosshair-core.js` in a hidden WebView2 (`src/native/sprite-render.html`) that is destroyed when idle.

**Tech Stack:** Rust 1.99 (MSVC), Tauri 2.12 (`tray-icon`, `image-png`), `windows` 0.61, `serde_json` (preserve_order), `sha2`, `uuid`; JS: existing `src/shared/crosshair-core.js`; golden fixtures via `playwright-core` + installed Chrome.

**Spec:** `docs/superpowers/specs/2026-10-14-rust-rewrite-design.md` + `docs/superpowers/specs/2026-10-14-rust-rewrite-spike-results.md`

## Plan format ruling

The user asked for uninterrupted end-to-end execution. To avoid writing every line twice (plan + commit), this plan fixes **files, interfaces, behaviors and test cases**; the code itself is written test-first during execution and lives in the commits. Every behavior below is a ported rule from the named Electron source, which is the reference when in doubt.

## Global Constraints

- Data dir: `%APPDATA%\Crosshair Z\` or `CZ_USERDATA` when set (same as Electron).
- `config.json` schema identical to `src/main/store.js` v5; unknown top-level fields preserved.
- Crosshairs are opaque JSON in Rust; JS sanitizes. Rust limits: ≤ 64 layers, ≤ 16 MiB serialized per crosshair.
- Overlay styles `WS_EX_LAYERED|TRANSPARENT|TOPMOST|NOACTIVATE|TOOLWINDOW`; reassert every 2000 ms with `HWND_TOPMOST` then `HWND_TOP`, plus on `EVENT_SYSTEM_FOREGROUND`.
- Sprite levels 33 (17 if the set would exceed 32 MiB); sprite transport raw IPC; disk cache LRU 64 files, atomic writes.
- Mouse poll 8 ms only while needed; animation ticks only while a layer is moving; idle 0 % CPU.
- In-game budget ≤ 15 MB private working set, exe ≤ 10 MB.
- Log format identical to `src/main/logger.js`: `<ISO-UTC> <LEVEL> <msg>[ <json ctx>]`, file `logs/crosshair-z.log`, rotate at 1 MiB to `.1`.
- No silent failures: every error path logs with context.

## Review Focus

1. Config written by Electron with values as strings/floats/out of range (e.g. `"offsetX": "12"`, `scale: 9`) → clamped exactly like `sanitizeConfig` (Task 2 tests).
2. A crosshair whose hotkey equals a global hotkey → second registration reports `duplicate`, first wins (Task 9 test).
3. Config pointing at a monitor id from Electron (unknown to Rust) → primary monitor, no crash (Task 8 test).
4. Sprite file truncated or from a future format version → deleted and re-rendered, never a panic (Task 5/7 tests).
5. WebView2 render never answers → after 10 s retry once, then fallback crosshair + error log (Task 10 test).

## Files

```
native/app/
  Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/icon.ico
  resources/default-crosshair.json   generated: core.sanitizeCrosshair(null)
  resources/first-preset.json        generated: loadDefaultPack()[0] {name, crosshair}
  resources/tray.png, tray@2x.png    copied from assets/
  src/lib.rs          module tree
  src/main.rs         Tauri bootstrap only
  src/paths.rs        data dir, log dir, sprite dir, webview dir
  src/logger.rs       logger.js port
  src/config/model.rs Config structs + sanitize (store.js sanitizeConfig port)
  src/config/store.rs ConfigStore (load, corrupt backup, debounced atomic save)
  src/state.rs        effective / equip / toggle / cycle / move / mouse rules (main.js port)
  src/sprites/codec.rs   SpriteSet binary format
  src/sprites/cache.rs   key, RAM + disk LRU
  src/sprites/renderer.rs hidden WebView job queue + Tauri commands
  src/overlay/compositor.rs FireAnimator + src-over compose
  src/overlay/monitors.rs   EnumDisplayMonitors, stable ids
  src/overlay/window.rs     layered window thread
  src/overlay/mod.rs        controller thread (animation, layout)
  src/input/accel.rs   Electron accelerator → (modifiers, vk)
  src/input/hotkeys.rs RegisterHotKey thread
  src/input/mouse.rs   GetAsyncKeyState poller
  src/tray.rs          tray icon + menu
  src/instance.rs      single-instance mutex
  src/app.rs           app thread: events → state → overlay/tray/hotkeys/mouse
  tests/golden.rs      compositor vs canvas fixtures
  tests/fixtures/golden/*  generated
src/native/sprite-format.js   UMD: encodeSpriteSet, rgbaToBgraPremul (node-testable)
src/native/sprite-export.js   browser: buildSpriteSet(crosshair, scale)
src/native/sprite-render.html + sprite-render.js  job loop
src/native/fixture-gen.html   golden fixture page
scripts/export-native-defaults.js
scripts/gen-sprite-fixtures.js
test/sprite-format.test.js
```

`tauri.conf.json` `frontendDist` = `../../src` so `crosshair-core.js` stays single-source while Electron coexists (spec §3 said `ui/`; ruling: avoids a duplicate copy until Electron is removed in Plan 4).

---

### Task 1: Scaffold, paths, logger, generated defaults

- Remove spike workarounds need: verify `link.exe`, `cl.exe`, x64 `rc.exe` exist; build spike copy without `.cargo/config.toml`.
- `cargo install tauri-cli --version ^2 --locked`.
- Crate skeleton with lib + bin, `tauri.conf.json` (`productName` "Crosshair Z", `identifier` "com.crosshairz.app", `withGlobalTauri` true, `windows` [], `bundle.active` false), release profile from spike.
- `scripts/export-native-defaults.js` writes `resources/default-crosshair.json`, `resources/first-preset.json`.
- `paths.rs`: `data_dir()`, `logs_dir()`, `sprites_dir()`, `webview_dir()`.
- `logger.rs`: `init(dir)`, `debug/info/warn/error(msg, ctx: impl Into<Option<Value>>)`, `log_file()`, `iso_utc(SystemTime)`.
- Tests: `iso_utc` for epoch 0 → `1970-01-01T00:00:00.000Z` and 2026-10-14T12:34:56.789Z; line format with/without ctx; rotation renames >1 MiB file to `.1` and starts a new file; `CZ_USERDATA` override.

### Task 2: Config model + sanitize

Interfaces: `Config`, `Profile`, `Display`, `Hotkeys`, `ToggleMode {Hide, Switch}`, `RcMode {Off, HideHold, HideToggle, SwitchHold, SwitchToggle}`, `Defaults { default_crosshair, first_preset_name, first_preset_crosshair }`, `sanitize(raw: &Value, d: &Defaults) -> Config`, `default_config(d) -> Config`, `HOTKEY_ACTIONS`.
Tests (port of store.js semantics): non-object → defaults; profile cap 200; duplicate/oversize ids replaced; names trimmed/40 chars/fallback `Crosshair N`; invalid crosshair → default crosshair; no profiles → first preset; numeric strings clamp (`"12"` → 12), `scale` clamp 0.25–4 rounded to 2 decimals, offsets ±4000; monitorId integer only; hotkey migrations v<3 legacy defaults cleared, v<4 Ctrl+Shift+X → Alt+Shift+X, v4 Alt+Shift+Z → Alt+Shift+X, user-picked kept; mode whitelist; profile refs must exist; flags strict booleans; `checkUpdates` true unless false; unknown top-level keys preserved; serialization round-trip camelCase.

### Task 3: ConfigStore

`ConfigStore::open(dir, defaults) -> ConfigStore` (`is_new`), `get() -> &Config`, `set(Config)` (sanitizes, schedules save 300 ms), `flush()`. Tests: missing file → defaults + is_new; BOM stripped; corrupt JSON → `config.json.corrupt-<ms>` backup + defaults; atomic save (tmp + rename) visible after `flush`; debounce coalesces 5 sets into 1 write; unwritable dir → error logged, no panic.

### Task 4: State rules

`Runtime { kb_alt, rc_alt, firing, launch_hidden }`, `effective(&Config, &Runtime) -> (visible, &Profile)`, `equip`, `keyboard_toggle`, `cycle_profile`, `move_crosshair`, `on_mouse(&Config, &mut Runtime, now, prev) -> MouseOutcome { firing: Option<bool>, relayout: bool }`, `needs_mouse(&Config) -> bool`, `crosshair_has_firing(&Value) -> bool`, `relevant_profile_ids(&Config) -> Vec<String>`. Tests mirror main.js: launch-hidden toggle, hide vs switch mode, any-mode toggle re-enables when disabled, cycle wraps, rc hold/toggle, rc switch uses profile, missing alt profile falls back to active.

### Task 5: Sprite format (JS + Rust)

Binary LE: `"CZSP"`, u16 version 1, u16 0, u32 size_px, u32 layer_count; per layer: u8 fire, 3 pad, f32 speed_ms, u32 frame_count; per frame: i32 x, i32 y, u32 w, u32 h, w·h BGRA premultiplied. Limits: size 1..4096, layers ≤ 64, frames 1..33 (≥ 2 when fire), speed 20..1000 when fire, frame inside canvas, total ≤ 64 MiB, exact length.
JS `sprite-format.js`: `encodeSpriteSet`, `rgbaToBgraPremul`. Rust `codec.rs`: `SpriteSet::decode/encode`, `SpriteError`. Shared test vector (hex) asserted in `test/sprite-format.test.js` and `codec.rs` tests; Rust tests for every limit and truncation.

### Task 6: Compositor + golden fixtures

`FireAnimator::new/set_firing/step(dt_ms, &SpriteSet) -> bool/levels()`, `frame_index(level, n)`, `compose(&SpriteSet, &[f32], &mut [u32])` premultiplied src-over with round-half-up /255. `sprite-export.js` `buildSpriteSet(raw, scale, levels=33)` (solo-layer render, crop, asset preload: images decoded + `primeImage`, fonts via probe draw + `document.fonts.ready`). `fixture-gen.html` + `scripts/gen-sprite-fixtures.js` (playwright-core, `channel: 'chrome'`): built-in presets + first 12 pack presets at fire levels 0/0.5/1 → `tests/fixtures/golden/`. `tests/golden.rs`: composite equals reference (premultiplied) within 1 per channel.

### Task 7: Sprite cache

`cache_key(&Value, scale) -> String` (sha256 hex of `"CZSP1\n{scale}\n" + json bytes`), `SpriteCache::new(dir)`, `get(key) -> Option<Arc<SpriteSet>>`, `put(key, bytes) -> Result<Arc<SpriteSet>>`, `retain_mem(&HashSet<String>)`. Tests: key stable / differs by scale; put → get from a fresh cache instance (disk); corrupt file deleted on get; LRU keeps newest 64; atomic write leaves no `.tmp`.

### Task 8: Monitors, overlay window, controller

`monitors::list() -> Vec<Monitor { id, name, rect, primary }>` (id = FNV-1a of device name, positive i64), `pick(&[Monitor], Option<i64>) -> &Monitor` (unknown → primary). `layout(&Monitor, offset_x, offset_y, size) -> (x, y)`. `OverlayWindow` thread (commands `Show{x,y,size,pixels}`, `Clear`, display-change callback). `Overlay` controller thread (`set_sprites(Arc<SpriteSet>, x, y)`, `set_visible`, `set_firing`; 8 ms ticks only while moving). Tests: pick fallback; layout math; controller produces a frame per change and stops ticking at rest (with a fake sink). Manual-free check: `scripts/check-overlay.ps1` adapted for class `CrosshairZOverlay`.

### Task 9: Accelerators, hotkeys, mouse

`accel::parse(&str) -> Result<(u32 mods, u32 vk), String>` covering everything `settings.js toAccelerator` emits. `Hotkeys` thread: `register(Vec<(String key, String accel)>) -> BTreeMap<String, Status>` with statuses `empty|duplicate|ok|taken|invalid`; WM_HOTKEY → `AppEvent::Hotkey(key)`. `MousePoller::start/stop` → `AppEvent::Mouse{now, prev}`. Tests: parser table; duplicate detection; registering an accelerator twice from two Hotkeys instances → second `taken`.

### Task 10: Sprite renderer

`SpriteRenderer::request(Job)`, Tauri commands `sprite_jobs`, `sprite_result` (raw body + `x-job-key` header), `sprite_failed`, `sprite_idle`; hidden window label `sprite-renderer`, data dir `webview2/`; destroy when idle; watchdog 10 s → retry once → `AppEvent::SpriteFailed`. Fallback SpriteSet (white 4×4 dot, dark 1 px outline). Tests: queue dedupe, retry-once logic, fallback set valid (pure parts); live: render the first preset end-to-end.

### Task 11: App wiring, tray, single instance, smoke

`instance::acquire()` (mutex `Local\CrosshairZ.Instance`), `tray.rs` (Show crosshair check item, Crosshairs submenu ≤ 30 check items, Quit), `app.rs` event loop (`apply()` = layout + tray + mouse polling + sprite request; prewarm relevant profiles), `main.rs`. `scripts/smoke.ps1`: isolated `CZ_USERDATA` with a known config → crosshair drawn on screen, sprite file cached, second start uses cache, RAM ≤ 15 MB after 15 s, second instance exits.
