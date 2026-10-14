# Crosshair Z native runtime

The Rust runtime uses a native Win32 overlay. The existing JavaScript designer and
crosshair renderer run in WebView2; the hidden sprite renderer is destroyed when idle.
Closing settings leaves the native overlay running without a browser process.

## Run

Download `Crosshair-Z.exe` from the `v2.0.0` release and run it on Windows.
Microsoft Edge WebView2 Runtime is required for settings and generating uncached crosshairs.
This portable app is unsigned and may trigger Windows SmartScreen.

The native app uses the same `%APPDATA%\Crosshair Z\config.json` as version 1.8.x.
Back up that file before upgrading. Starting version 2.0 replaces a running legacy instance.
The 1.8.x updater offers the stable 2.0 release with the same asset name.

To test with separate data, set `CZ_USERDATA` to a new absolute directory before launching.
This mode skips autostart changes, Start menu integration and legacy-process cleanup.

## Build and verify

Install Rust with the MSVC toolchain, Visual Studio C++ build tools, the Windows SDK,
Node.js and WebView2 Runtime. From the repository root:

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File native/app/scripts/package.ps1
```

The packaging script runs Rust and JavaScript tests, builds the release binary and runs
an isolated live smoke test. It stages `release-native/Crosshair-Z.exe`.
Build-time staging embeds the shared web assets; Electron is not needed to run the result.

```powershell
cd native/app
cargo clippy --all-targets -- -D warnings
cargo test --test golden
```

Golden tests compare composited sprites against Canvas references. The smoke test checks
rendering, disk-cache restart, renderer cleanup, the 15 MB RAM budget and single instance.
One live GitHub network test is ignored by default; run it explicitly when needed.

## Validation coverage and migration

The automated checks cover one local Windows machine. Borderless games, all hotkeys and
right-click modes, mixed DPI at 100/125/150%, and update handover from an installed 1.8.7
were not exhaustively tested in the release validation.
Electron and native monitor identifiers differ: on first migration a saved monitor selection
falls back to the primary display. Re-select the desired display in the native settings.
Firing animation uses 33 pre-rendered levels, or 17 for larger sprite sets.
Electron 1.8.x stays in the repository for reference and fallback builds.
