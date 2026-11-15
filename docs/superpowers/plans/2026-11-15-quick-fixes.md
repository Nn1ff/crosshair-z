# Quick-Fix Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ~35 small findings of the 2.0.5 review (data safety, input bugs, wasted frames/wakeups, system robustness, settings UI) without changing formats or rendering.

**Architecture:** In-place fixes in the existing modules; new logic goes into small pure helpers so it can be unit-tested. Three file groups that never touch each other's files: Rust persistence/system (Tasks 1–4), Rust runtime (Tasks 5–10), settings UI (Tasks 11–13).

**Tech Stack:** Rust 2021, Tauri 2, windows-rs 0.61, tokio 1.53 (already locked via Tauri); vanilla JS in WebView2, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-15-quick-fixes-design.md` (item ids P1–P10, R1–R11, J1–J12 refer to it).

## Global Constraints

- Config schema v5, share-code format CZ3 and sprite format `CZSP` v1 stay unchanged; golden tests stay identical.
- No new periodic wakeups; retries/backoffs run only while something is failing.
- Caps: clipboard and share code 2,000,000 chars; draw source 32,768 chars; sprite disk cache 512 files.
- Never touch the user's running instance or `%APPDATA%\Crosshair Z`. `cargo test` is safe (test endpoints end in `.test.<pid>`). Run Rust tests with `-- --skip clipboard::` because the clipboard test writes the real clipboard.
- Toolchain: prefix commands with `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"` (PowerShell) or `PATH="$HOME/.cargo/bin:$PATH"` (bash). Rust commands run in `native/app`, JS commands at the repo root.
- No commits: the user decides when to commit. Leave changes in the working tree.

## Review Focus

- Config locked for only a few hundred ms at boot (AV scan): must load normally and keep saving → Task 1 `briefly_locked_config_loads_normally`.
- Holding a move hotkey must keep nudging while holding toggle toggles once → Task 5 `move_actions_keep_repeat`.
- A firing crosshair hidden mid-animation and shown again must show the level of the current firing state → Task 7 `hidden_firing_snaps_and_shows_current_level`.
- Right-click hold-to-hide with the crosshair enabled must keep polling; only "off" stops it → Task 6 `needs_mouse_true_for_rc_mode_when_enabled`.
- Hotkey recording with AltGr, umlauts or `ß` on a German layout must give a parseable accelerator → Task 12 `toAccelerator_layout_cases`.

---

## Group A — Rust persistence and system (one implementer, Tasks 1–4 in order)

### Task 1: Config store durability (P1–P5)

**Files:**
- Modify: `native/app/src/config/store.rs` (load, write_atomic, Saver, ConfigStore)
- Modify: `native/app/src/config/model.rs` (lossy check helper)
- Test: tests inside both files

**Interfaces:**
- Produces: `ConfigStore::read_only(&self) -> bool`; `pub fn is_lossy(raw: &serde_json::Value, cfg: &Config) -> bool` in model.rs. `ConfigStore::open` keeps its signature.
- Constants: `READ_RETRY_DELAYS: [Duration; 3] = [100 ms, 300 ms, 900 ms]`, `SAVE_RETRY_MAX = 30 s` (backoff 1, 2, 4 … 30 s), backup file `config.json.bak`, lossy copy `config.json.lossy-<ms>`.

- [ ] **Step 1: Write failing tests** (store.rs; lock a file with `OpenOptions::new().read(true).share_mode(0)` from `std::os::windows::fs::OpenOptionsExt`, held by a thread for the given time)

