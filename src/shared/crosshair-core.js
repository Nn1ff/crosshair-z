/**
 * Crosshair Z core: schema, validation, layered rendering, firing animation, share codes.
 * UMD module — used by main process (require) and renderers (<script>).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrosshairCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHARE_PREFIX = 'CZ2-';
  const LEGACY_SHARE_PREFIX = 'CZ1-';
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  const MAX_IMAGE_CHARS = 1500000;
  const MAX_LAYERS = 8;
  const OVERLAY_PADDING_PX = 4;
  const MIN_OVERLAY_PX = 32;
  const MAX_IMAGE_CACHE = 32;

  /** Leaf specs: n = number, b = boolean, c = hex color, e = enum, s = string, img = image data URL. */
  const LAYER_SCHEMA = {
    name: { t: 's', max: 24 },
    visible: { t: 'b' },
    kind: { t: 'e', values: ['shape', 'image'] },
    offsetX: { t: 'n', min: -300, max: 300, int: true },
    offsetY: { t: 'n', min: -300, max: 300, int: true },
    color: { t: 'c' },
    opacity: { t: 'n', min: 0, max: 1 },
    rotation: { t: 'n', min: -180, max: 180, int: true },
    scale: { t: 'n', min: 0.25, max: 8 },
    blur: { t: 'n', min: 0, max: 10, int: true },
    lines: {
      enabled: { t: 'b' },
      length: { t: 'n', min: 0, max: 100, int: true },
      thickness: { t: 'n', min: 1, max: 20, int: true },
      gap: { t: 'n', min: -20, max: 60, int: true },
      top: { t: 'b' },
      bottom: { t: 'b' },
      left: { t: 'b' },
      right: { t: 'b' },
    },
    outline: {
      enabled: { t: 'b' },
      thickness: { t: 'n', min: 1, max: 6, int: true },
      color: { t: 'c' },
      opacity: { t: 'n', min: 0, max: 1 },
    },
    dot: {
      enabled: { t: 'b' },
      size: { t: 'n', min: 1, max: 20, int: true },
      shape: { t: 'e', values: ['square', 'circle'] },
      color: { t: 'c' },
      useMainColor: { t: 'b' },
    },
    circle: {
      enabled: { t: 'b' },
      radius: { t: 'n', min: 1, max: 120, int: true },
      thickness: { t: 'n', min: 1, max: 12, int: true },
    },
    image: {
      src: { t: 'img' },
      size: { t: 'n', min: 4, max: 512, int: true },
    },
    firing: {
      enabled: { t: 'b' },
      spread: { t: 'n', min: 0, max: 60, int: true },
      kick: { t: 'n', min: 0, max: 60, int: true },
      speed: { t: 'n', min: 20, max: 1000, int: true },
    },
  };

  const DEFAULT_LAYER = deepFreeze({
    name: 'Layer 1',
    visible: true,
    kind: 'shape',
    offsetX: 0,
    offsetY: 0,
    color: '#00ff66',
    opacity: 1,
    rotation: 0,
    scale: 1,
    blur: 0,
    lines: { enabled: true, length: 6, thickness: 2, gap: 3, top: true, bottom: true, left: true, right: true },
    outline: { enabled: true, thickness: 1, color: '#000000', opacity: 1 },
    dot: { enabled: false, size: 2, shape: 'square', color: '#ffffff', useMainColor: true },
    circle: { enabled: false, radius: 12, thickness: 1 },
    image: { src: '', size: 64 },
    firing: { enabled: false, spread: 6, kick: 0, speed: 120 },
  });

  const DEFAULT_CROSSHAIR = deepFreeze({ layers: [DEFAULT_LAYER] });

  function deepFreeze(o) {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
    return Object.freeze(o);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // ---------- validation ----------

  function isLeaf(node) {
    return node && typeof node.t === 'string';
  }

  function sanitizeLeaf(spec, value, fallback) {
    switch (spec.t) {
      case 'b':
        return typeof value === 'boolean' ? value : fallback;
      case 'c':
        return typeof value === 'string' && COLOR_RE.test(value) ? value.toLowerCase() : fallback;
      case 'e':
        return spec.values.includes(value) ? value : fallback;
      case 's':
        return typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').trim().slice(0, spec.max) || fallback : fallback;
      case 'img':
        return typeof value === 'string' && value.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(value) ? value : fallback;
      case 'n': {
        const num = typeof value === 'number' ? value : Number(value);
        if (value === null || value === '' || !Number.isFinite(num)) return fallback;
        const clamped = Math.min(spec.max, Math.max(spec.min, num));
        return spec.int ? Math.round(clamped) : Math.round(clamped * 1000) / 1000;
      }
      default:
        return fallback;
    }
  }

  function sanitizeNode(schema, defaults, input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    for (const key of Object.keys(schema)) {
      out[key] = isLeaf(schema[key])
        ? sanitizeLeaf(schema[key], src[key], defaults[key])
        : sanitizeNode(schema[key], defaults[key], src[key]);
    }
    return out;
  }

  /**
   * Validate one layer; unknown keys dropped, bad values replaced by defaults.
   * @param {unknown} input
   * @returns {object}
   */
  function sanitizeLayer(input) {
    return sanitizeNode(LAYER_SCHEMA, DEFAULT_LAYER, input);
  }

  /**
   * Validate crosshair. Accepts v2 ({layers}) and legacy v1 (flat single design).
   * @param {unknown} input
   * @returns {{layers: object[]}}
   */
  function sanitizeCrosshair(input) {
    const src = input && typeof input === 'object' ? input : {};
    const rawLayers = Array.isArray(src.layers) ? src.layers : input && typeof input === 'object' && !('layers' in src) ? [src] : [];
    const layers = rawLayers.slice(0, MAX_LAYERS).filter((l) => l && typeof l === 'object').map(sanitizeLayer);
    // Image layer without picture is useless → keep it but it renders nothing; ensure at least one layer.
    if (layers.length === 0) layers.push(clone(DEFAULT_LAYER));
    return { layers };
  }

  // ---------- geometry ----------

  function px(v, s) {
    return Math.max(1, Math.round(v * s));
  }

  /** Max distance (physical px) from layer anchor any pixel reaches, incl. full firing spread. */
  function layerExtent(layer, globalScale) {
    const s = layer.scale * globalScale;
    const o = layer.outline.enabled ? layer.outline.thickness : 0;
    const spread = layer.firing.enabled ? layer.firing.spread : 0;
    let r = 0;
    if (layer.kind === 'image') {
      r = (layer.image.size * s * Math.SQRT2) / 2;
    } else {
      if (layer.lines.enabled) {
        const along = Math.abs(layer.lines.gap + spread) + layer.lines.length;
        r = Math.max(r, Math.hypot(along, layer.lines.thickness / 2) * s + o);
      }
      if (layer.circle.enabled) r = Math.max(r, (layer.circle.radius + spread + layer.circle.thickness) * s + o);
      if (layer.dot.enabled) r = Math.max(r, layer.dot.size * s * Math.SQRT2 + o);
    }
    const kick = layer.firing.enabled ? layer.firing.kick * globalScale : 0;
    const off = Math.hypot(layer.offsetX, layer.offsetY) * globalScale;
    return Math.ceil(r + off + kick + layer.blur * 2);
  }

  /**
   * Max extent over visible layers.
   * @param {object} ch sanitized crosshair
   * @param {number} [globalScale=1]
   */
  function crosshairExtent(ch, globalScale = 1) {
    return ch.layers.reduce((m, l) => (l.visible ? Math.max(m, layerExtent(l, globalScale)) : m), 0);
  }

  /** Overlay canvas edge length in physical px (even). */
  function overlaySizePx(ch, globalScale = 1) {
    const size = Math.max(MIN_OVERLAY_PX, 2 * (crosshairExtent(ch, globalScale) + OVERLAY_PADDING_PX));
    return size + (size % 2);
  }

  /**
   * Arm rects in local coords. Origin sits at pixel center for odd thickness (snap = 0.5),
   * so arms are shifted by snap along their axis to land on whole pixels (no half-pixel AA edges).
   */
  function lineRects(layer, s, extraGap, snap) {
    const L = layer.lines;
    const t = px(L.thickness, s);
    const len = Math.round(L.length * s);
    const gap = Math.round((L.gap + extraGap) * s);
    if (!L.enabled || len <= 0) return [];
    const half = t / 2;
    const rects = [];
    if (L.right) rects.push([gap + snap, -half, len, t]);
    if (L.left) rects.push([-gap - snap - len, -half, len, t]);
    if (L.bottom) rects.push([-half, gap + snap, t, len]);
    if (L.top) rects.push([-half, -gap - snap - len, t, len]);
    return rects;
  }

  // ---------- drawing ----------

  const imageCache = new Map();
  let imageListener = null;

  /** Register callback fired when an image layer finishes decoding (to trigger re-render). */
  function onImageLoaded(cb) {
    imageListener = cb;
  }

  function getImage(src) {
    if (!src || typeof Image === 'undefined') return null;
    let img = imageCache.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => imageListener && imageListener();
      img.onerror = () => console.warn('crosshair image failed to decode');
      img.src = src;
      imageCache.set(src, img);
      if (imageCache.size > MAX_IMAGE_CACHE) imageCache.delete(imageCache.keys().next().value);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Shape pass with alpha 1. grow > 0 = outline silhouette. */
  function drawShapePass(ctx, layer, s, extraGap, grow, color, dotColor, snap) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    for (const [x, y, w, h] of lineRects(layer, s, extraGap, snap)) ctx.fillRect(x - grow, y - grow, w + grow * 2, h + grow * 2);
    if (layer.circle.enabled) {
      ctx.lineWidth = px(layer.circle.thickness, s) + grow * 2;
      ctx.beginPath();
      ctx.arc(0, 0, (layer.circle.radius + extraGap) * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (layer.dot.enabled) {
      ctx.fillStyle = dotColor;
      const size = px(layer.dot.size, s) + grow * 2;
      // Origin is at floor+snap; pick rect start so absolute coords are whole pixels
      // even when dot size parity differs from line thickness parity.
      const start = Math.floor(-size / 2 + snap) - snap;
      if (layer.dot.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(start + size / 2, start + size / 2, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(start, start, size, size);
      }
    }
  }

  /** Scratch canvases reused across frames (keyed by slot). */
  const scratch = [];
  function scratchCtx(slot, w, h) {
    let c = scratch[slot];
    if (!c) {
      c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      scratch[slot] = c;
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  function withAnchor(ctx, x, y, snap, rotation, fn) {
    ctx.save();
    ctx.translate(Math.floor(x) + snap, Math.floor(y) + snap);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    fn(ctx);
    ctx.restore();
  }

  /**
   * Render one shape layer into scratch at full alpha, then composite once with layer opacity.
   * Prevents darker edges/overlaps when opacity < 1 (uniform transparency).
   */
  function drawShapeLayer(ctx, layer, x, y, s, fire) {
    const { width: w, height: h } = ctx.canvas;
    // Round spread so animated gap stays on whole pixels.
    const extraGap = layer.firing.enabled ? Math.round(layer.firing.spread * fire * s) / s : 0;
    const snap = px(layer.lines.thickness, s) % 2 ? 0.5 : 0;
    const dotColor = layer.dot.useMainColor ? layer.color : layer.dot.color;
    const fillCtx = scratchCtx(0, w, h);
    withAnchor(fillCtx, x, y, snap, layer.rotation, (c) => drawShapePass(c, layer, s, extraGap, 0, layer.color, dotColor, snap));
    const layerCtx = scratchCtx(1, w, h);
    if (layer.outline.enabled) {
      const lineCtx = scratchCtx(2, w, h);
      const o = layer.outline.thickness;
      const oc = layer.outline.color;
      withAnchor(lineCtx, x, y, snap, layer.rotation, (c) => drawShapePass(c, layer, s, extraGap, o, oc, oc, snap));
      // Cut fill area out of outline so semi-transparent outline never shows under fill.
      lineCtx.globalCompositeOperation = 'destination-out';
      lineCtx.drawImage(fillCtx.canvas, 0, 0);
      layerCtx.globalAlpha = layer.outline.opacity;
      layerCtx.drawImage(lineCtx.canvas, 0, 0);
      layerCtx.globalAlpha = 1;
    }
    layerCtx.drawImage(fillCtx.canvas, 0, 0);
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    if (layer.blur) ctx.filter = `blur(${layer.blur}px)`;
    ctx.drawImage(layerCtx.canvas, 0, 0);
    ctx.restore();
  }

  function drawImageLayer(ctx, layer, x, y, s) {
    const img = getImage(layer.image.src);
    if (!img) return;
    const size = layer.image.size * s;
    const ratio = img.naturalWidth / img.naturalHeight;
    const w = ratio >= 1 ? size : size * ratio;
    const h = ratio >= 1 ? size / ratio : size;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    if (layer.blur) ctx.filter = `blur(${layer.blur}px)`;
    ctx.imageSmoothingEnabled = true;
    withAnchor(ctx, x, y, 0, layer.rotation, (c) => c.drawImage(img, -w / 2, -h / 2, w, h));
    ctx.restore();
  }

  /**
   * Render crosshair centered on (cx, cy) in physical pixel space.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{layers: object[]}} ch sanitized crosshair
   * @param {number} cx
   * @param {number} cy
   * @param {{scale?: number, fire?: number[]}} [opts] global scale; per-layer firing level 0..1
   */
  function drawCrosshair(ctx, ch, cx, cy, opts = {}) {
    const g = opts.scale || 1;
    ch.layers.forEach((layer, i) => {
      if (!layer.visible) return;
      const fire = (opts.fire && opts.fire[i]) || 0;
      const kick = layer.firing.enabled ? layer.firing.kick * fire : 0;
      const x = cx + layer.offsetX * g;
      const y = cy + (layer.offsetY - kick) * g;
      const s = layer.scale * g;
      if (layer.kind === 'image') drawImageLayer(ctx, layer, x, y, s);
      else drawShapeLayer(ctx, layer, x, y, s, fire);
    });
  }

  /**
   * Pixel bounding box of one layer as rendered (alpha > 0), relative to crosshair center.
   * Browser only (needs OffscreenCanvas). Returns null when layer draws nothing.
   * @returns {{x:number,y:number,w:number,h:number}|null}
   */
  function layerBounds(ch, index, opts = {}) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const l = ch.layers[index];
    if (!l) return null;
    const solo = { layers: ch.layers.map((x, i) => Object.assign({}, x, { visible: i === index })) };
    const size = overlaySizePx(solo, opts.scale || 1);
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    drawCrosshair(ctx, solo, size / 2, size / 2, opts);
    const data = ctx.getImageData(0, 0, size, size).data;
    let minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[(y * size + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX - size / 2, y: minY - size / 2, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // ---------- firing animation ----------

  /**
   * Per-layer firing level animator. Level rises toward 1 while firing, falls to 0 after.
   */
  class FireAnimator {
    constructor() {
      this.levels = [];
      this.firing = false;
    }

    setFiring(on) {
      this.firing = !!on;
    }

    /**
     * Advance by dt ms. Returns true while still animating.
     * @param {number} dt
     * @param {{layers: object[]}} ch
     */
    step(dt, ch) {
      let moving = false;
      this.levels.length = ch.layers.length;
      ch.layers.forEach((layer, i) => {
        const cur = this.levels[i] || 0;
        const target = this.firing && layer.firing.enabled ? 1 : 0;
        if (cur === target) {
          this.levels[i] = cur;
          return;
        }
        const delta = dt / layer.firing.speed;
        const next = target > cur ? Math.min(1, cur + delta) : Math.max(0, cur - delta);
        this.levels[i] = next;
        if (next !== target) moving = true;
      });
      return moving;
    }
  }

  function hasFiring(ch) {
    return ch.layers.some((l) => l.visible && l.firing.enabled);
  }

  // ---------- share codes ----------

  function bytesToBase64Url(bytes) {
    let b64;
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
    else b64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  /** Deep diff vs defaults → only changed keys (keeps codes short). */
  function diff(obj, def) {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (obj[k] && typeof obj[k] === 'object') {
        const d = diff(obj[k], def[k]);
        if (Object.keys(d).length) out[k] = d;
      } else if (obj[k] !== def[k]) {
        out[k] = obj[k];
      }
    }
    return out;
  }

  /** True if crosshair contains image layers (not shareable). */
  function hasImageLayers(ch) {
    return ch.layers.some((l) => l.kind === 'image');
  }

  /**
   * Encode crosshair as share code. Image layers are dropped (too large to share).
   * Throws if nothing shareable remains.
   * @param {object} ch
   * @returns {string}
   */
  function encodeShareCode(ch) {
    const layers = sanitizeCrosshair(ch).layers.filter((l) => l.kind !== 'image');
    if (!layers.length) throw new Error('Image crosshairs cannot be shared');
    const compact = layers.map((l) => diff(l, DEFAULT_LAYER));
    return SHARE_PREFIX + bytesToBase64Url(new TextEncoder().encode(JSON.stringify(compact)));
  }

  /**
   * Decode share code (CZ2 or legacy CZ1). Throws Error with readable message when invalid.
   * @param {string} code
   * @returns {{layers: object[]}}
   */
  function decodeShareCode(code) {
    const trimmed = typeof code === 'string' ? code.trim() : '';
    const prefix = [SHARE_PREFIX, LEGACY_SHARE_PREFIX].find((p) => trimmed.startsWith(p));
    if (!prefix) throw new Error('Code must start with ' + SHARE_PREFIX);
    const body = trimmed.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('Code contains invalid characters');
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
    } catch (err) {
      throw new Error('Code is corrupted');
    }
    const ch = sanitizeCrosshair(prefix === SHARE_PREFIX ? { layers: Array.isArray(parsed) ? parsed : [] } : parsed);
    ch.layers.forEach((l) => {
      l.kind = 'shape';
      l.image.src = '';
    });
    return ch;
  }

  // ---------- presets ----------

  function layer(patch) {
    const base = clone(DEFAULT_LAYER);
    for (const k of Object.keys(patch)) {
      base[k] = patch[k] && typeof patch[k] === 'object' ? Object.assign(base[k], patch[k]) : patch[k];
    }
    return base;
  }

  function preset(category, name, ...patches) {
    const layers = patches.length ? patches : [{}];
    return { category, name, crosshair: sanitizeCrosshair({ layers: layers.map((p, i) => layer({ name: `Layer ${i + 1}`, ...p })) }) };
  }

  const NO_LINES = { enabled: false };
  const NO_OUTLINE = { enabled: false };
  const FIRE = (spread, kick = 0, speed = 120) => ({ enabled: true, spread, kick, speed });

  /** Original Crosshair Z library. */
  const PRESETS = [
    preset('Classic', 'Classic Green', {}),
    preset('Classic', 'Classic Cyan', { color: '#00e5ff' }),
    preset('Classic', 'Classic Yellow', { color: '#ffe600' }),
    preset('Classic', 'Classic Magenta', { color: '#ff2bd6' }),
    preset('Classic', 'Plus Dot', { color: '#ffe600', lines: { gap: 4, length: 5 }, dot: { enabled: true, size: 2 } }),
    preset('Classic', 'Wide Gap', { color: '#00ff66', lines: { gap: 8, length: 6 } }),
    preset('Classic', 'Thick Bold', { color: '#ffffff', lines: { thickness: 4, length: 8, gap: 4 }, outline: { thickness: 2 } }),
    preset('Classic', 'No Outline', { color: '#00ffff', outline: NO_OUTLINE }),

    preset('Dot', 'Tiny Dot', { color: '#ff2bd6', lines: NO_LINES, dot: { enabled: true, size: 3 } }),
    preset('Dot', 'Pixel Dot', { color: '#00ff66', lines: NO_LINES, dot: { enabled: true, size: 1 } }),
    preset('Dot', 'Round Dot', { color: '#ff3b3b', lines: NO_LINES, dot: { enabled: true, size: 5, shape: 'circle' } }),
    preset('Dot', 'Big Square', { color: '#ffe600', lines: NO_LINES, dot: { enabled: true, size: 6 } }),
    preset('Dot', 'Ghost Dot', { color: '#ffffff', opacity: 0.6, lines: NO_LINES, dot: { enabled: true, size: 3, shape: 'circle' }, outline: NO_OUTLINE }),

    preset('Circle', 'Circle Dot', { color: '#ffffff', lines: NO_LINES, dot: { enabled: true, size: 2, shape: 'circle' }, circle: { enabled: true, radius: 14 } }),
    preset('Circle', 'Ring', { color: '#00ff66', lines: NO_LINES, circle: { enabled: true, radius: 10, thickness: 2 } }),
    preset('Circle', 'Shotgun Ring', { color: '#ff3b3b', lines: NO_LINES, dot: { enabled: true, size: 2 }, circle: { enabled: true, radius: 30 } }),
    preset('Circle', 'Scoped Cross', { color: '#00e5ff', lines: { gap: 6, length: 10, thickness: 1 }, circle: { enabled: true, radius: 12 } }),

    preset('T-Shape', 'T-Shape', { color: '#00e5ff', lines: { top: false, length: 7, gap: 4 } }),
    preset('T-Shape', 'T Dot', { color: '#ffe600', lines: { top: false, length: 6, gap: 3 }, dot: { enabled: true, size: 2 } }),
    preset('T-Shape', 'Chevron', { color: '#ff2bd6', rotation: 45, lines: { top: false, left: false, length: 8, gap: 0 } }),
    preset('T-Shape', 'Bottom Only', { color: '#00ff66', lines: { top: false, left: false, right: false, length: 10, gap: 2 } }),

    preset('Sniper', 'Sniper Thin', { color: '#ff3b3b', lines: { thickness: 1, length: 14, gap: 0 }, outline: NO_OUTLINE }),
    preset('Sniper', 'Long Lines', { color: '#00ff66', lines: { thickness: 1, length: 40, gap: 6 } }),
    preset('Sniper', 'Mil-Dot', { color: '#000000', lines: { thickness: 1, length: 30, gap: 2 }, outline: { color: '#ffffff' }, dot: { enabled: true, size: 2, shape: 'circle' } }),
    preset('Sniper', 'Fine Point', { color: '#ffffff', lines: { thickness: 1, length: 4, gap: 2 }, dot: { enabled: true, size: 1 } }),

    preset('Dynamic', 'Spread Cross', { color: '#00ff66', firing: FIRE(8) }),
    preset('Dynamic', 'Spread Ring', { color: '#00e5ff', lines: NO_LINES, dot: { enabled: true, size: 2 }, circle: { enabled: true, radius: 8 }, firing: FIRE(10, 0, 160) }),
    preset('Dynamic', 'Recoil Kick', { color: '#ffe600', lines: { gap: 3, length: 5 }, dot: { enabled: true, size: 2 }, firing: FIRE(3, 6, 90) }),
    preset('Dynamic', 'Static Dot + Spread', { name: 'Dot', color: '#ffffff', lines: NO_LINES, dot: { enabled: true, size: 2 } }, { name: 'Lines', color: '#ff3b3b', lines: { gap: 5, length: 5 }, firing: FIRE(12, 0, 150) }),

    preset('Layered', 'Bullet Drop',
      { name: 'Main', color: '#00ff66', lines: { gap: 3, length: 6 } },
      { name: 'Drop 1', color: '#00ff66', offsetY: 14, lines: { top: false, bottom: false, length: 4, gap: 1, thickness: 1 } },
      { name: 'Drop 2', color: '#00ff66', offsetY: 26, lines: { top: false, bottom: false, length: 3, gap: 1, thickness: 1 } },
      { name: 'Drop 3', color: '#00ff66', offsetY: 38, lines: { top: false, bottom: false, length: 2, gap: 1, thickness: 1 } }),
    preset('Layered', 'Dot in Ring X',
      { name: 'X', color: '#ff2bd6', rotation: 45, lines: { length: 6, gap: 9 } },
      { name: 'Ring', color: '#ffffff', lines: NO_LINES, circle: { enabled: true, radius: 6 } },
      { name: 'Dot', color: '#ffffff', lines: NO_LINES, dot: { enabled: true, size: 2 } }),
    preset('Layered', 'Double Cross',
      { name: 'Outer', color: '#00e5ff', lines: { gap: 10, length: 6, thickness: 1 } },
      { name: 'Inner', color: '#ffffff', lines: { gap: 2, length: 3, thickness: 1 } }),

    preset('Stylized', 'Big X', { color: '#ffe600', rotation: 45, lines: { length: 10, thickness: 2, gap: 5 } }),
    preset('Stylized', 'Diamond X', { color: '#00e5ff', rotation: 45, lines: { length: 4, thickness: 2, gap: 3 }, dot: { enabled: true, size: 2 } }),
    preset('Stylized', 'Tactical', { color: '#c6ff3d', lines: { length: 12, thickness: 1, gap: 10 }, dot: { enabled: true, size: 3, shape: 'circle' }, outline: NO_OUTLINE }),
    preset('Stylized', 'Blocky', { color: '#ff8a00', lines: { length: 4, thickness: 4, gap: 4 }, outline: { thickness: 2 } }),
  ];

  return {
    LAYER_SCHEMA,
    DEFAULT_LAYER,
    DEFAULT_CROSSHAIR,
    MAX_LAYERS,
    MAX_IMAGE_CHARS,
    PRESETS,
    SHARE_PREFIX,
    sanitizeLayer,
    sanitizeCrosshair,
    crosshairExtent,
    overlaySizePx,
    drawCrosshair,
    layerBounds,
    onImageLoaded,
    FireAnimator,
    hasFiring,
    hasImageLayers,
    encodeShareCode,
    decodeShareCode,
  };
});
