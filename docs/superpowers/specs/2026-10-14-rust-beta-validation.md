# Rust beta completion — 2026-10-14

Continued the existing `rust-rewrite` branch after Claude Code reached its session limit.
The approved hybrid design and core-runtime plan remain the implementation authority.

## Completion

- Version and packaged asset: `2.0.0-beta.1`, `release-native/Crosshair-Z.exe`.
- Added `native/app/scripts/package.ps1` to run tests, build and validate the portable asset.
- Documented native setup, migration and manual acceptance limits in `native/README.md`.
- Corrected relayout freezing the firing animation, stale settings-close timeouts and
  queued render jobs using their timeout budget before processing began.
- A fresh review identified these defects; the reviewer checked the fixes without finding
  additional actionable regressions.

## Verification

- Overlay and queue regressions failed before their fixes and passed afterward.
- Settings close-request lifecycle test rejects stale timeouts after close/reopen.
- Rust unit suite: 104 passed, 0 failed; 1 live-network test ignored by default.
- JavaScript suite: 41 passed, 0 failed.
- Golden image comparison: 54 designs at 3 firing levels (162 references), tolerance 1/channel.
- `cargo clippy --all-targets -- -D warnings`: passed.
- Packaging script: release build and all 8 live smoke checks passed.
- Private working set after idle: 5.2 MB; no remaining renderer WebView2 processes.
- Portable exe: 3.85 MB, version `2.0.0-beta.1`.
- `git diff --check`: passed.

## Rulings and remaining acceptance

Plan 2 explicitly specifies primary-monitor fallback for unknown migrated Electron monitor IDs.
This beta keeps that rule and documents the required one-time display re-selection.
It is a migration limit, not proof of full mixed-DPI acceptance.

Borderless game coverage, all hotkeys/right-click modes, mixed monitor DPI and installed
1.8.7 update handover remain manual checks before stable 2.0. The beta is a prerelease;
stable users continue to receive the existing stable release through their updater.