```rust
#[test] fn briefly_locked_config_loads_normally()      // lock 150 ms → profiles == original, !read_only(); update+flush writes
#[test] fn locked_config_runs_read_only_without_bak()  // lock 3 s → defaults, read_only(); after unlock update+flush → file bytes == original
#[test] fn locked_config_uses_bak_read_only()          // .bak present, lock 3 s → profiles == .bak profiles, read_only()
#[test] fn first_save_writes_bak_of_clean_load()       // open valid file, update+flush → config.json.bak bytes == original bytes
#[test] fn no_bak_from_default_or_read_only_session()  // missing file → flush → no .bak; read-only session → no .bak
#[test] fn missing_config_falls_back_to_bak()          // only .bak → profiles from .bak, !is_new
#[test] fn corrupt_config_falls_back_to_bak()          // garbage + valid .bak → .corrupt-* exists, profiles from .bak
#[test] fn failed_save_is_retried()                    // dir named config.json blocks rename; remove it after 200 ms → write_count()==1 within 4 s
#[test] fn lossy_load_is_backed_up()                   // version 6 or profiles as object → config.json.lossy-* exists with original bytes
```
model.rs: `#[test] fn lossy_detection()` — `is_lossy` true for version 6, for `"profiles": {}`, for 250 profiles; false for the normal 16-profile shape and for an empty profile list.

- [ ] **Step 2: Run** `cargo test --lib config:: -- --skip clipboard::` — expected: new tests FAIL (missing `read_only`, `is_lossy`, no `.bak`).
- [ ] **Step 3: Implement** in store.rs: retry loop in `load()` for non-NotFound errors (P1); `.bak` fallback for missing/corrupt/unreadable (P3); a `read_only` flag that makes `schedule_save` a no-op with one WARN; `write_atomic` = `File::create(tmp)`, `write_all`, `sync_all`, drop, `fs::rename` (P2); first successful save of a cleanly loaded session first copies `config.json` → `config.json.bak` and syncs it (P3); the Saver keeps the pending text after a failed write and retries with `recv_timeout(backoff)` only while failing (P4); `is_lossy` check after parsing, copying the original bytes before sanitizing (P5). Log every fallback with ERROR/WARN and the file path.
- [ ] **Step 4: Run** `cargo test --lib config:: -- --skip clipboard::` — expected: all PASS, including the existing store/model tests.

### Task 2: Logger single writes and pause instead of permanent off (P6)

**Files:** Modify `native/app/src/logger.rs` (`Logger::write`, disabled state); tests in the same file.

**Interfaces:**
- Produces: `const FILE_RETRY_AFTER: Duration` = 60 s (`#[cfg(test)]` 50 ms). `Logger::new`, `write`, `format_line` keep their signatures.

- [ ] **Step 1: Write failing tests**

```rust
#[test] fn entries_are_single_writes()          // two Logger instances on one file, 2 threads × 500 lines → every line matches ^\d{4}-\d\d-\d\dT, no empty lines
#[test] fn file_logging_resumes_after_pause()   // hold the log file with share_mode(0), write (fails), release, sleep 80 ms, write → file contains "file logging resumed" and the new line
```
- [ ] **Step 2: Run** `cargo test --lib logger:: -- --skip clipboard::` — expected: FAIL.
- [ ] **Step 3: Implement**: build `line + "\n"` and write it with one `write_all`; replace the permanent disable with `disabled_until: Mutex<Option<Instant>>` (skip file output until the instant, then retry and log "file logging resumed" once). Keep rotation behaviour.
- [ ] **Step 4: Run** the same command — expected: PASS incl. `writes_and_rotates`, `bad_dir_disables_file_output_without_panic`.

### Task 3: Clipboard bounds (P7)

**Files:** Modify `native/app/src/clipboard.rs`; tests in the same file.

**Interfaces:**
- Produces: `pub const MAX_CHARS: usize = 2_000_000`; `fn nul_terminated_len(units: &[u16]) -> Option<usize>`; `write_text(&str) -> Result<(), String>` returns `Err("text too long for the clipboard")` above `MAX_CHARS` (no truncation); `read_text()` scans at most `min(GlobalSize/2, MAX_CHARS + 1)` units and errors when no NUL is found within that.

- [ ] **Step 1: Write failing tests** (pure, never touch the real clipboard)

