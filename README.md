<p align="center">
  <img src="docs/images/banner.png" alt="Crosshair Z — lightweight crosshair overlay for Windows games" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Nn1ff/crosshair-z/releases/latest"><img src="https://img.shields.io/github/v/release/Nn1ff/crosshair-z?label=download&color=7cc4ff" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-Windows-2a2f37" alt="Windows">
  <img src="https://img.shields.io/badge/install-portable%20exe-2a2f37" alt="Portable">
  <img src="https://img.shields.io/badge/idle%20CPU-~0%25-2a2f37" alt="Idle CPU ~0%">
</p>

**Crosshair Z** puts a custom crosshair on top of your game. Choose a pro player's crosshair, design your own pixel by pixel, and switch crosshairs with a hotkey or the right mouse button. It is a single portable exe: no installer, no account, and it does not touch the game.

## Download

**Native Rust beta:** [2.0.0-beta.1](https://github.com/Nn1ff/crosshair-z/releases/tag/v2.0.0-beta.1)
uses a native Windows overlay and WebView2 for settings. The measured tray-only footprint is
5.2 MB of private working set; the portable exe is 3.85 MB. See the
[native build and testing guide](native/README.md) for requirements and validation limits.
The stable download below remains the Electron version during beta testing.

1. Get **`Crosshair-Z.exe`** from the [latest release](https://github.com/Nn1ff/crosshair-z/releases/latest).
2. Run it. You don't need to install anything.
3. Pick a crosshair and play. Run the game in **borderless** or **windowed** mode (exclusive fullscreen hides overlays).

> Windows may warn because the exe is not signed: **More info → Run anyway**.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/images/discover.png" alt="Discover page with your saved crosshairs and a random mix of pro crosshairs"></td>
    <td width="50%"><img src="docs/images/designer.png" alt="Designer with layers, pixel grid and in-game background"></td>
  </tr>
  <tr>
    <td align="center"><b>Discover</b>: your crosshairs plus a fresh mix of pro picks</td>
    <td align="center"><b>Designer</b>: layers on a pixel grid, previewed against a game scene</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/browse.png" alt="Browse collections: CS2, Valorant, Fortnite, Rust and your Crosshair X crosshairs"></td>
    <td width="50%"><img src="docs/images/toggle.png" alt="Toggle options for hotkey and right mouse button"></td>
  </tr>
  <tr>
    <td align="center"><b>Browse</b>: 120+ pro / creator crosshairs by game</td>
    <td align="center"><b>Toggle</b>: hide or switch on hotkey or right-click (great for scopes)</td>
  </tr>
</table>

## Features

**Crosshairs**
- 120+ crosshairs from CS2, Valorant, Fortnite and Rust pros and creators, plus a built-in library
- Discover page with your saved crosshairs and a new random mix on every visit
- Bookmark crosshairs to Saved; each one can have its own hotkey
- Share codes (`CZ3-…`) to swap designs with friends; older `CZ1`/`CZ2` codes still work
- Imports the crosshairs you saved in Crosshair X / Y, including layered designs

**Designer**
- Layers: **crosshair** (lines + center dot), **shape** (square, circle, triangle), **text** (straight or around a circle), **pixel drawing** and **image**
- Line styles: classic, triangle, chevron in/out, arc, T-cap, and 3–8 arms around the center
- Separate color, opacity and blur for lines, dot and outline. Pixel-crisp gaps for odd and even line widths
- Optional firing animation (spread and kick while the left mouse button is held)
- Undo/redo, drag-to-move, scrubbable fields, actual-size preview on dark, light or game backgrounds

**In game**
- Click-through overlay that stays on top of borderless and windowed games
- Show/hide or switch crosshairs with a hotkey or the right mouse button (hold or click)
- Choose the monitor, nudge the position pixel by pixel, scale the whole crosshair

## Lightweight by design

| | |
|---|---|
| **CPU** | ~0% while idle: the overlay only redraws when something changes |
| **RAM** | ~100 MB in game: closing the settings window frees it, only the tiny overlay keeps running |
| **Privacy** | No account, telemetry or ads. One optional update check against GitHub (can be turned off) |
| **Anti-cheat** | A plain transparent window above the game: no DLL injection, no hooks, no memory reading |
| **Footprint** | Portable exe, one native dependency (`koffi`), no background services |

## Updating

When a new version is out, Settings shows **Update**. Crosshair Z downloads the new exe next to the current one, switches over automatically and removes the old copy. Autostart (if enabled) follows the new version, so you never end up with two entries.

## FAQ

**The crosshair doesn't show in game.** Switch the game to borderless/windowed fullscreen. Exclusive fullscreen draws over every overlay.

**Is this safe with anti-cheat?** Crosshair Z never touches the game process. It is an ordinary always-on-top window, like Discord's or Steam's overlay.

**Can I use my Crosshair X crosshairs?** Yes. Saved and Workshop crosshairs from your local Crosshair X data show up under **Browse → Crosshair X**.

## Development

For the Rust beta, follow [native/README.md](native/README.md). The commands below build the
Electron version, which stays available during the beta.

```bash
npm install
npm start           # run the app
npm test            # unit tests (node:test)
npm run dist        # portable exe → release/
npm run build:pack  # rebuild the bundled pro crosshair pack
```

Dev aids:
- `CZ_CAPTURE_DIR=<dir>` renders every page hidden, saves PNGs (the README screenshots come from this) and quits
- `CZ_USERDATA=<dir>` runs with an isolated config

<details>
<summary>Project layout</summary>

```
src/main/       Electron main process: overlay window, tray, hotkeys, mouse polling, updates, autostart
src/renderer/   Settings UI, designer, overlay renderer
src/shared/     Crosshair engine (schema, rendering, share codes), Crosshair X/Y import, preset pack
test/           Unit tests
```
</details>

## Notes & credits

- Crosshair X is a separate product. Crosshair Z only reads crosshair data you saved locally and contains no Crosshair X code or assets.
- Open Sans font: SIL Open Font License 1.1 (`src/renderer/fonts/OFL-LICENSE.txt`)
- Settings gear icon: [Font Awesome Free](https://fontawesome.com) "gear", CC BY 4.0 ([license](https://fontawesome.com/license/free))
