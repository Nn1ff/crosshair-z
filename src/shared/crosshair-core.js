/**
 * Crosshair Z core: schema, validation, layered rendering, firing animation, share codes.
 * UMD module — used by main process (require) and renderers (<script>).
 *
 * Layer model (v3) follows the Crosshair Y "model layer": lines, center dot and outline are
 * separate parts with their own color / opacity / blur. Lines use Y's total-gap "offset" with
 * pixel-crisp parity rules, rotation turns the lines only (never the dot), and firing animates
 * from the base design toward a target (offset/length/thickness/opacity/size/position deltas).
 * Older Z crosshairs (v1 flat, v2 layers with per-side "gap") are upgraded on load.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrosshairCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 3;
  const SHARE_PREFIX = 'CZ3-';
  const LEGACY_SHARE_PREFIXES = ['CZ2-', 'CZ1-'];
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  const MAX_IMAGE_CHARS = 1500000;
  const MAX_LAYERS = 64;
  const OVERLAY_PADDING_PX = 4;
  const MIN_OVERLAY_PX = 32;
  const MAX_IMAGE_CACHE = 32;
  const BLUR_REACH = 3; // gaussian blur visibly spreads ~3σ
  const OUTLINE_MITER_LIMIT = 4; // SVG default, matches Crosshair Y triangle outlines
  const ARMS = ['top', 'bottom', 'left', 'right'];
  const LINE_SHAPES = ['rectangle', 'triangle', 'chevronIn', 'chevronOut', 'arc', 'tShape'];
  const CRISP_LINE_SHAPES = ['rectangle', 'triangle']; // pixel-exact path for the classic 4 arms
  const DOT_SHAPES = ['square', 'circle', 'ring', 'diamond'];
  const FORM_TYPES = ['square', 'circle', 'triangle'];
  const TEXT_LAYOUTS = ['line', 'circle'];
  const LAYER_KINDS = ['shape', 'form', 'text', 'draw', 'image'];
  const ARM_ANGLE = { top: 0, right: 90, bottom: 180, left: 270 };
  const DRAW_SIZE = 64; // drawing layers are a DRAW_SIZE² pixel canvas centered on the layer anchor
  const FONT_FAMILY = '"Open Sans", "Segoe UI", sans-serif';
  const TEXT_WIDTH_PER_EM = 0.7; // width estimate (no canvas in the main process), as Crosshair Y

  /** Leaf specs: n = number, b = boolean, c = hex color, e = enum, s = string, img = image data URL. */
  const OPACITY = { t: 'n', min: 0, max: 1 };
  const BLUR = { t: 'n', min: 0, max: 10 };
  const LAYER_SCHEMA = {
    name: { t: 's', max: 24 },
    visible: { t: 'b' },
    kind: { t: 'e', values: LAYER_KINDS }, // shape = crosshair (lines/dot), form = geometric shape
    offsetX: { t: 'n', min: -300, max: 300, int: true },
    offsetY: { t: 'n', min: -300, max: 300, int: true },
    rotation: { t: 'n', min: -180, max: 180, int: true }, // lines/form/text/image; the dot never rotates
    scale: { t: 'n', min: 0.25, max: 8 },
    lines: {
      enabled: { t: 'b' },
      shape: { t: 'e', values: LINE_SHAPES },
      color: { t: 'c' },
      opacity: OPACITY,
      length: { t: 'n', min: 0, max: 100, int: true },
      thickness: { t: 'n', min: 1, max: 40, int: true },
      offset: { t: 'n', min: -40, max: 200, int: true }, // total empty pixels between opposite arms
      blur: BLUR,
      top: { t: 'b' },
      bottom: { t: 'b' },
      left: { t: 'b' },
      right: { t: 'b' },
      count: { t: 'n', min: 3, max: 8, int: true }, // arms around the center; 4 = top/bottom/left/right
      angle: { t: 'n', min: 10, max: 170, int: true }, // chevron opening
      roundness: { t: 'n', min: 0, max: 1 }, // chevron tip
      capLength: { t: 'n', min: 0, max: 100, int: true }, // T-shape cap
      capThickness: { t: 'n', min: 0, max: 40, int: true },
    },
    dot: {
      enabled: { t: 'b' },
      shape: { t: 'e', values: DOT_SHAPES },
      size: { t: 'n', min: 1, max: 100, int: true }, // diameter / side length
      thickness: { t: 'n', min: 1, max: 20, int: true }, // ring stroke
      color: { t: 'c' },
      useMainColor: { t: 'b' },
      opacity: OPACITY,
      blur: BLUR,
    },
    outline: {
      enabled: { t: 'b' },
      thickness: { t: 'n', min: 1, max: 6, int: true },
      color: { t: 'c' },
      opacity: OPACITY,
      blur: BLUR,
    },
    image: {
      src: { t: 'img' },
      size: { t: 'n', min: 4, max: 512, int: true },
      opacity: OPACITY,
      blur: BLUR,
    },
    form: {
      type: { t: 'e', values: FORM_TYPES },
      width: { t: 'n', min: 1, max: 400, int: true },
      height: { t: 'n', min: 1, max: 400, int: true },
      corner: { t: 'n', min: 0, max: 200, int: true }, // square corner radius
      color: { t: 'c' },
      opacity: OPACITY,
      blur: BLUR,
    },
    text: {
      value: { t: 's', max: 40, empty: true },
      size: { t: 'n', min: 4, max: 120, int: true },
      bold: { t: 'b' },
      spacing: { t: 'n', min: -10, max: 40, int: true },
      layout: { t: 'e', values: TEXT_LAYOUTS },
      radius: { t: 'n', min: 4, max: 300, int: true },
      color: { t: 'c' },
      opacity: OPACITY,
      blur: BLUR,
    },
    draw: {
      src: { t: 'img' }, // DRAW_SIZE² PNG, painted in the designer
      color: { t: 'c' }, // pen color
      opacity: OPACITY,
      blur: BLUR,
    },
    /** Z firing (unchanged): arms/ring spread per side, kick up, ramp time in ms. */
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
    rotation: 0,
    scale: 1,
    lines: {
      enabled: true, shape: 'rectangle', color: '#00ff66', opacity: 1, length: 6, thickness: 2, offset: 6, blur: 0,
      top: true, bottom: true, left: true, right: true, count: 4, angle: 60, roundness: 0, capLength: 8, capThickness: 2,
    },
    dot: { enabled: false, shape: 'square', size: 2, thickness: 1, color: '#ffffff', useMainColor: true, opacity: 1, blur: 0 },
    outline: { enabled: true, thickness: 1, color: '#000000', opacity: 1, blur: 0 },
    image: { src: '', size: 64, opacity: 1, blur: 0 },
    form: { type: 'square', width: 12, height: 12, corner: 0, color: '#00ff66', opacity: 1, blur: 0 },
    text: { value: 'Z', size: 16, bold: true, spacing: 0, layout: 'line', radius: 30, color: '#ffffff', opacity: 1, blur: 0 },
    draw: { src: '', color: '#00ff66', opacity: 1, blur: 0 },
    firing: { enabled: false, spread: 6, kick: 0, speed: 120 },
  });

  const DEFAULT_CROSSHAIR = deepFreeze({ version: SCHEMA_VERSION, layers: [DEFAULT_LAYER] });

  function deepFreeze(o) {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
    return Object.freeze(o);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** Mathematical modulo (JS % keeps the sign: -1 % 2 === -1). */
  function mod(a, n) {
    return ((a % n) + n) % n;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
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
      case 's': {
        if (typeof value !== 'string') return fallback;
        const s = value.replace(/[\r\n\t]/g, ' ').trim().slice(0, spec.max);
        return s || (spec.empty ? '' : fallback);
      }
      case 'img':
        return typeof value === 'string' && value.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(value) ? value : fallback;
      case 'n': {
        const num = typeof value === 'number' ? value : Number(value);
        if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(num)) return fallback;
        const clamped = clamp(num, spec.min, spec.max);
        return spec.int ? Math.round(clamped) : Math.round(clamped * 1000) / 1000;
      }
      default:
        return fallback;
    }
  }

  function sanitizeNode(schema, defaults, input) {
    const src = isObj(input) ? input : {};
    const out = {};
    for (const key of Object.keys(schema)) {
      out[key] = isLeaf(schema[key])
        ? sanitizeLeaf(schema[key], src[key], defaults[key])
        : sanitizeNode(schema[key], defaults[key], src[key]);
    }
    return out;
  }

  /**
   * Validate one v3 layer; unknown keys dropped, bad values replaced by defaults.
   * @param {unknown} input
   * @returns {object}
   */
  function sanitizeLayer(input) {
    return sanitizeNode(LAYER_SCHEMA, DEFAULT_LAYER, input);
  }

  // ---------- legacy (v1 / v2) upgrade ----------

  /** Z v2 layer schema, kept only to read old saves and CZ1/CZ2 share codes. */
  const LEGACY_SCHEMA = {
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
      thickness: { t: 'n', min: 1, max: 40, int: true },
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
      size: { t: 'n', min: 1, max: 100, int: true },
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

  const LEGACY_DEFAULT_LAYER = deepFreeze({
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

  /** Keys that exist only in the old format / only in v3 — used to tell the two apart. */
  const LEGACY_MARKERS = { '': ['color', 'opacity', 'blur', 'circle'], lines: ['gap'] };
  const V3_MARKERS = {
    lines: ['offset', 'color', 'opacity', 'shape', 'blur'],
    dot: ['opacity', 'blur', 'thickness'],
    outline: ['blur'],
    image: ['opacity', 'blur'],
    form: ['type'],
    text: ['value'],
    draw: ['src'],
  };

  function hasMarker(layer, markers) {
    if (!isObj(layer)) return false;
    return Object.keys(markers).some((group) => {
      const node = group ? layer[group] : layer;
      return isObj(node) && markers[group].some((k) => k in node);
    });
  }

  /**
   * Old per-side gap → v3 total offset. Odd thickness centers on a pixel (empty = 2·gap + 1),
   * even thickness on a pixel corner (empty = 2·gap). Gap -1 with odd thickness (arms meeting in
   * the center pixel) is Crosshair Y's offset 0.
   */
  function gapToOffset(gap, thickness) {
    if (thickness % 2 === 0) return 2 * gap;
    return gap === -1 ? 0 : 2 * gap + 1;
  }

  /**
   * Convert one sanitized v2 layer to 1–2 v3 layers (pixel-identical, except that the dot no longer
   * turns with the lines: a 45°-turned square dot becomes a diamond, other angles stay square).
   * A layer that had both a center dot and a circle becomes ring layer + dot layer.
   */
  function upgradeLegacyLayer(old) {
    const op = old.opacity;
    const thickness = old.lines.thickness;
    const dotRotated = old.dot.shape === 'square' && mod(old.rotation, 90) === 45;
    const base = {
      name: old.name,
      visible: old.visible,
      kind: old.kind,
      offsetX: old.offsetX,
      offsetY: old.offsetY,
      rotation: old.rotation,
      scale: old.scale,
      lines: {
        enabled: old.lines.enabled,
        shape: 'rectangle',
        color: old.color,
        opacity: op,
        length: old.lines.length,
        thickness,
        offset: gapToOffset(old.lines.gap, thickness),
        blur: old.blur,
        top: old.lines.top,
        bottom: old.lines.bottom,
        left: old.lines.left,
        right: old.lines.right,
      },
      dot: {
        enabled: old.dot.enabled,
        shape: dotRotated ? 'diamond' : old.dot.shape,
        size: old.dot.size,
        thickness: 1,
        color: old.dot.color,
        useMainColor: old.dot.useMainColor,
        opacity: op,
        blur: old.blur,
      },
      outline: { ...old.outline, opacity: op * old.outline.opacity, blur: old.blur },
      image: { src: old.image.src, size: old.image.size, opacity: op, blur: old.blur },
      firing: { ...old.firing },
    };
    if (old.kind !== 'shape' || !old.circle.enabled) return [base];
    const ring = {
      ...base.dot,
      enabled: true,
      shape: 'ring',
      size: 2 * old.circle.radius,
      thickness: old.circle.thickness,
      color: old.color,
      useMainColor: true,
    };
    if (!old.dot.enabled) return [{ ...base, dot: ring }];
    // Two dots cannot share one layer: the ring goes underneath, keeping the old paint order.
    const ringLayer = { ...base, name: `${old.name} ring`.slice(0, 24), lines: { ...base.lines, enabled: false }, dot: ring };
    const dotLayer = { ...base, name: `${old.name} dot`.slice(0, 24), lines: { ...base.lines, enabled: false } };
    return old.lines.enabled ? [ringLayer, { ...base, name: old.name }] : [ringLayer, dotLayer];
  }

  /** Raw v1/v2 crosshair (full or share-code diff) → v3 layers. */
  function upgradeLegacy(input) {
    const src = isObj(input) ? input : {};
    const raw = Array.isArray(src.layers) ? src.layers : 'layers' in src ? [] : [src];
    return raw
      .slice(0, MAX_LAYERS)
      .filter(isObj)
      .flatMap((l) => upgradeLegacyLayer(sanitizeNode(LEGACY_SCHEMA, LEGACY_DEFAULT_LAYER, l)));
  }

  function isLegacyCrosshair(src) {
    if (src.version === SCHEMA_VERSION) return false;
    if (!Array.isArray(src.layers)) return true; // v1: flat single design
    if (src.layers.some((l) => hasMarker(l, LEGACY_MARKERS))) return true;
    // Marker-free layers mean the same in both formats (v3 defaults = upgraded v2 defaults).
    return !src.layers.some((l) => hasMarker(l, V3_MARKERS));
  }

  /**
   * Validate crosshair. Accepts v3, v2 ({layers} with per-side gap) and legacy v1 (flat single design).
   * @param {unknown} input
   * @returns {{version: number, layers: object[]}}
   */
  function sanitizeCrosshair(input) {
    const src = isObj(input) ? input : {};
    const rawLayers = isLegacyCrosshair(src) ? upgradeLegacy(src) : src.layers.filter(isObj);
    const layers = rawLayers.slice(0, MAX_LAYERS).map(sanitizeLayer);
    if (layers.length === 0) layers.push(clone(DEFAULT_LAYER));
    return { version: SCHEMA_VERSION, layers };
  }

  // ---------- firing ----------

  /**
   * Layer as drawn at firing level `lv` (0 = rest, 1 = full). Spread widens the gap on every side
   * (total offset + 2·spread) and grows a ring's radius by spread; kick moves the layer up.
   * Returns the layer itself at rest.
   */
  function firedLayer(layer, lv) {
    if (!lv || !layer.firing.enabled) return layer;
    const f = layer.firing;
    return {
      ...layer,
      offsetY: layer.offsetY - f.kick * lv,
      lines: { ...layer.lines, spread: f.spread * lv },
      dot: layer.dot.shape === 'ring' ? { ...layer.dot, spread: f.spread * lv } : layer.dot,
    };
  }

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

  // ---------- geometry ----------

  function px(v, s) {
    return Math.max(1, Math.round(v * s));
  }

  function visibleArms(L) {
    return ARMS.filter((a) => L[a]);
  }

  /**
   * Crosshair Y crisp-line rule: with two or more arms the offset takes the thickness parity
   * (nearest value, preferring the smaller one), so opposite arms stay symmetric.
   */
  function alignOffset(offset, thickness, armCount) {
    if (armCount < 2 || mod(offset, 2) === mod(thickness, 2)) return offset;
    if (offset === 0 && thickness % 2 === 1) return offset;
    return offset - 1 >= 0 ? offset - 1 : offset + 1;
  }

  /**
   * Pixel geometry of the lines in a layer-local frame whose origin is the anchor pixel corner.
   * @returns {null | {t:number, center:number, near:number, far:number, len:number, arms:string[]}}
   *   near = first pixel of bottom/right arms, far = end (exclusive) of top/left arms.
   */
  function lineGeometry(L, s) {
    if (L.count !== 4 || !CRISP_LINE_SHAPES.includes(L.shape)) return radialGeometry(L, s);
    const arms = visibleArms(L);
    const len = Math.round(L.length * s);
    if (!L.enabled || !arms.length || len <= 0 || L.thickness <= 0 || L.opacity <= 0) return null;
    const baseT = Math.max(1, Math.round(L.thickness));
    const t = px(L.thickness, s);
    let o = alignOffset(L.offset, baseT, arms.length);
    if (o === 0 && baseT % 2 === 1) o = -1; // odd lines with offset 0 meet in the center pixel
    const odd = mod(o, 2);
    const aligned = odd === baseT % 2;
    // per-side gap, scaled; firing spread snaps to whole pixels so both sides move together
    const g = Math.round(((o - odd) / 2) * s + Math.round((L.spread || 0) * s));
    const oddOut = aligned ? t % 2 : odd;
    return { t, center: (t % 2) / 2, near: g + oddOut, far: -g, len, arms };
  }

  /**
   * Geometry for chevron / arc / T-shape arms and for 3–8 arms around the center (Crosshair Y's
   * smooth path rendering). Each arm is drawn pointing up, then turned to its angle.
   * With 4 arms the top/bottom/left/right switches apply; other counts show every arm.
   */
  function radialGeometry(L, s) {
    const angles = L.count === 4
      ? visibleArms(L).map((a) => ARM_ANGLE[a])
      : Array.from({ length: L.count }, (_, i) => (360 / L.count) * i);
    const len = L.length * s;
    if (!L.enabled || !angles.length || len <= 0 || L.thickness <= 0 || L.opacity <= 0) return null;
    const t = Math.max(1, L.thickness * s);
    return {
      radial: true,
      shape: L.shape,
      angles,
      t,
      len,
      half: (L.offset / 2 + (L.spread || 0)) * s, // distance from center to the arm's inner end
      slot: 360 / L.count,
      angle: L.angle,
      roundness: L.roundness,
      capLength: L.capLength * s,
      capThickness: L.capThickness * s,
      center: (px(L.thickness, s) % 2) / 2,
    };
  }

  /** Farthest point of the lines from the line center (generous; used for the overlay size). */
  function linesReach(geo) {
    if (!geo.radial) return Math.hypot(Math.max(Math.abs(geo.near), Math.abs(geo.far)) + geo.len + 1, geo.t / 2 + 1);
    const along = Math.abs(geo.half) + geo.len + geo.t + (geo.shape === 'tShape' ? geo.capThickness : 0);
    const across = Math.max(geo.t, geo.shape === 'tShape' ? geo.capLength / 2 : 0, geo.shape.startsWith('chevron') ? geo.len : 0);
    return Math.hypot(along, across) + 1;
  }

  /** Width estimate of a text layer's line in px (main process has no canvas to measure). */
  function textWidth(T, s) {
    return (T.value.length * T.size * TEXT_WIDTH_PER_EM + Math.max(0, T.value.length - 1) * T.spacing) * s;
  }

  /** Reach of a form / text / drawing / image layer from its anchor, without outline and blur. */
  function bodyReach(l, s) {
    switch (l.kind) {
      case 'image': return (l.image.size * s * Math.SQRT2) / 2;
      case 'draw': return (DRAW_SIZE * s * Math.SQRT2) / 2;
      case 'form': return (Math.hypot(l.form.width, l.form.height) * s) / 2 + 1;
      case 'text':
        if (!l.text.value) return 0;
        if (l.text.layout === 'circle') return (l.text.radius + l.text.size * 1.2) * s;
        return Math.hypot(textWidth(l.text, s) / 2, l.text.size * s) + 1;
      default: return 0;
    }
  }

  /** Line center offset from the anchor corner: pixel center for odd thickness, even if lines are off. */
  function lineCenter(L, s) {
    return (px(L.thickness, s) % 2) / 2;
  }

  /** Arm rects [x, y, w, h, arm] in the anchor frame. */
  function armRects(geo) {
    const x0 = -Math.floor(geo.t / 2);
    const out = [];
    for (const a of geo.arms) {
      if (a === 'top') out.push([x0, geo.far - geo.len, geo.t, geo.len, a]);
      if (a === 'bottom') out.push([x0, geo.near, geo.t, geo.len, a]);
      if (a === 'left') out.push([geo.far - geo.len, x0, geo.len, geo.t, a]);
      if (a === 'right') out.push([geo.near, x0, geo.len, geo.t, a]);
    }
    return out;
  }

  /** Triangle arm: apex at the inner end on the line center, base across the outer end. */
  function armTriangle(rect, center) {
    const [x, y, w, h, a] = rect;
    if (a === 'top') return [[center, y + h], [x, y], [x + w, y]];
    if (a === 'bottom') return [[center, y], [x, y + h], [x + w, y + h]];
    if (a === 'left') return [[x + w, center], [x, y], [x, y + h]];
    return [[x, center], [x + w, y], [x + w, y + h]];
  }

  /**
   * Dot geometry in the anchor frame. Square/circle/diamond center on the pixel grid by their own
   * size (odd = pixel center); a ring centers like the lines, as old Z circles did.
   */
  function dotGeometry(D, s, lineCenter) {
    if (!D.enabled || D.opacity <= 0 || D.size < 0.5) return null;
    const size = px(D.size, s) + 2 * Math.round((D.spread || 0) * s);
    const start = Math.round(-size / 2);
    const c = D.shape === 'ring' ? lineCenter : start + size / 2;
    return { shape: D.shape, size, start, c, ring: px(D.thickness, s) };
  }

  /** Max distance (physical px) from the layer anchor any pixel reaches at firing level lv. */
  function firedExtent(layer, g, lv) {
    const l = firedLayer(layer, lv);
    const s = l.scale * g;
    const blurOf = (b) => b * BLUR_REACH;
    let r = 0;
    const o = l.outline.enabled ? l.outline.thickness : 0;
    const oBlur = l.outline.enabled ? blurOf(l.outline.blur) : 0;
    if (l.kind === 'image') {
      r = bodyReach(l, s) + blurOf(l.image.blur);
    } else if (l.kind === 'draw') {
      r = bodyReach(l, s) + blurOf(l.draw.blur);
    } else if (l.kind === 'form' || l.kind === 'text') {
      r = bodyReach(l, s) + o + Math.max(blurOf(l[l.kind].blur), oBlur);
    } else {
      const geo = lineGeometry(l.lines, s);
      if (geo) r = Math.max(r, linesReach(geo) + o + Math.max(blurOf(l.lines.blur), oBlur));
      const dot = dotGeometry(l.dot, s, lineCenter(l.lines, s));
      if (dot) {
        const reach = dot.shape === 'ring' ? dot.size / 2 + dot.ring / 2 : (dot.size * Math.SQRT2) / 2;
        r = Math.max(r, reach + 1 + o + Math.max(blurOf(l.dot.blur), oBlur));
      }
    }
    return r + Math.hypot(l.offsetX, l.offsetY) * g;
  }

  /** Max distance (physical px) from crosshair center any pixel reaches, incl. full firing. */
  function layerExtent(layer, g) {
    const rest = firedExtent(layer, g, 0);
    return Math.ceil(layer.firing.enabled ? Math.max(rest, firedExtent(layer, g, 1)) : rest);
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

  // ---------- drawing ----------

  const imageCache = new Map();
  let imageListener = null;

  /** Register callback fired when an image layer finishes decoding (to trigger re-render). */
  function onImageLoaded(cb) {
    imageListener = cb;
  }

  /**
   * Put an already-rendered bitmap (e.g. a drawing canvas) in the cache under its data URL, so the
   * first frame after an edit does not wait for the URL to decode. The source is copied.
   */
  function primeImage(src, source) {
    if (!src || typeof OffscreenCanvas === 'undefined') return;
    const copy = new OffscreenCanvas(source.width, source.height);
    copy.getContext('2d').drawImage(source, 0, 0);
    imageCache.set(src, copy);
    if (imageCache.size > MAX_IMAGE_CACHE) imageCache.delete(imageCache.keys().next().value);
  }

  function getImage(src) {
    if (!src || typeof Image === 'undefined') return null;
    let img = imageCache.get(src);
    if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) return img;
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
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  const SLOT = { lines: 0, dot: 1, outline: 2, merged: 3 };

  /** Translate to the anchor pixel corner; lines additionally rotate around their center. */
  function withFrame(ctx, ax, ay, pivot, rotation, fn) {
    ctx.save();
    ctx.translate(ax + pivot, ay + pivot);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-pivot, -pivot);
    fn(ctx);
    ctx.restore();
  }

  function polygon(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  /** Fill the current path; with grow > 0 also stroke it 2·grow wide so the outline sits grow px outside. */
  function fillGrown(ctx, grow) {
    ctx.fill();
    if (!grow) return;
    ctx.lineWidth = grow * 2;
    ctx.lineJoin = 'miter';
    ctx.miterLimit = OUTLINE_MITER_LIMIT;
    ctx.stroke();
  }

  /** Chevron polyline with Crosshair Y's rounded tip (0 = sharp, 1 = full curve). */
  function chevronPath(ctx, p0, p1, p2, roundness) {
    const r = clamp(roundness, 0, 1);
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0] + r * (p0[0] - p1[0]), p1[1] + r * (p0[1] - p1[1]));
    ctx.quadraticCurveTo(p1[0], p1[1], p1[0] + r * (p2[0] - p1[0]), p1[1] + r * (p2[1] - p1[1]));
    ctx.lineTo(p2[0], p2[1]);
  }

  /** Annular sector of an arc arm pointing up (Crosshair Y "flat" caps). */
  function arcPath(ctx, geo, grow) {
    const toRad = Math.PI / 180;
    const g = Math.max(0.5, geo.half);
    const outer = g + Math.max(0.5, geo.t);
    let sweep = Math.min(geo.slot, (geo.len / g) / toRad);
    const full = sweep >= geo.slot - 0.01;
    let outerSweep = full ? sweep : geo.slot - (g / outer) * (geo.slot - sweep);
    if (full) { // tiny overlap so neighbouring full arcs leave no seam
      const seam = (0.5 / outer) / toRad;
      sweep += seam * 2;
      outerSweep += seam * 2;
    }
    sweep = Math.min(sweep, 179.9);
    outerSweep = Math.min(outerSweep, 179.9);
    const c = -90;
    // full arcs join into a ring: their outline only grows inward/outward, never across the seams
    const radial = full ? grow : 0;
    ctx.beginPath();
    ctx.arc(0, 0, outer + radial, (c - outerSweep / 2) * toRad, (c + outerSweep / 2) * toRad);
    ctx.arc(0, 0, Math.max(0, g - radial), (c + sweep / 2) * toRad, (c - sweep / 2) * toRad, true);
    ctx.closePath();
    fillGrown(ctx, full ? 0 : grow);
  }

  /** One arm pointing up from the line center (radial / special shapes). */
  function paintTopArm(ctx, geo, grow) {
    const { t, len, half } = geo;
    switch (geo.shape) {
      case 'triangle':
        polygon(ctx, [[0, -half], [-t / 2, -half - len], [t / 2, -half - len]]);
        if (grow) {
          ctx.lineWidth = grow;
          ctx.miterLimit = OUTLINE_MITER_LIMIT;
          ctx.stroke();
        } else {
          ctx.fill();
        }
        return;
      case 'chevronIn':
      case 'chevronOut': {
        const open = (Math.min(geo.shape === 'chevronOut' ? 170 : 180, geo.angle) / 2) * (Math.PI / 180);
        const w = len * Math.sin(open);
        const depth = len * Math.cos(open);
        const sw = Math.max(1, Math.round(t));
        const gap = Math.round(half);
        const start = geo.shape === 'chevronIn' && gap === 0 ? 0 : gap + Math.round(sw / 2);
        if (geo.shape === 'chevronIn') chevronPath(ctx, [-w, -start - depth], [0, -start], [w, -start - depth], geo.roundness);
        else chevronPath(ctx, [-w, -start], [0, -start - depth], [w, -start], geo.roundness);
        ctx.lineWidth = sw + grow * 2;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'round';
        ctx.stroke();
        return;
      }
      case 'arc':
        arcPath(ctx, geo, grow);
        return;
      case 'tShape': {
        const sl = -t / 2, sr = t / 2, st = -half - len, sb = -half;
        const cl = -geo.capLength / 2, cr = geo.capLength / 2, ct = st - geo.capThickness;
        const pts = geo.capLength > 0 && geo.capThickness > 0
          ? [[sl, sb], [sl, st], [cl, st], [cl, ct], [cr, ct], [cr, st], [sr, st], [sr, sb]]
          : [[sl, sb], [sl, st], [sr, st], [sr, sb]];
        polygon(ctx, pts);
        fillGrown(ctx, grow);
        return;
      }
      default:
        ctx.fillRect(-t / 2 - grow, -half - len - grow, t + grow * 2, len + grow * 2);
    }
  }

  /** Lines pass. grow > 0 draws the outline silhouette (rect: grown box, triangle: stroked edge like Y). */
  function paintLines(ctx, L, geo, grow) {
    if (geo.radial) {
      for (const a of geo.angles) {
        ctx.save();
        ctx.translate(geo.center, geo.center);
        if (a) ctx.rotate((a * Math.PI) / 180);
        paintTopArm(ctx, geo, grow);
        ctx.restore();
      }
      return;
    }
    for (const rect of armRects(geo)) {
      if (L.shape === 'triangle') {
        polygon(ctx, armTriangle(rect, geo.center));
        if (grow) {
          ctx.lineWidth = grow;
          ctx.miterLimit = OUTLINE_MITER_LIMIT;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      } else {
        const [x, y, w, h] = rect;
        ctx.fillRect(x - grow, y - grow, w + grow * 2, h + grow * 2);
      }
    }
  }

  function diamond(ctx, c, side) {
    const e = side / Math.SQRT2;
    polygon(ctx, [[c, c - e], [c + e, c], [c, c + e], [c - e, c]]);
  }

  /** Dot pass. grow > 0 draws the outline silhouette; a ring keeps Z's outline on both edges. */
  function paintDot(ctx, dot, grow) {
    const { shape, size, start, c } = dot;
    if (shape === 'square') {
      ctx.fillRect(start - grow, start - grow, size + grow * 2, size + grow * 2);
    } else if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(c, c, size / 2 + grow, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape === 'diamond') {
      diamond(ctx, c, size + grow * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(c, c, size / 2, 0, Math.PI * 2);
      ctx.lineWidth = dot.ring + grow * 2;
      ctx.stroke();
    }
  }

  function composite(ctx, source, alpha, blur) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }

  /**
   * Render one shape layer. Parts are painted opaque into scratch canvases, then composited with
   * their own opacity / blur: outline (fill area cut out, so it never shows under the fill), dot,
   * lines on top — Crosshair Y's paint order. Lines and dot with equal opacity and blur composite
   * together so overlaps stay uniformly transparent.
   */
  function drawShapeLayer(ctx, l, x, y, s) {
    const geo = lineGeometry(l.lines, s);
    const dot = dotGeometry(l.dot, s, lineCenter(l.lines, s));
    if (!geo && !dot) return;
    const { width: w, height: h } = ctx.canvas;
    const ax = Math.floor(x);
    const ay = Math.floor(y);
    const pivot = geo ? geo.center : 0;
    const lineColor = l.lines.color;
    const dotColor = l.dot.useMainColor ? lineColor : l.dot.color;
    const paint = (slot, color, part) => {
      const c = scratchCtx(slot, w, h);
      c.fillStyle = color;
      c.strokeStyle = color;
      if (part === 'lines') withFrame(c, ax, ay, pivot, l.rotation, (f) => paintLines(f, l.lines, geo, 0));
      else withFrame(c, ax, ay, 0, 0, (f) => paintDot(f, dot, 0));
      return c.canvas;
    };
    const linesCanvas = geo ? paint(SLOT.lines, lineColor, 'lines') : null;
    const dotCanvas = dot ? paint(SLOT.dot, dotColor, 'dot') : null;

    if (l.outline.enabled && l.outline.opacity > 0) {
      const oc = scratchCtx(SLOT.outline, w, h);
      const o = l.outline.thickness;
      oc.fillStyle = l.outline.color;
      oc.strokeStyle = l.outline.color;
      if (geo) withFrame(oc, ax, ay, pivot, l.rotation, (f) => paintLines(f, l.lines, geo, o));
      if (dot) withFrame(oc, ax, ay, 0, 0, (f) => paintDot(f, dot, o));
      oc.globalCompositeOperation = 'destination-out';
      if (linesCanvas) oc.drawImage(linesCanvas, 0, 0);
      if (dotCanvas) oc.drawImage(dotCanvas, 0, 0);
      composite(ctx, oc.canvas, l.outline.opacity, l.outline.blur);
    }

    const L = l.lines;
    const D = l.dot;
    if (linesCanvas && dotCanvas && L.opacity === D.opacity && L.blur === D.blur) {
      const mc = scratchCtx(SLOT.merged, w, h);
      mc.drawImage(dotCanvas, 0, 0);
      mc.drawImage(linesCanvas, 0, 0);
      composite(ctx, mc.canvas, L.opacity, L.blur);
      return;
    }
    if (dotCanvas) composite(ctx, dotCanvas, D.opacity, D.blur);
    if (linesCanvas) composite(ctx, linesCanvas, L.opacity, L.blur);
  }

  function drawImageLayer(ctx, layer, x, y, s) {
    const img = getImage(layer.image.src);
    if (!img) return;
    const size = layer.image.size * s;
    // primed images are OffscreenCanvas (width/height), decoded ones are Image (naturalWidth/Height)
    const ratio = (img.naturalWidth || img.width) / (img.naturalHeight || img.height);
    const w = ratio >= 1 ? size : size * ratio;
    const h = ratio >= 1 ? size / ratio : size;
    ctx.save();
    ctx.globalAlpha = layer.image.opacity;
    if (layer.image.blur) ctx.filter = `blur(${layer.image.blur}px)`;
    ctx.imageSmoothingEnabled = true;
    withFrame(ctx, Math.floor(x), Math.floor(y), 0, layer.rotation, (c) => c.drawImage(img, -w / 2, -h / 2, w, h));
    ctx.restore();
  }

  /** Grow a triangle outward by d along its corner bisectors (miter), as Crosshair Y outlines it. */
  function expandTriangle(pts, d) {
    const n = pts.length;
    const normals = pts.map(([x, y], i) => {
      const [nx, ny] = pts[(i + 1) % n];
      const len = Math.hypot(nx - x, ny - y) || 1;
      return [-(ny - y) / len, (nx - x) / len];
    });
    return pts.map(([x, y], i) => {
      const a = normals[(i - 1 + n) % n];
      const b = normals[i];
      const bx = a[0] + b[0];
      const by = a[1] + b[1];
      const bl = Math.hypot(bx, by);
      if (bl < 1e-6) return [x + a[0] * d, y + a[1] * d];
      const ux = bx / bl;
      const uy = by / bl;
      const cos = a[0] * ux + a[1] * uy;
      const k = cos > 1e-6 ? d / cos : d;
      return [x + ux * k, y + uy * k];
    });
  }

  /** Form (square / circle / triangle) centered on the anchor; crisp edges unless rotated. */
  function paintForm(ctx, F, s, rotated, grow) {
    const w = F.width * s;
    const h = F.height * s;
    const crisp = F.type !== 'square' || !rotated;
    const x0 = crisp ? Math.round(-w / 2) : -w / 2;
    const y0 = crisp ? Math.round(-h / 2) : -h / 2;
    ctx.beginPath();
    if (F.type === 'circle') {
      ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2 + grow, h / 2 + grow, 0, 0, Math.PI * 2);
    } else if (F.type === 'triangle') {
      const pts = [[x0 + w / 2, y0], [x0, y0 + h], [x0 + w, y0 + h]];
      polygon(ctx, grow ? expandTriangle(pts, grow) : pts);
    } else {
      const r = F.corner > 0 ? Math.min(F.corner * s, w / 2, h / 2) + grow : 0;
      ctx.roundRect(x0 - grow, y0 - grow, w + grow * 2, h + grow * 2, r);
    }
    ctx.fill();
  }

  const requestedFonts = new Set();

  /** Canvas text needs the web font loaded; load once and re-render through the asset listener. */
  function ensureFont(font) {
    if (typeof document === 'undefined' || !document.fonts || requestedFonts.has(font)) return;
    requestedFonts.add(font);
    if (document.fonts.check(font)) return;
    document.fonts.load(font).then(
      () => imageListener && imageListener(),
      (err) => console.warn('crosshair font failed to load', err),
    );
  }

  /** Text pass (fill, or outline stroke 2·grow wide). Circle layout runs clockwise from the left, like Y's text path. */
  function paintText(ctx, T, s, grow) {
    const font = `${T.bold ? 700 : 400} ${T.size * s}px ${FONT_FAMILY}`;
    ensureFont(font);
    ctx.font = font;
    ctx.lineJoin = 'round';
    ctx.lineWidth = grow * 2;
    const draw = (str, x, y) => (grow ? ctx.strokeText(str, x, y) : ctx.fillText(str, x, y));
    ctx.textAlign = 'center';
    if (T.layout !== 'circle') {
      ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${T.spacing * s}px`;
      draw(T.value, 0, 0);
      return;
    }
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const r = T.radius * s;
    let along = 0;
    for (const ch of T.value) {
      const w = ctx.measureText(ch).width;
      const theta = Math.PI + (along + w / 2) / r;
      ctx.save();
      ctx.translate(r * Math.cos(theta), r * Math.sin(theta));
      ctx.rotate(theta + Math.PI / 2);
      draw(ch, 0, 0);
      ctx.restore();
      along += w + T.spacing * s;
    }
  }

  /**
   * Form / text layer: fill painted opaque, outline (fill cut out) composited under it, each with
   * its own opacity and blur — same scheme as the crosshair parts.
   */
  function drawFilledLayer(ctx, l, x, y, part, paint) {
    const { width: w, height: h } = ctx.canvas;
    const ax = Math.floor(x);
    const ay = Math.floor(y);
    const fc = scratchCtx(SLOT.lines, w, h);
    fc.fillStyle = part.color;
    fc.strokeStyle = part.color;
    withFrame(fc, ax, ay, 0, l.rotation, (f) => paint(f, 0));
    if (l.outline.enabled && l.outline.opacity > 0) {
      const oc = scratchCtx(SLOT.outline, w, h);
      oc.fillStyle = l.outline.color;
      oc.strokeStyle = l.outline.color;
      withFrame(oc, ax, ay, 0, l.rotation, (f) => paint(f, l.outline.thickness));
      oc.globalCompositeOperation = 'destination-out';
      oc.drawImage(fc.canvas, 0, 0);
      composite(ctx, oc.canvas, l.outline.opacity, l.outline.blur);
    }
    composite(ctx, fc.canvas, part.opacity, part.blur);
  }

  /** Pixel drawing: DRAW_SIZE² image, nearest-neighbour scaled, centered on the anchor. */
  function drawDrawLayer(ctx, l, x, y, s) {
    const img = getImage(l.draw.src);
    if (!img || l.draw.opacity <= 0) return;
    const size = DRAW_SIZE * s;
    ctx.save();
    ctx.globalAlpha = l.draw.opacity;
    if (l.draw.blur) ctx.filter = `blur(${l.draw.blur}px)`;
    ctx.imageSmoothingEnabled = false;
    withFrame(ctx, Math.floor(x), Math.floor(y), 0, l.rotation, (c) => c.drawImage(img, -size / 2, -size / 2, size, size));
    ctx.restore();
  }

  function drawLayer(ctx, l, x, y, s) {
    switch (l.kind) {
      case 'image': return drawImageLayer(ctx, l, x, y, s);
      case 'draw': return drawDrawLayer(ctx, l, x, y, s);
      case 'form': return drawFilledLayer(ctx, l, x, y, l.form, (c, grow) => paintForm(c, l.form, s, !!l.rotation, grow));
      case 'text': return l.text.value && drawFilledLayer(ctx, l, x, y, l.text, (c, grow) => paintText(c, l.text, s, grow));
      default: return drawShapeLayer(ctx, l, x, y, s);
    }
  }

  /**
   * Render crosshair centered on (cx, cy) in physical pixel space.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{layers: object[]}} ch sanitized crosshair
   * @param {number} cx
   * @param {number} cy
   * @param {{scale?: number, fire?: number[]}} [opts] global scale; per-layer eased firing level 0..1
   */
  function drawCrosshair(ctx, ch, cx, cy, opts = {}) {
    const g = opts.scale || 1;
    ch.layers.forEach((layer, i) => {
      if (!layer.visible) return;
      const l = firedLayer(layer, (opts.fire && opts.fire[i]) || 0);
      const x = cx + l.offsetX * g;
      const y = cy + l.offsetY * g;
      drawLayer(ctx, l, x, y, l.scale * g);
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
    const compact = layers.map((l) => {
      const d = diff(l, DEFAULT_LAYER);
      delete d.image; // never shared
      return d;
    });
    return SHARE_PREFIX + bytesToBase64Url(new TextEncoder().encode(JSON.stringify(compact)));
  }

  /**
   * Decode share code (CZ3, or older CZ2 / CZ1). Throws Error with readable message when invalid.
   * @param {string} code
   * @returns {{version: number, layers: object[]}}
   */
  function decodeShareCode(code) {
    const trimmed = typeof code === 'string' ? code.trim() : '';
    const prefix = [SHARE_PREFIX, ...LEGACY_SHARE_PREFIXES].find((p) => trimmed.startsWith(p));
    if (!prefix) throw new Error('Code must start with ' + SHARE_PREFIX);
    const body = trimmed.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('Code contains invalid characters');
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
    } catch (err) {
      throw new Error('Code is corrupted');
    }
    let layers;
    if (prefix === SHARE_PREFIX) layers = Array.isArray(parsed) ? parsed.filter(isObj) : [];
    else layers = upgradeLegacy(prefix === 'CZ2-' ? { layers: Array.isArray(parsed) ? parsed : [] } : parsed);
    const ch = sanitizeCrosshair({ version: SCHEMA_VERSION, layers });
    ch.layers.forEach((l) => {
      if (l.kind === 'image') l.kind = 'shape'; // images are never shared
      l.image.src = '';
    });
    return ch;
  }

  // ---------- presets ----------

  function merge(base, patch) {
    for (const k of Object.keys(patch)) {
      base[k] = isObj(patch[k]) && isObj(base[k]) ? merge(base[k], patch[k]) : patch[k];
    }
    return base;
  }

  function preset(category, name, ...patches) {
    const layers = (patches.length ? patches : [{}]).map((p, i) => merge(clone(DEFAULT_LAYER), { name: `Layer ${i + 1}`, ...p }));
    return { category, name, crosshair: sanitizeCrosshair({ version: SCHEMA_VERSION, layers }) };
  }

  /** Line color + optional line settings. */
  const LINES = (color, extra = {}) => ({ color, ...extra });
  const NO_LINES = (color) => ({ enabled: false, color });
  const NO_OUTLINE = { enabled: false };
  const DOT = (size, shape = 'square') => ({ enabled: true, size, shape });
  const RING = (diameter, thickness = 1) => ({ enabled: true, shape: 'ring', size: diameter, thickness });
  const FIRE = (spread, kick = 0, speed = 120) => ({ enabled: true, spread, kick, speed });

  /** Original Crosshair Z library. */
  const PRESETS = [
    preset('Classic', 'Classic Green', {}),
    preset('Classic', 'Classic Cyan', { lines: LINES('#00e5ff') }),
    preset('Classic', 'Classic Yellow', { lines: LINES('#ffe600') }),
    preset('Classic', 'Classic Magenta', { lines: LINES('#ff2bd6') }),
    preset('Classic', 'Plus Dot', { lines: LINES('#ffe600', { offset: 8, length: 5 }), dot: DOT(2) }),
    preset('Classic', 'Wide Gap', { lines: LINES('#00ff66', { offset: 16, length: 6 }) }),
    preset('Classic', 'Thick Bold', { lines: LINES('#ffffff', { thickness: 4, length: 8, offset: 8 }), outline: { thickness: 2 } }),
    preset('Classic', 'No Outline', { lines: LINES('#00ffff'), outline: NO_OUTLINE }),

    preset('Dot', 'Tiny Dot', { lines: NO_LINES('#ff2bd6'), dot: DOT(3) }),
    preset('Dot', 'Pixel Dot', { lines: NO_LINES('#00ff66'), dot: DOT(1) }),
    preset('Dot', 'Round Dot', { lines: NO_LINES('#ff3b3b'), dot: DOT(5, 'circle') }),
    preset('Dot', 'Big Square', { lines: NO_LINES('#ffe600'), dot: DOT(6) }),
    preset('Dot', 'Ghost Dot', { lines: NO_LINES('#ffffff'), dot: { ...DOT(3, 'circle'), opacity: 0.6 }, outline: NO_OUTLINE }),

    preset('Circle', 'Circle Dot',
      { name: 'Ring', lines: NO_LINES('#ffffff'), dot: RING(28) },
      { name: 'Dot', lines: NO_LINES('#ffffff'), dot: DOT(2, 'circle') }),
    preset('Circle', 'Ring', { lines: NO_LINES('#00ff66'), dot: RING(20, 2) }),
    preset('Circle', 'Shotgun Ring',
      { name: 'Ring', lines: NO_LINES('#ff3b3b'), dot: RING(60) },
      { name: 'Dot', lines: NO_LINES('#ff3b3b'), dot: DOT(2) }),
    preset('Circle', 'Scoped Cross', { lines: LINES('#00e5ff', { offset: 13, length: 10, thickness: 1 }), dot: RING(24) }),

    preset('T-Shape', 'T-Shape', { lines: LINES('#00e5ff', { top: false, length: 7, offset: 8 }) }),
    preset('T-Shape', 'T Dot', { lines: LINES('#ffe600', { top: false, length: 6, offset: 6 }), dot: DOT(2) }),
    preset('T-Shape', 'Chevron', { rotation: 45, lines: LINES('#ff2bd6', { top: false, left: false, length: 8, offset: 0 }) }),
    preset('T-Shape', 'Bottom Only', { lines: LINES('#00ff66', { top: false, left: false, right: false, length: 10, offset: 4 }) }),
    preset('T-Shape', 'Triangle T', { lines: LINES('#ff8a00', { shape: 'triangle', top: false, length: 9, thickness: 5, offset: 7 }) }),

    preset('Sniper', 'Sniper Thin', { lines: LINES('#ff3b3b', { thickness: 1, length: 14, offset: 1 }), outline: NO_OUTLINE }),
    preset('Sniper', 'Long Lines', { lines: LINES('#00ff66', { thickness: 1, length: 40, offset: 13 }) }),
    preset('Sniper', 'Mil-Dot', { lines: LINES('#000000', { thickness: 1, length: 30, offset: 5 }), outline: { color: '#ffffff' }, dot: DOT(2, 'circle') }),
    preset('Sniper', 'Fine Point', { lines: LINES('#ffffff', { thickness: 1, length: 4, offset: 5 }), dot: DOT(1) }),

    preset('Dynamic', 'Spread Cross', { firing: FIRE(8) }),
    preset('Dynamic', 'Spread Ring',
      { name: 'Ring', lines: NO_LINES('#00e5ff'), dot: RING(16), firing: FIRE(10, 0, 160) },
      { name: 'Dot', lines: NO_LINES('#00e5ff'), dot: DOT(2), firing: FIRE(10, 0, 160) }),
    preset('Dynamic', 'Recoil Kick', { lines: LINES('#ffe600', { offset: 6, length: 5 }), dot: DOT(2), firing: FIRE(3, 6, 90) }),
    preset('Dynamic', 'Static Dot + Spread',
      { name: 'Dot', lines: NO_LINES('#ffffff'), dot: DOT(2) },
      { name: 'Lines', lines: LINES('#ff3b3b', { offset: 10, length: 5 }), firing: FIRE(12, 0, 150) }),

    preset('Layered', 'Bullet Drop',
      { name: 'Main', lines: LINES('#00ff66', { offset: 6, length: 6 }) },
      { name: 'Drop 1', offsetY: 14, lines: LINES('#00ff66', { top: false, bottom: false, length: 4, offset: 3, thickness: 1 }) },
      { name: 'Drop 2', offsetY: 26, lines: LINES('#00ff66', { top: false, bottom: false, length: 3, offset: 3, thickness: 1 }) },
      { name: 'Drop 3', offsetY: 38, lines: LINES('#00ff66', { top: false, bottom: false, length: 2, offset: 3, thickness: 1 }) }),
    preset('Layered', 'Dot in Ring X',
      { name: 'X', rotation: 45, lines: LINES('#ff2bd6', { length: 6, offset: 18 }) },
      { name: 'Ring', lines: NO_LINES('#ffffff'), dot: RING(12) },
      { name: 'Dot', lines: NO_LINES('#ffffff'), dot: DOT(2) }),
    preset('Layered', 'Double Cross',
      { name: 'Outer', lines: LINES('#00e5ff', { offset: 21, length: 6, thickness: 1 }) },
      { name: 'Inner', lines: LINES('#ffffff', { offset: 5, length: 3, thickness: 1 }) }),

    preset('Stylized', 'Big X', { rotation: 45, lines: LINES('#ffe600', { length: 10, thickness: 2, offset: 10 }) }),
    preset('Stylized', 'Diamond X', { rotation: 45, lines: LINES('#00e5ff', { length: 4, thickness: 2, offset: 6 }), dot: DOT(2, 'diamond') }),
    preset('Stylized', 'Tactical', { lines: LINES('#c6ff3d', { length: 12, thickness: 1, offset: 21 }), dot: DOT(3, 'circle'), outline: NO_OUTLINE }),
    preset('Stylized', 'Blocky', { lines: LINES('#ff8a00', { length: 4, thickness: 4, offset: 8 }), outline: { thickness: 2 } }),
    preset('Stylized', 'Arrows', { lines: LINES('#ffffff', { shape: 'triangle', length: 8, thickness: 5, offset: 9 }) }),
  ];

  return {
    SCHEMA_VERSION,
    LAYER_SCHEMA,
    DEFAULT_LAYER,
    DEFAULT_CROSSHAIR,
    MAX_LAYERS,
    MAX_IMAGE_CHARS,
    PRESETS,
    SHARE_PREFIX,
    LINE_SHAPES,
    DOT_SHAPES,
    FORM_TYPES,
    TEXT_LAYOUTS,
    LAYER_KINDS,
    DRAW_SIZE,
    sanitizeLayer,
    sanitizeCrosshair,
    crosshairExtent,
    overlaySizePx,
    drawCrosshair,
    layerBounds,
    onImageLoaded,
    primeImage,
    FireAnimator,
    firedLayer,
    hasFiring,
    hasImageLayers,
    encodeShareCode,
    decodeShareCode,
  };
});