```rust
#[test] fn nul_scan_is_bounded()   // nul_terminated_len(&[65, 66, 0, 67]) == Some(2); nul_terminated_len(&[65; 8]) == None
#[test] fn over_long_write_rejected_before_open() // write_text(&"a".repeat(MAX_CHARS + 1)).is_err() and the error says "too long"
```
Mark the existing `roundtrip_and_truncate` test `#[ignore = "writes the real clipboard"]` and rename it `roundtrip_real_clipboard` (assert round trip, no truncation).
- [ ] **Step 2: Run** `cargo test --lib clipboard::` — expected: FAIL.
- [ ] **Step 3: Implement** the length check before opening the clipboard and the bounded scan via `GlobalSize`.
- [ ] **Step 4: Run** `cargo test --lib clipboard::` — expected: PASS (the ignored test is skipped).

### Task 4: Instance, Run-key and updater robustness (P8–P10)

**Files:**
- Modify: `native/app/src/instance.rs`, `native/app/src/system.rs`, `native/app/src/updater.rs`, `native/app/src/app/updates.rs`
- Test: tests in each file

**Interfaces:**
- instance.rs: `fn mutex_error_means_running(code: windows::core::HRESULT) -> bool` (true for `E_ACCESSDENIED`); `fn pipe_retry_delay(attempt: u32) -> Duration` (1 s doubling, 60 s cap); pipe mode adds `PIPE_REJECT_REMOTE_CLIENTS`.
- system.rs: `pub fn is_cz_exe_name(file_name: &str) -> bool` (case-insensitive: `Crosshair Z.exe`, `Crosshair Z <x.y.z>.exe`, `Crosshair-Z.exe`); `stale_entry_names` uses it on the exe file name of each Run value (plus `LEGACY_LOGIN_ITEM_NAMES`); `pub fn apply_login_item(enabled: bool, exe: &Path) -> bool` (true = applied without error).
- updater.rs: `version_of` accepts exactly three numeric parts; `cleanup_old_versions` skips `.part` files modified less than `DOWNLOAD_TIMEOUT` ago; `const DOWNLOAD_DEADLINE: Duration = 10 min` enforced in the download sink; `sync_all` before rename; HTTP 404 on the releases endpoint logged with WARN "releases endpoint returned 404".
- updates.rs: `UpdateState.login_item_ok: bool` (default true), set from `apply_login_item`; `housekeeping` skips `cleanup_old_versions` when false (log INFO).

- [ ] **Step 1: Write failing tests**

```rust
// instance.rs
#[test] fn access_denied_mutex_counts_as_running() // mutex_error_means_running(E_ACCESSDENIED) && !mutex_error_means_running(E_FAIL)
#[test] fn pipe_retry_backoff()                    // delays for attempts 0,1,5,6,20 == 1,2,32,60,60 s
// system.rs
#[test] fn cz_exe_names()  // true: "Crosshair Z.exe", "Crosshair Z 2.0.5.exe", "crosshair-z.exe"; false: "CrosshairZoom.exe", "Crosshair-Z-Setup.exe", "crosshair_z-1a2b3c.exe"
#[test] fn stale_entries_only_cz_exes() // Run values pointing at CrosshairZoom.exe or a cargo test binary are kept
// updater.rs
#[test] fn version_needs_three_parts() // version_of("v2.1") == None, version_of("v2.0.6") == Some("2.0.6"), version_of("v2.0.6.1") == None
#[test] fn cleanup_keeps_fresh_part()  // fresh "Crosshair Z 2.0.6.exe.part" kept, one with mtime now-10 min removed
```
- [ ] **Step 2: Run** `cargo test --lib instance:: system:: updater:: -- --skip clipboard::` (or run each module filter separately) — expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. In `acquire()`, an `E_ACCESSDENIED` from `CreateMutexW` returns `None` (treated as running); other errors keep the current fail-open path. The pipe thread retries `CreateNamedPipeW` with `pipe_retry_delay` instead of returning, logging the first failure and the recovery.
- [ ] **Step 4: Run** the same tests plus `cargo test --lib -- --skip clipboard::` — expected: all PASS (incl. `hello_and_reply_over_pipe`, `cleanup_removes_only_older_copies`).

---

## Group B — Rust runtime (one implementer, starts after Group A, Tasks 5–10 in order)

### Task 5: Hotkeys without auto-repeat (R1)

**Files:** Modify `native/app/src/input/hotkeys.rs`; tests in the same file.

