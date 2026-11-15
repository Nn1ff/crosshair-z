/**
 * Crosshair Z input helpers: hotkey recording (KeyboardEvent → accelerator string) and the designer's
 * zoom / drag math. Pure functions, no DOM access.
 * UMD module — required by the tests, loaded as <script> by the settings page (window.CzInput).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CzInput = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Keys that only modify; AltGraph is what Windows reports for AltGr pressed on its own. */
  const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta']);
  const KEY_MAP = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    '+': 'Plus', Escape: 'Esc', Enter: 'Return',
  };
  const NUMPAD_OPS = {
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  };
  const ZOOM_STEP = 1.15;

  /** Key part of an accelerator, or '' when the event names no usable key. */
  function keyName(key, code) {
    if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
    if (NUMPAD_OPS[code]) return NUMPAD_OPS[code];
    // letters as labelled on the active layout (German Z on the Y key), else the physical key
    // (AltGr+Q types '@', Cyrillic layouts type 'я' on Z)
    if (/^[A-Za-z]$/.test(key)) return key.toUpperCase();
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Shift+1 types '!'
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
    if (KEY_MAP[key]) return KEY_MAP[key];
    if (key.length === 1) {
      const upper = key.toUpperCase();
      return upper.length === 1 ? upper : key; // 'ß' would become 'SS'
    }
    return key;
  }

  /**
   * KeyboardEvent → Electron-style accelerator ("CommandOrControl+Alt+Shift+Super+Key"),
   * or null while only modifiers are held.
   * @param {{key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean}} e
   * @returns {string|null}
   */
  function toAccelerator(e) {
    const key = e && typeof e.key === 'string' ? e.key : '';
    const code = e && typeof e.code === 'string' ? e.code : '';
    if (MOD_KEYS.has(key)) return null;
    const name = keyName(key, code);
    if (!name) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    return [...mods, name].join('+');
  }

  /**
   * Next designer zoom for one wheel step: ×/÷1.15, but always at least one whole step, clamped.
   * @param {number} z current zoom
   * @param {boolean} up zoom in
   * @returns {number}
   */
  function nextZoom(z, up, min = 2, max = 40) {
    const cur = Number.isFinite(z) ? z : min;
    const scaled = Math.round(up ? cur * ZOOM_STEP : cur / ZOOM_STEP);
    const next = up ? Math.max(cur + 1, scaled) : Math.min(cur - 1, scaled);
    return Math.min(max, Math.max(min, next));
  }

  /**
   * Layer offset change for a pointer move of `px` CSS pixels on the stage: one offset unit is drawn
   * `scale` (display scale) crosshair pixels wide, each shown `zoom` CSS pixels wide.
   * @returns {number} whole offset units (0 for degenerate input)
   */
  function dragDelta(px, zoom, scale) {
    const unit = zoom * scale;
    if (!(unit > 0) || !Number.isFinite(px)) return 0;
    return Math.round(px / unit) || 0; // || 0: no -0
  }

  return { toAccelerator, nextZoom, dragDelta };
});
