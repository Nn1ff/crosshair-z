# Crosshair Z — Quick-Fix Package (post-2.0.5 review)

Date: 2026-11-15
Status: approved scope (user picked "Ganzes Paket" from the review results)

## Intent

A multi-agent review of 2.0.5 confirmed ~60 findings. This package fixes the small, low-risk ones
(XS effort) plus one S item with the largest measured user impact (settings image cache). Goals in
priority order: never lose the user's library, no user-visible input bugs, fewer wasted frames and
wakeups in game, robustness of system integration, settings UI correctness.

Non-goals: new features, refactors, the provenance cleanup (separate track), the S-sized items of
package 2 (update signature, tray fast path, handover fallback, renderer respawn, double render).
Anti-goals: any change that adds periodic wakeups, raises in-game RAM, changes the share-code
format, or changes how existing crosshairs render (golden tests must stay identical).

## Constraints

- Behaviour stays compatible: same config schema v5, same share codes, same sprite format.
- Tests: Rust unit tests next to the code (existing style), JS tests in `test/*.test.js`.
- Verification must never touch the user's running instance or `%APPDATA%\Crosshair Z`:
  `cargo test` uses `.test.<pid>` instance endpoints; the smoke test uses `CZ_USERDATA`.
- Work happens on the checked-out branch; nothing is committed without the user asking.

## Approach

Targeted in-place fixes, one per finding, each with a regression test where the code is testable.
Rejected: a larger state refactor (dirty tracking for the whole app) — bigger risk than the package
needs; skipping tests — the package touches persistence and input.

## Decisions (calls made for the user)

- The hide-mode toggle keeps persisting `enabled` (unchanged behaviour); C2/C3 make that safe.
- Persistent config read error: run with the library from `config.json.bak` (else defaults) in
  memory, but never save in that session (no overwrite of a newer file), log ERROR.
- Holding next/prev no longer cycles; only move hotkeys keep auto-repeat.
- A Discover click on an already saved design equips the existing profile.
- Hotkey recording binds the key as labelled on the active layout.
- Clipboard and share-code length cap: 2,000,000 characters on both sides (largest legit code
  ≈ 1.9 M, measured 1,884,166: 64 drawing layers with incompressible 64×64 PNGs); draw sources over
  32,768 characters are dropped on decode.
- D1 image-cache pins: the sources the latest load-listener run drew are not evicted until the next
  run, so the cache caps (256 entries, 64 Mi px) are soft by one listener run's working set. A strict
  LRU would let a redraw that needs more than the caps evict its own images, so every load would
  start another full redraw that misses again (an endless decode loop).
- DLL hardening only through the linker flag `/DEPENDENTLOADFLAG:0x800` (exe imports). No
  `SetDefaultDllDirectories`: it can break WebView2's own dependency loading.

## Items

### Rust — persistence and system (`config/store.rs`, `config/model.rs`, `logger.rs`, `clipboard.rs`, `instance.rs`, `system.rs`, `updater.rs`, `app/updates.rs`)

- P1 `load()`: non-NotFound read errors retried 3× (100/300/900 ms); still failing → library from
  `.bak` if it parses, else defaults; store marked read-only (no saves this session), ERROR log.
- P2 `write_atomic`: create tmp, `write_all`, `sync_all`, then rename.
- P3 `.bak`: before the first save of a session that loaded `config.json` cleanly, copy it to
  `config.json.bak` (synced). `load()` falls back to `.bak` when `config.json` is missing or corrupt.
- P4 a failed save keeps its pending text and retries with backoff 1, 2, 4 … 30 s, only while failing.
- P5 lossy load guard: when the raw version is above `CONFIG_VERSION`, `profiles` is present but not
  an array, or sanitizing drops profiles, copy the file to `config.json.lossy-<ms>` first (WARN log).
- P6 logger: one `write_all` per entry (line + newline); on error pause file logging for 60 s, then
  retry and log "file logging resumed".
- P7 clipboard: read bounded by `GlobalSize`; caps 2,000,000 chars; over-long write returns an error
  instead of truncating.