**Interfaces:** `fn hotkey_modifiers(key: &str, mods: u32) -> u32` returns `mods | MOD_NOREPEAT.0` except for `moveUp`, `moveDown`, `moveLeft`, `moveRight`; used in `register_all`.

- [ ] **Step 1: Write failing test** `#[test] fn move_actions_keep_repeat()` — `hotkey_modifiers("toggle", MOD_ALT.0) == MOD_ALT.0 | MOD_NOREPEAT.0`, same for `"next"` and `"profile:abc"`; `hotkey_modifiers("moveUp", MOD_ALT.0) == MOD_ALT.0`.
- [ ] **Step 2: Run** `cargo test --lib input::hotkeys` — expected: FAIL.
- [ ] **Step 3: Implement** the helper and call it in `register_all`.
- [ ] **Step 4: Run** `cargo test --lib input::` — expected: PASS (incl. `statuses`, `taken_by_other_registrant_and_released_on_reregister`).

### Task 6: Mouse polling only while shown; right-click state reset (R2)

**Files:** Modify `native/app/src/state.rs`, `native/app/src/app/mod.rs` (`update_mouse_polling`); tests in state.rs.

**Interfaces:** `pub fn needs_mouse(c: &Config, rt: &Runtime) -> bool` = `c.enabled && !rt.launch_hidden && (rc mode != Off || relevant profile has firing)`. `equip` and `tray_toggle_enabled` set `rt.rc_alt = false`; `keyboard_toggle` sets it to false whenever it changes `c.enabled`.

- [ ] **Step 1: Write failing tests** (state.rs)

```rust
#[test] fn needs_mouse_false_when_disabled_or_launch_hidden()
#[test] fn needs_mouse_true_for_rc_mode_when_enabled()        // hideHold + enabled → true
#[test] fn toggle_off_click_toggle_on_shows_main()            // hideToggle and switchToggle: rc_alt=true, keyboard_toggle twice → effective == (true, profile "a")
#[test] fn equip_and_tray_reset_rc_alt()
```
Update existing `firing_and_mouse_need` to the new signature.
- [ ] **Step 2: Run** `cargo test --lib state::` — expected: FAIL.
- [ ] **Step 3: Implement**; `update_mouse_polling` passes `&self.rt`.
- [ ] **Step 4: Run** `cargo test --lib state::` — expected: PASS.

### Task 7: Overlay renders only on real changes (R3)

**Files:** Modify `native/app/src/overlay/mod.rs` (Scene, thread loop), `native/app/src/sprites/codec.rs` (`has_firing`); tests in overlay/mod.rs (existing `Recorder`).

**Interfaces:** internal only; `Overlay::set_sprites/set_visible/set_firing` keep their signatures. `SpriteSet` gains `pub fn has_firing(&self) -> bool` in `sprites/codec.rs` (any layer with `fire_speed_ms`).

- [ ] **Step 1: Write failing tests**

```rust
#[test] fn unchanged_sprites_render_no_extra_frame()         // same Arc + same x/y twice → 1 frame
#[test] fn firing_without_fire_layer_renders_nothing()       // non-firing set, 5× set_firing(true/false) → still 1 frame
#[test] fn hidden_firing_snaps_and_shows_current_level()     // firing set, set_visible(false), set_firing(true), wait 300 ms → 1 empty frame only; set_visible(true) → next frame shows the full-level frame (0xFF00_0002 at index 3)
#[test] fn ticks_render_only_on_frame_change()               // firing set with speed 200 ms and 2 frames: rise produces ≤ 2 frames, not one per 8 ms tick
```
Existing tests (`frame_per_change_and_hidden_is_empty`, `relocating_cached_sprites_keeps_rise_and_decay_running`, `firing_animates_then_stops_ticking`) must keep passing.
- [ ] **Step 2: Run** `cargo test --lib overlay::` — expected: new tests FAIL.
- [ ] **Step 3: Implement**: `Msg::Sprites` renders only when the Arc, x or y changed (or nothing was shown yet); `Msg::Firing` starts ticking only if visible and `set.has_firing()`, otherwise stores the target and snaps levels to it; a tick renders only when any frame index changed; `Visible(true)` snaps levels to the current target first.
- [ ] **Step 4: Run** `cargo test --lib overlay::` — expected: PASS.

