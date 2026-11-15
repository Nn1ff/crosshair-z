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

  /**
   * Decode images and load fonts before drawing, so no layer is drawn half-ready. Returns the
   * decoded images by source: the build keeps them, since the shared image cache may evict a primed
   * image (count or pixel cap) before its layer is drawn.
   */
  async function prepareAssets(ch, scale, size) {
    const decoded = new Map();
    await Promise.all(
      imageSources(ch).map(async (src) => {
        try {
          const img = new Image();
          img.src = src;
          await img.decode();
          decoded.set(src, img);
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
    return decoded;
  }

  /**
   * Put the images of `layers` back into the cache right before they are drawn. The entry put last
   * is never evicted, and a solo layer draws one image, so it is always there; the copy has the
   * pixels of the first priming, so the output is unchanged.
   */
  function primeLayers(layers, decoded) {
    for (const src of imageSources({ layers })) {
      const img = decoded.get(src);
      if (img) C.primeImage(src, img);
    }
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

  async function renderSprites(ch, scale, size, levels, decoded) {
    const ctx = newContext(size);
    const layers = [];
    for (let i = 0; i < ch.layers.length; i++) {
      const layer = ch.layers[i];
      if (!layer.visible) continue;
      const fire = !!(layer.firing && layer.firing.enabled);
      const n = fire ? levels : 1;
      const only = solo(ch, i);
      const frames = [];
      // earlier layers' svg rasters may have pushed this layer's image out of the cache. Its own
      // frames add nothing to the cache and never wait on a decode (an image or drawing layer has
      // no svg to prepare), so once primed here it stays until they are all drawn.
      primeLayers([layer], decoded);
      for (let k = 0; k < n; k++) {
        const fireLevels = [];
        fireLevels[i] = fire ? k / (n - 1) : 0;
        await C.prepareCrosshair(only, { scale, fire: fireLevels });
        ctx.clearRect(0, 0, size, size);
        C.drawCrosshair(ctx, only, size / 2, size / 2, { scale, fire: fireLevels });
        frames.push(cropFrame(ctx.getImageData(0, 0, size, size).data, size));
      }
      layers.push({ fireSpeedMs: fire ? layer.firing.speed : null, frames });
    }
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
    const decoded = await prepareAssets(ch, scale, size); // held for the whole build
    const bytes = await renderSprites(ch, scale, size, LEVELS, decoded);
    if (bytes.length <= MAX_SET_BYTES) return bytes;
    console.warn('sprite set too large, using fewer firing levels', { bytes: bytes.length });
    return renderSprites(ch, scale, size, REDUCED_LEVELS, decoded);
  }

  /**
   * Reference image for golden tests: the whole crosshair drawn at once with every firing layer at
   * `level`, as premultiplied BGRA of the full canvas.
   */
  async function renderReference(raw, scale, level) {
    const ch = C.sanitizeCrosshair(raw);
    const size = C.overlaySizePx(ch, scale);
    const decoded = await prepareAssets(ch, scale, size);
    const ctx = newContext(size);
    const fireLevels = ch.layers.map((l) => (l.firing && l.firing.enabled ? level : 0));
    await C.prepareCrosshair(ch, { scale, fire: fireLevels });
    // one draw needs every image at once: all are back in the cache unless together they exceed
    // its pixel budget (the last one primed always stays)
    primeLayers(ch.layers.filter((l) => l.visible), decoded);
    C.drawCrosshair(ctx, ch, size / 2, size / 2, { scale, fire: fireLevels });
    return { size, bgra: F.rgbaToBgraPremul(ctx.getImageData(0, 0, size, size).data) };
  }

  root.CzSpriteExport = { LEVELS, buildSpriteSet, renderReference };
})(typeof self !== 'undefined' ? self : this);
