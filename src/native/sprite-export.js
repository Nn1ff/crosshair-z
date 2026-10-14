/**
 * Renders a crosshair into a sprite set for the native overlay: every visible layer alone, at
 * every firing level, with the same canvas code the Electron overlay used (crosshair-core.js).
 * Needs CrosshairCore + CzSpriteFormat loaded first. Browser only (OffscreenCanvas, fonts).
 */
(function (root) {
  'use strict';

  const C = root.CrosshairCore;
  const F = root.CzSpriteFormat;
  const LEVELS = 33;
  const REDUCED_LEVELS = 17; // spec: sets above 32 MiB fall back to 17 levels
  const MAX_SET_BYTES = 32 * 1024 * 1024;

  function imageSources(ch) {
    const out = [];
    for (const l of ch.layers) {
      if (l.kind === 'image' && l.image && l.image.src) out.push(l.image.src);
      if (l.kind === 'draw' && l.draw && l.draw.src) out.push(l.draw.src);
    }
    return [...new Set(out)];
  }

  /** Decode images and load fonts before drawing, so no layer is drawn half-ready. */
  async function prepareAssets(ch, scale, size) {
    await Promise.all(
      imageSources(ch).map(async (src) => {
        try {
          const img = new Image();
          img.src = src;
          await img.decode();
          C.primeImage(src, img);
        } catch (err) {
          console.warn('sprite export: image failed to decode', err && err.message);
        }
      }),
    );
    // a throwaway draw requests every font the text layers use; then wait for them
    const probe = new OffscreenCanvas(size, size).getContext('2d');
    C.drawCrosshair(probe, ch, size / 2, size / 2, { scale });
    if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;
  }

  function newContext(size) {
    return new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
  }

  /** Crop straight RGBA to its alpha bounding box → frame with premultiplied BGRA. */
  function cropFrame(rgba, size) {
    let minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (rgba[(y * size + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0, bgra: new Uint8Array(0) };
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const cropped = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((minY + row) * size + minX) * 4;
      cropped.set(rgba.subarray(from, from + w * 4), row * w * 4);
    }
    return { x: minX, y: minY, w, h, bgra: F.rgbaToBgraPremul(cropped) };
  }

  /** Crosshair with only layer `index` visible (indices stay aligned for the fire array). */
  function solo(ch, index) {
    return { ...ch, layers: ch.layers.map((l, j) => (j === index ? l : { ...l, visible: false })) };
  }

  function renderSprites(ch, scale, size, levels) {
    const ctx = newContext(size);
    const layers = [];
    ch.layers.forEach((layer, i) => {
      if (!layer.visible) return;
      const fire = !!(layer.firing && layer.firing.enabled);
      const n = fire ? levels : 1;
      const only = solo(ch, i);
      const frames = [];
      for (let k = 0; k < n; k++) {
        const fireLevels = [];
        fireLevels[i] = fire ? k / (n - 1) : 0;
        ctx.clearRect(0, 0, size, size);
        C.drawCrosshair(ctx, only, size / 2, size / 2, { scale, fire: fireLevels });
        frames.push(cropFrame(ctx.getImageData(0, 0, size, size).data, size));
      }
      layers.push({ fireSpeedMs: fire ? layer.firing.speed : null, frames });
    });
    return F.encodeSpriteSet({ sizePx: size, layers });
  }

  /**
   * @param {object} raw crosshair (sanitized here)
   * @param {number} scale display scale
   * @returns {Promise<Uint8Array>} encoded sprite set
   */
  async function buildSpriteSet(raw, scale) {
    const ch = C.sanitizeCrosshair(raw);
    const size = C.overlaySizePx(ch, scale);
    await prepareAssets(ch, scale, size);
    const bytes = renderSprites(ch, scale, size, LEVELS);
    if (bytes.length <= MAX_SET_BYTES) return bytes;
    console.warn('sprite set too large, using fewer firing levels', { bytes: bytes.length });
    return renderSprites(ch, scale, size, REDUCED_LEVELS);
  }

  /**
   * Reference image for golden tests: the whole crosshair drawn at once with every firing layer at
   * `level`, as premultiplied BGRA of the full canvas.
   */
  async function renderReference(raw, scale, level) {
    const ch = C.sanitizeCrosshair(raw);
    const size = C.overlaySizePx(ch, scale);
    await prepareAssets(ch, scale, size);
    const ctx = newContext(size);
    const fireLevels = ch.layers.map((l) => (l.firing && l.firing.enabled ? level : 0));
    C.drawCrosshair(ctx, ch, size / 2, size / 2, { scale, fire: fireLevels });
    return { size, bgra: F.rgbaToBgraPremul(ctx.getImageData(0, 0, size, size).data) };
  }

  root.CzSpriteExport = { LEVELS, buildSpriteSet, renderReference };
})(typeof self !== 'undefined' ? self : this);