### Task 8: Overlay window: throttled topmost, no screen DC (R4)

**Files:** Modify `native/app/src/overlay/window.rs`; test in the same file.

**Interfaces:** `const REASSERT_MIN_INTERVAL: Duration = Duration::from_millis(250)`; `fn should_reassert(last: Option<Instant>, now: Instant, size_changed: bool) -> bool`. `Ctx` gains `last_raise: Option<Instant>`, updated by every reassert (frame path, timer, foreground hook).

- [ ] **Step 1: Write failing test** `#[test] fn reassert_throttle()` — `None` → true; size changed → true; 100 ms after last → false; 250 ms after → true.
- [ ] **Step 2: Run** `cargo test --lib overlay::window` — expected: FAIL.
- [ ] **Step 3: Implement**: `show_frame` reasserts only when `should_reassert`; `UpdateLayeredWindow` gets `hdcDst = None` (remove `GetDC`/`ReleaseDC` there).
- [ ] **Step 4: Run** `cargo test --lib overlay::` — expected: PASS. (Behaviour on screen is checked by the smoke test in the final verification.)

### Task 9: App plumbing: lazy emit, render retry, disk cache, handover reply, copy result (R5–R8, R11)

**Files:**
- Modify: `native/app/src/app/mod.rs`, `native/app/src/app/ipc.rs`, `native/app/src/main.rs` (listener closure), `native/app/src/sprites/cache.rs`, `native/app/src/sprites/renderer.rs`
- Test: cache.rs, renderer.rs, app/mod.rs (add a `#[cfg(test)] mod tests` if missing)

**Interfaces:**
- `fn emit_with(&self, event: &str, payload: impl FnOnce() -> Value)` replaces payload-first `emit` calls (`config:changed`, `runtime:changed`, `hotkeys:status`); the "keyboard toggle" log line moves after `self.changed()`.
- renderer.rs: `pub const FAILED_RETRY_AFTER: Duration = 60 s`; `pub fn retry_due(failed_at: Instant, now: Instant) -> bool`. `App.failed` becomes `HashMap<String, Instant>`; `sprites_for` re-requests a failed key once `retry_due`.
- cache.rs: `MAX_DISK_FILES = 512`; `prune_disk` never deletes a key present in RAM.
- `AppEvent::SecondInstance { hello, reply: std::sync::mpsc::SyncSender<bool> }`; main.rs uses `sync_channel(0)`; `fn deliver_handover(reply: &SyncSender<bool>, handover: bool) -> bool` in app/mod.rs returns true only when the reply was received; the app quits only if `handover && delivered`.
- ipc.rs: `"clipboard:write"` returns `Ok(json!(true))`.

- [ ] **Step 1: Write failing tests**

```rust
#[test] fn retry_after_sixty_seconds()          // renderer.rs: 59 s → false, 60 s → true
#[test] fn prune_never_deletes_ram_keys()       // cache.rs: RAM key with oldest mtime survives pruning past MAX_DISK_FILES
#[test] fn handover_needs_a_listening_receiver() // app/mod.rs: dropped receiver → false; receiver thread waiting → true
```
Adjust `prunes_to_newest_64` to `MAX_DISK_FILES`.
- [ ] **Step 2: Run** `cargo test --lib sprites:: app:: -- --skip clipboard::` — expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `cargo test --lib -- --skip clipboard::` — expected: PASS.

### Task 10: Small tokio runtime and DLL load flag (R9, R10)

**Files:** Modify `native/app/Cargo.toml` (`tokio = { version = "1", features = ["rt-multi-thread"] }`), `native/app/Cargo.lock` (via cargo), `native/app/src/main.rs`, `native/app/build.rs`.

**Interfaces:** at the top of `main()`, before `tauri::Builder`: build `tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()`; on success `tauri::async_runtime::set(rt.handle().clone())` and keep `rt` alive until `main` returns; on error log WARN and continue with Tauri's default runtime. build.rs: when `CARGO_CFG_TARGET_ENV == "msvc"`, `println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800")`.