- P8 instance: `CreateMutexW` access denied counts as "already running"; pipe creation failure
  retries with backoff (1 s doubling, 60 s cap) instead of ending the listener; add
  `PIPE_REJECT_REMOTE_CLIENTS`.
- P9 system: stale Run-value cleanup only touches values whose exe name parses as a Crosshair Z exe
  (`Crosshair Z[ x.y.z].exe`, `Crosshair-Z.exe`) or known legacy value names.
- P10 updater: versions need exactly 3 numeric parts; cleanup skips `.part` files younger than the
  download timeout; total download deadline 10 min; `sync_all` before rename; HTTP 404 logged as a
  warning; housekeeping skips deleting old exes when the login item could not be updated.

### Rust — runtime (`input/hotkeys.rs`, `state.rs`, `app/mod.rs`, `app/ipc.rs`, `overlay/mod.rs`, `overlay/window.rs`, `sprites/cache.rs`, `main.rs`, `build.rs`, `Cargo.toml`)

- R1 `RegisterHotKey` with `MOD_NOREPEAT` for every action except moveUp/Down/Left/Right.
- R2 mouse polling only when `enabled && !launch_hidden` and a feature needs it; `rc_alt` is reset on
  equip, keyboard toggle and tray toggle.
- R3 overlay controller: render only on a real change (new set, new position, visibility); firing
  ticks only while visible and the set has a firing layer; while hidden, levels snap to their target
  without frames; ticks render only when a frame index changed.
- R4 overlay window: topmost reassert on first show, size change, and at most every 250 ms from the
  frame path (timer and foreground hook unchanged); `UpdateLayeredWindow` with `hdcDst = NULL`.
- R5 `emit()` builds its payload only when settings is open; the toggle log line moves after `changed()`.
- R6 failed sprite keys are retried after 60 s instead of staying on the fallback for the session.
- R7 sprite disk cache keeps 512 files and never prunes keys that are held in RAM.
- R8 handover reply over a rendezvous channel; the app quits only if the reply was delivered.
- R9 Tauri async runtime: tokio multi-thread runtime with 2 workers set before the builder.
- R10 `build.rs`: `/DEPENDENTLOADFLAG:0x800` for the msvc binary.
- R11 `clipboard:write` returns `true` on success.

### Settings UI (`src/renderer/settings.js`, `designer.js`, `settings.html`, `src/shared/crosshair-core.js`, `test/`)

- J1 Discover click passes `dedupe`.
- J2 Copy code shows its success toast (needs R11); the copy button uses the same path.
- J3 share-code decode cap 2,000,000 chars, draw sources over 32,768 chars dropped, `maxlength` on the
  import field.
- J4 `sanitizeCrosshair` survives non-array `layers`, non-object layers and null sub-objects; saved
  cards draw sanitized crosshairs.
- J5 undo: pending snapshot flushed before undo/redo; history reset only when the edited profile changes.
- J6 stage drag divides by zoom × display scale; wheel zoom always moves at least one step.
- J7 imported drawings are scaled to 64×64 (no smoothing) before editing.
- J8 hotkey recording: letters from `e.key` (fallback `e.code`), single-char uppercase only, numpad
  operators mapped to `numadd`/`numsub`/`nummult`/`numdiv`/`numdec`, Win key recorded as `Super`.
- J9 the import field keeps its text when the import fails.
- J10 `layerBounds` cannot throw (cap + fallback estimate); one bad layer cannot blank the settings UI.
- J11 the size slider is not reset while the user drags it.
- J12 image cache: LRU with a pixel budget, all inserts through one path, load listener only for
  images still cached, listener calls coalesced into one animation frame, library and Crosshair X
  cards re-rendered too.

## Verification

- `cargo clippy --all-targets -- -D warnings` and `cargo test` (incl. golden) in `native/app`.
- `npm test` at the repo root.
- `cargo build --release` + `native/app/scripts/smoke.ps1` (isolated data dir; briefly shows a test
  crosshair at screen centre).

## Left to the builder

Exact data structures, test shapes, constant names and log wording, as long as the behaviour above
holds and existing tests keep passing.
