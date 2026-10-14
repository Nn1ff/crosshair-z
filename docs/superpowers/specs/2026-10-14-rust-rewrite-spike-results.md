# Rust Rewrite — Spike Results

Date: 2026-10-14
Machine: AMD Ryzen 7 5700X3D, 32 GB RAM, Windows 11 build 26200, WebView2 155.0.4283.45, 1920×1080 primary display
Spike: Tauri 2.12.3, Rust 1.99.0, release build (`opt-level="s"`, LTO, strip) → **3.00 MB exe**
Raw data: `native/spike/results/`

## Toolchain finding (blocks Plan 2 as specified)

This machine's VS 2022 Build Tools are incomplete: `link.exe`, `cl.exe` and the x64 `rc.exe` are
missing, although CRT and Windows SDK libraries are present. The spike works around it
(`native/spike/.cargo/config.toml`: rust-lld in lld-link mode, explicit `LIB`/`RC`; `vswhom` stubbed
because it compiles C++). `tauri-cli` could not be installed (its dependencies need a C compiler).

**Before Plan 2:** repair the Build Tools in Visual Studio Installer → Modify → "Desktop development
with C++" (MSVC v143 x64/x86 build tools + Windows 11 SDK). Needs admin rights.

## Baseline Electron 1.8.7 (settings closed, live user instance, 30 s idle)

```
5 processes, private working set 70,0 MB
  Crosshair Z#1    26,5 MB   (renderer)
  Crosshair Z      25,1 MB   (main)
  Crosshair Z#3    10,1 MB
  Crosshair Z#2     5,1 MB
  Crosshair Z 1.8.7 3,3 MB   (portable launcher)
CPU over 30s: 0,00 %
```

Correction: the earlier chat estimate "150–300 MB" was wrong; the real in-game cost of 1.8.7 is
**~70 MB**. Note the user's crosshair was disabled (`enabled: false`) during this measurement; an
enabled overlay may add a little in the renderer.

## A — WebView2 lifecycle → **GO**

| Moment | Processes | Private WS MB | CPU % |
|---|---|---|---|
| start, no webview | 1 | 1.5 | 0.00 |
| webview open | 7 | 94.4 | 0.02 |
| close +1 s | 1 | 3.8 | 0.00 |
| close +10 s | 1 | 3.8 | 0.00 |
| close +60 s | 1 | 3.7 | 0.00 |
| after 5 open/close cycles, +10 s | 1 | 4.0 | 0.00 |
| reopen after cycles | 7 | 102.0 | 0.00 |

All `msedgewebview2` processes are gone within 1 s of destroying the last webview. The host keeps
~2.3 MB after the first webview (loaded WebView2 loader / Tauri runtime), +0.3 MB after 5 cycles
(no meaningful leak). Process stays alive with zero windows, reopen works.

Note: with settings **open**, the WebView2 tree (~95–100 MB) is heavier than all of Electron 1.8.7
(70 MB). Acceptable per spec (only in-game cost matters), but worth stating to users.

## B — Layered overlay → **GO (proxy); real games PENDING-USER**

Overlay only, no webview ever opened, 30 s: **1.5 MB private WS, 0.00 % CPU**.

`check-overlay.ps1`: window has all five extended styles (LAYERED, TRANSPARENT, TOPMOST, NOACTIVATE,
TOOLWINDOW), screen capture shows 96/96 expected red pixels.

Proxy (`fake-game.ps1`: black borderless maximized window, focused):

| Fake game | Visible samples during game |
|---|---|
| realistic (not topmost, re-activates every 500 ms) | 3/3 |
| hostile (topmost + activate every 500 ms), reassert = `HWND_TOPMOST` only | 0/4 |
| hostile, reassert = `HWND_TOPMOST` then `HWND_TOP` | 2/6 |

Finding: `SetWindowPos(HWND_TOPMOST)` does not re-raise a window that is already topmost above
other topmost windows; adding `SetWindowPos(HWND_TOP)` does. Plan 2 must reassert with both, and
should additionally react to `EVENT_SYSTEM_FOREGROUND` (SetWinEventHook) instead of only a timer.
The hostile proxy is a worst case; ordinary borderless games are not topmost.

Electron comparison against the proxy was discarded (user's crosshair disabled → nothing to see).

**PENDING-USER** (needs a human): 2 real games in borderless mode, 10 min each with alt-tab;
DPI 125 % / secondary monitor sharpness and centering. Run:
```
native\spike\target\release\cz-spike.exe   → type: overlay
```

## C — Raw IPC → **GO**

| Size | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| 1 MB | 17.2 ms | 15.6 ms | 16.5 ms |
| 8 MB | 91.7 ms | 104.0 ms | 105.4 ms |
| 32 MB | 393.7 ms | 436.6 ms | 400.2 ms |

Raw body (`InvokeBody::Raw`) confirmed, no base64. ~80 MB/s; 32 MB worst case is under the 500 ms
limit but with little margin. Realistic SpriteSets are far smaller (a 33-frame firing layer of
100×100 px ≈ 1.3 MB → ~20 ms).

## D — Hidden webview start → **GO**

Cold (WebView2 profile dir `EBWebView` deleted): **415 ms**. Warm: 457 / 429 / 383 ms; in the A run
481 ms first, then 329–352 ms. Well under 1,500 ms. Not measured: first start after a reboot
(WebView2 binaries not in file cache), expected slower.

## Decision

**GO** — Plan 2 as specified, with these changes:

1. Topmost reassert = `HWND_TOPMOST` + `HWND_TOP`, plus `EVENT_SYSTEM_FOREGROUND` hook (spec §4 update).
2. Toolchain repair is a precondition of Plan 2 (admin, user action).
3. Real-game test of B stays a manual acceptance item before beta (spec §7 checklist already lists it).

Expected in-game cost of 2.0 from these numbers: ~2–4 MB (overlay + host after settings were
opened once) vs 70 MB today → **~95 % less RAM**; exe ~3–5 MB vs 68 MB.
