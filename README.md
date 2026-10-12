# Crosshair Z

Custom crosshair overlay for Windows games.

## Features

- Transparent, click-through overlay that stays on top of borderless/windowed games
- Layered designer on a pixel grid: lines, outline, center dot, circle, image layers, blur
- Firing animation (spread / kick) on left mouse button
- Toggle by hotkey or right mouse button (hide or switch to a second crosshair)
- Per-crosshair hotkeys, monitor selection, pixel offset, overall size
- Share codes (`CZ2-…`)
- Import of your own saved Crosshair X crosshairs from local data files
- Newer version launched while an older one runs → automatic handover

## Development

```bash
npm install
npm start          # run app
npm test           # unit tests
npm run dist       # portable exe → release/
```

Dev aids:
- `CZ_CAPTURE_DIR=<dir>` renders every page hidden and saves PNGs, then quits
- `CZ_USERDATA=<dir>` runs with an isolated config

## Notes

- Exclusive fullscreen games hide overlays; use borderless/windowed mode.
- Crosshair X is a separate product. Crosshair Z only reads crosshair data you saved locally; it contains no Crosshair X code or assets.