- [ ] **Step 1: Run** `cargo build --release --offline` — expected: builds (lockfile change only adds tokio to the root package's dependency list; no new packages).
- [ ] **Step 2: Verify the load flag**: read `target/release/crosshair-z.exe` with a small Node script: PE optional header → data directory 10 (load config) → WORD at offset 0x4E of `IMAGE_LOAD_CONFIG_DIRECTORY64` == `0x0800`. Expected: `0x800`.
- [ ] **Step 3: Run** `cargo clippy --all-targets -- -D warnings` and `cargo test -- --skip clipboard::` — expected: clean / PASS.

---

## Group C — Settings UI (one implementer, parallel to Groups A/B, Tasks 11–13 in order)

### Task 11: Core engine hardening and image cache (J3, J4, J10, J12 core)

**Files:** Modify `src/shared/crosshair-core.js`; test `test/core.test.js` (extend).

**Interfaces:**
- Constants: `MAX_SHARE_CODE_CHARS = 2000000`, `MAX_DRAW_SRC_CHARS = 32768`, `MAX_IMAGE_CACHE = 256`, `MAX_IMAGE_CACHE_PIXELS = 64 * 1024 * 1024`, `MAX_BOUNDS_SIDE = 4096`.
- `decodeShareCode(code)` throws `Error('share code too long')` above the cap; decoded draw layers with a longer `draw.src` get `draw.src = ''`.
- `sanitizeCrosshair` accepts any input: non-array `layers` → `[]`, non-object layer entries dropped, `null` sub-objects (outline, firing, lines, dot, …) → defaults.
- One internal `putImage(src, img)` used by `primeImage`, `getImage` and `rasterizeSvg`: LRU (re-insert on hit), evicts oldest until both caps hold. Image `onload` notifies only if `imageCache.get(src) === img`; `onImageLoaded` listeners run once per animation frame (`requestAnimationFrame`, fallback `setTimeout(…, 0)`) however many images loaded.
- D1 (decided during implementation): sources drawn by the latest `onImageLoaded` listener run are pinned (not evicted) until the next run, so both caps are soft by one listener run's working set. Without the pins a redraw that needs more than the caps evicts its own images and every load triggers another full redraw (endless decode loop).
- `layerBounds` never throws: canvas side above `MAX_BOUNDS_SIDE` or a failing `getImageData` → geometric estimate from `overlaySizePx` (full square).

- [ ] **Step 1: Write failing tests** (`node --test`)

```js
test('share code length cap', () => assert.throws(() => C.decodeShareCode('CZ3-' + 'A'.repeat(2000001)), /too long/));
test('oversized drawing source dropped on decode', ...) // encode a draw layer with a 40,000-char src → decoded layer draw.src === ''
test('sanitizeCrosshair tolerates broken shapes', ...)   // no throw for {version:3}, {layers:{}}, {layers:[null,'x']}, {layers:[{kind:'crosshair', outline:null, firing:null}]}
test('image cache is LRU', ...)                          // prime 257 fake images (width/height 1), touch the first → first kept, second evicted
```
- [ ] **Step 2: Run** `npm test` — expected: new tests FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — expected: all PASS (incl. `svg-render.test.js`, `sprite-format.test.js`).

### Task 12: Settings page fixes (J1, J2, J8, J9, J11, J12 listener, J10 guard)

**Files:**
- Create: `src/renderer/input-utils.js` (UMD like `crosshair-core.js`: `module.exports` in Node, `root.CzInput` in the page)
- Modify: `src/renderer/settings.js`, `src/renderer/settings.html` (script tag before `settings.js`; `maxlength="2000000"` on `#importCode`)
- Test: `test/input-utils.test.js`

**Interfaces:**
- `CzInput.toAccelerator(e) -> string|null` (moved from settings.js): letters from `e.key` when it is one ASCII letter, else from `e.code` `Key[A-Z]`; digits from `e.code` `Digit`; numpad digits `num0`–`num9`; `NumpadAdd/Subtract/Multiply/Divide/Decimal` → `numadd/numsub/nummult/numdiv/numdec`; uppercase only if the result stays one character; modifiers `CommandOrControl`, `Alt`, `Shift`, `Super` (from `e.metaKey`), in that order.
- `CzInput.nextZoom(z, up, min = 2, max = 40) -> number` (at least ±1 per step, ×/÷1.15 otherwise, clamped); `CzInput.dragDelta(px, zoom, scale) -> number` = `Math.round(px / (zoom * scale))`.
- settings.js: Discover click calls `createProfile(p.name, p.crosshair, true)`; `createProfile` returns the IPC result; `copyShareCode` toasts success when the result is `true` and the copy button uses it; `importCode` clears the field only on success; the size range is not written while it is `document.activeElement` or a pointer is down on it; the image listener re-renders saved, library (`presetList`) and Crosshair X (`cxList`) cards; `applyConfig` wraps `designer.load` in try/catch (toast + log) so other pages still render.

- [ ] **Step 1: Write failing tests**

```js
test('toAccelerator_layout_cases', () => {
  const k = (o) => CzInput.toAccelerator({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(k({ key: 'z', code: 'KeyY' }), 'Z');                                   // German layout
  assert.equal(k({ key: 'ß', code: 'Minus' }), 'ß');
  assert.equal(k({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), 'CommandOrControl+Alt+Q'); // AltGr
  assert.equal(k({ key: '+', code: 'NumpadAdd' }), 'numadd');
  assert.equal(k({ key: 'j', code: 'KeyJ', metaKey: true }), 'Super+J');
  assert.equal(k({ key: '!', code: 'Digit1', shiftKey: true }), 'Shift+1');
  assert.equal(k({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), null);
});
test('nextZoom and dragDelta', () => { /* nextZoom(3,true)===4; nextZoom(3,false)===2; nextZoom(40,true)===40; dragDelta(40,10,2)===2 */ });
```
- [ ] **Step 2: Run** `npm test` — expected: FAIL (module missing).
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — expected: PASS.

### Task 13: Designer fixes (J5, J6, J7)

**Files:** Modify `src/renderer/designer.js`, `src/renderer/settings.js` (applyConfig callers listed below).

**Interfaces:** consumes `CzInput.nextZoom`, `CzInput.dragDelta` (Task 12).
- Undo/redo buttons and Ctrl+Z/Ctrl+Y first flush a pending snapshot (`flushSnapshot()`: clear the 250 ms timer and snapshot now).
- Undo history resets only when the designer switches to a different profile id (activate of the same profile, import, dedupe keep it).
- Stage drag uses `dragDelta(pointerDelta, st.zoom, opts.getScale())`; wheel uses `nextZoom`.
- Imported drawings: draw into the 64×64 buffer with `imageSmoothingEnabled = false` and `drawImage(img, 0, 0, C.DRAW_SIZE, C.DRAW_SIZE)`.

- [ ] **Step 1: Run** `npm test` — expected: PASS before changes (baseline).
- [ ] **Step 2: Implement** per Interfaces.
- [ ] **Step 3: Run** `npm test` — expected: PASS. Then load `src/renderer/settings.html` in a scratch Playwright/Chromium harness with a stubbed `window.cz` (no native app) and check: edit + quick Ctrl+Z returns to the previous state; at display scale 2 a 40 px drag moves the layer 20 px at zoom 1; a 128 px drawing keeps all four quadrants after one pen stroke.

---

## Final verification (after all groups)

- [ ] `cargo clippy --all-targets -- -D warnings` (native/app) — clean.
- [ ] `cargo test -- --skip clipboard::` (native/app) — all PASS incl. `--test golden`.
- [ ] `npm test` (repo root) — all PASS.
- [ ] `cargo build --release` then `powershell -NoProfile -ExecutionPolicy Bypass -File native/app/scripts/smoke.ps1` — `SMOKE OK`.
- [ ] Isolated instance thread count (start with `CZ_USERDATA` in a temp dir, read `Get-Process` threads, stop it) — fewer threads than the 2.0.5 live instance (30).
