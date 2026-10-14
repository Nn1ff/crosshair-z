'use strict';

// UMD: node (main process, tests) and browser (native settings page, after crosshair-core.js).
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./crosshair-core') : root.CrosshairCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrosshairXImport = api;
})(typeof self !== 'undefined' ? self : this, function (core) {

/**
 * Converts crosshairs saved by Crosshair X / Y (user's local JSON data files) into Crosshair Z format.
 * Works on the documented-by-example data shape only:
 *   { name?, pos:{x,y}, model:[{ type:'model'|'shape'|'text'|'draw'|'image', …, position, layer:{size} }] }
 * Z layers use the same model (separate line / dot / outline parts, total-gap offset, the same arm
 * shapes and layer types), so most values map 1:1. Unsupported details (anchors, angled arc caps,
 * staged animations) are simplified with a warning.
 */

const ARMS = ['top', 'bottom', 'left', 'right'];
const DEFAULT_ANIM_MS = 120;
const MAX_NAME = 40;
const LAYER_NAME_MAX = 24;

function num(v, fallback = 0) {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : fallback;
}

/** Old X saves use color names; X renders them as CSS colors. */
const NAMED_COLORS = {
  red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', purple: '#800080', orange: '#ffa500',
  pink: '#ffc0cb', brown: '#a52a2a', gray: '#808080', grey: '#808080', black: '#000000', white: '#ffffff',
};

const hex2 = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** Accepts "#rrggbb", "#rgb", CSS names, "rgb(r, g, b)" and bare "r, g, b" (all seen in X data). */
function color(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('');
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  const m = /^(?:rgba?\()?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/.exec(s);
  return m ? '#' + hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3]) : fallback;
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** Angle in -180..180 (360 → 0, 270 → -90). */
function normAngle(deg) {
  return ((Math.round(deg) % 360) + 540) % 360 - 180;
}

/** Firing: map simple outward/inward offset to spread; everything else is not representable. */
function convertFiring(fo) {
  const f = obj(fo);
  const off = num(f.firingOffset);
  if (!off) return { enabled: false };
  return { enabled: true, spread: Math.abs(Math.round(off)), kick: 0, speed: Math.max(20, num(f.duration, DEFAULT_ANIM_MS) || DEFAULT_ANIM_MS) };
}

function clampInt(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** Y draws shape/text outlines only when both thickness and opacity are set. */
function partOutline(outline) {
  const o = obj(outline);
  return {
    enabled: num(o.thickness) > 0 && num(o.opacity) > 0,
    thickness: Math.max(1, Math.round(num(o.thickness, 1))),
    color: color(o.color, '#000000'),
    opacity: num(o.opacity, 1),
    blur: num(o.blur),
  };
}

const IMAGE_DATA_RE = /^data:image\/png;base64,/;
const ANY_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;

/** Crosshair X / Y non-model layer types → Z layer fields (position/scale added by the caller). */
const OTHER_TYPES = {
  shape(m, warnings) {
    const anchor = obj(m.anchor);
    if ((anchor.x && anchor.x !== 'center') || (anchor.y && anchor.y !== 'center')) warnings.push('shape anchor treated as center');
    return {
      kind: 'form',
      rotation: normAngle(num(m.rotation)),
      form: {
        type: core.FORM_TYPES.includes(m.shape) ? m.shape : 'square',
        width: Math.round(num(m.width, 20)),
        height: Math.round(num(m.height, 20)),
        corner: Math.round(num(m.cornerRadius)),
        color: color(m.color, '#00ff00'),
        opacity: num(m.opacity, 1),
        blur: num(m.blur),
      },
      outline: partOutline(m.outline),
    };
  },
  text(m, warnings) {
    if (m.repeatToFill) warnings.push('repeated circle text drawn once');
    return {
      kind: 'text',
      rotation: normAngle(num(m.rotation)),
      text: {
        value: typeof m.text === 'string' ? m.text : '',
        size: Math.round(num(m.fontSize, 14)),
        bold: num(m.fontWeight, 700) >= 600,
        spacing: Math.round(num(m.letterSpacing)),
        layout: m.layout === 'circle' ? 'circle' : 'line',
        radius: Math.round(num(m.radius, 30)),
        color: color(m.color, '#ffffff'),
        opacity: num(m.opacity, 1),
        blur: num(m.blur),
      },
      outline: partOutline(m.outline),
    };
  },
  image(m) {
    if (typeof m.image !== 'string' || !ANY_IMAGE_RE.test(m.image)) return null;
    // Z sizes images by their longest edge
    const size = Math.round(Math.max(num(m.width, 64), num(m.height, 64)));
    return { kind: 'image', rotation: normAngle(num(m.rotation)), image: { src: m.image, size, opacity: num(m.opacity, 1), blur: 0 } };
  },
  draw(m, warnings) {
    if (typeof m.image !== 'string' || !IMAGE_DATA_RE.test(m.image)) return null;
    const w = num(m.width, core.DRAW_SIZE);
    if (w <= 0) return null;
    if (num(m.height, w) !== w) warnings.push('non-square drawing stretched to square');
    // Z drawings are DRAW_SIZE px wide; other sizes scale the layer instead
    return { kind: 'draw', scaleMul: w / core.DRAW_SIZE, draw: { src: m.image, color: '#ffffff', opacity: num(m.opacity, 1), blur: 0 } };
  },
};

/**
 * Convert one Crosshair X model entry into 0–1 Z layer.
 * @returns {{layers: object[], warnings: string[]}}
 */
function convertModel(m, index, pos) {
  const warnings = [];
  const line = obj(m.line);
  const dot = obj(m.dot);
  const outline = obj(m.outline);
  const position = obj(m.position);
  const scale = num(obj(m.layer).size, 1);
  if (scale <= 0) return { layers: [], warnings };
  if (m.type && m.type !== 'model') {
    const convert = OTHER_TYPES[m.type];
    if (!convert) {
      warnings.push(`layer type "${m.type}" not supported`);
      return { layers: [], warnings };
    }
    const converted = convert(m, warnings);
    if (!converted) return { layers: [], warnings };
    const { scaleMul = 1, ...fields } = converted;
    const offsetX = Math.round(num(position.x) + num(pos.x));
    const offsetY = Math.round(num(position.y) + num(pos.y));
    return { layers: [{ name: `Layer ${index + 1}`, visible: true, offsetX, offsetY, scale: scale * scaleMul, ...fields }], warnings };
  }
  const visible = Array.isArray(line.visible) ? line.visible : ARMS;

  const thickness = Math.round(num(line.thickness, 1));
  const linesOn = num(line.opacity, 1) > 0 && num(line.length) > 0 && thickness > 0 && visible.length > 0;
  const diameter = Math.round(num(dot.diameter, 2));
  const dotOn = num(dot.opacity, 0) > 0 && diameter > 0;
  if (!linesOn && !dotOn) return { layers: [], warnings };

  let shape = line.shape || 'rectangle';
  if (linesOn && !core.LINE_SHAPES.includes(shape)) {
    warnings.push(`line shape "${shape}" drawn as rectangle`);
    shape = 'rectangle';
  }
  const count = clampInt(num(line.armCount, 4), 3, 8);
  if (linesOn && count !== 4 && Array.isArray(line.visibleArms)) warnings.push('hidden radial arms are shown');
  if (linesOn && shape === 'arc' && line.capStyle === 'angled') warnings.push('angled arc caps drawn flat');
  const dotShape = core.DOT_SHAPES.includes(dot.shape) ? dot.shape : 'circle';
  if (num(scale, 1) > 8 || scale < 0.25) warnings.push('layer size clamped');

  const layer = {
    name: `Layer ${index + 1}`.slice(0, LAYER_NAME_MAX),
    visible: true,
    kind: 'shape',
    offsetX: Math.round(num(position.x) + num(pos.x)),
    offsetY: Math.round(num(position.y) + num(pos.y)),
    rotation: normAngle(num(line.rotation)),
    scale,
    lines: {
      enabled: linesOn,
      shape,
      color: color(line.color, '#ffffff'),
      opacity: num(line.opacity, 1),
      length: Math.round(num(line.length)),
      thickness: Math.max(1, thickness),
      offset: Math.round(num(line.offset)),
      blur: num(line.blur),
      top: visible.includes('top'),
      bottom: visible.includes('bottom'),
      left: visible.includes('left'),
      right: visible.includes('right'),
      count,
      angle: num(line.angle, 60),
      roundness: num(line.roundness, 0),
      capLength: num(line.capLength, 8),
      capThickness: num(line.capThickness, 2),
    },
    dot: {
      enabled: dotOn,
      shape: dotShape,
      size: Math.max(1, diameter),
      // X draws ring thickness 0/missing as 1px
      thickness: Math.max(1, Math.round(num(dot.thickness, 1))),
      color: color(dot.color, '#ffffff'),
      useMainColor: false,
      opacity: num(dot.opacity, 0),
      blur: num(dot.blur),
    },
    outline: {
      // X draws the outline whenever it is visible; thickness 0 still renders 1px (crispThickness)
      enabled: num(outline.opacity) > 0,
      // X scales the outline with the layer, Z draws it unscaled
      thickness: Math.max(1, Math.round(Math.max(1, Math.round(num(outline.thickness, 1))) * scale)),
      color: color(outline.color, '#000000'),
      opacity: num(outline.opacity, 1),
      blur: num(outline.blur),
    },
    firing: convertFiring(m.firingOptions),
  };
  return { layers: [layer], warnings };
}

const COLOR_NAMES = [
  ['white', [255, 255, 255]], ['black', [0, 0, 0]], ['grey', [128, 128, 128]],
  ['red', [230, 40, 40]], ['orange', [255, 140, 0]], ['yellow', [250, 230, 30]],
  ['green', [40, 220, 60]], ['cyan', [0, 220, 230]], ['blue', [40, 80, 255]],
  ['purple', [140, 60, 220]], ['pink', [255, 60, 200]],
];

/** Nearest plain color word for a hex color. */
function colorName(hex) {
  const v = parseInt(hex.slice(1), 16);
  const rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  let best = COLOR_NAMES[0];
  let bestD = Infinity;
  for (const entry of COLOR_NAMES) {
    const d = entry[1].reduce((acc, c, i) => acc + (c - rgb[i]) ** 2, 0);
    if (d < bestD) {
      bestD = d;
      best = entry;
    }
  }
  return best[0];
}

/** Short human name from the first visible layer, e.g. "Green cross", "Red dot", "White T". */
function describe(ch) {
  const shapes = ch.layers.filter((x) => x.visible && x.kind === 'shape' && (x.lines.enabled || x.dot.enabled));
  if (!shapes.length) {
    const other = ch.layers.find((x) => x.visible && x.kind !== 'shape') || ch.layers[0];
    if (other.kind === 'text') return `${capitalize(colorName(other.text.color))} text`;
    if (other.kind === 'form') return `${capitalize(colorName(other.form.color))} ${other.form.type}`;
    if (other.kind === 'draw') return 'Drawing';
  }
  const l = shapes[0] || ch.layers[0];
  const L = l.lines;
  const arms = ARMS.filter((a) => L[a]).length;
  let shape = l.dot.shape === 'ring' ? 'circle' : 'dot';
  if (L.enabled && L.length > 0) {
    if (arms === 3) shape = 'T';
    else if (arms < 3) shape = 'lines';
    else shape = Math.abs(l.rotation % 90) === 45 ? 'X' : 'cross';
    if (l.dot.enabled) shape += ' with dot';
  }
  const dotColor = l.dot.useMainColor ? L.color : l.dot.color;
  return capitalize(`${colorName(L.enabled ? L.color : dotColor)} ${shape}`);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Convert a parsed Crosshair X crosshair JSON.
 * @param {unknown} data
 * @param {string} [fallbackName]
 * @returns {{name: string, crosshair: object, warnings: string[]}}
 * @throws {Error} when data is not a Crosshair X crosshair
 */
function convertCrosshairX(data, fallbackName) {
  const src = obj(data);
  if (!Array.isArray(src.model) || src.model.length === 0) throw new Error('not a Crosshair X crosshair (no model)');
  const pos = obj(src.pos);
  const warnings = [];
  const layers = [];
  src.model.forEach((m, i) => {
    const r = convertModel(obj(m), i, pos);
    layers.push(...r.layers);
    warnings.push(...r.warnings);
  });
  if (layers.length > core.MAX_LAYERS) warnings.push(`only first ${core.MAX_LAYERS} layers kept`);
  if (layers.length === 0) throw new Error('crosshair has no visible parts');
  const crosshair = core.sanitizeCrosshair({ version: core.SCHEMA_VERSION, layers });
  const named = typeof src.name === 'string' && src.name.trim();
  const name = named ? src.name.trim().slice(0, MAX_NAME) : fallbackName || describe(crosshair);
  return { name, crosshair, warnings };
}

return { convertCrosshairX, describe };
});
