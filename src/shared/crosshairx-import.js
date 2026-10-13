'use strict';

/**
 * Converts crosshairs saved by Crosshair X / Y (user's local JSON data files) into Crosshair Z format.
 * Works on the documented-by-example data shape only:
 *   { name?, pos:{x,y}, model:[{ type:'model', line, dot, outline, position, layer:{size}, firingOptions }] }
 * Z layers use the same model (separate line / dot / outline parts, total-gap offset), so most
 * values map 1:1. Unsupported parts (custom images, text, chevron/arc arms, staged animations)
 * are skipped or simplified with a warning.
 */
const core = require('./crosshair-core');

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
  if (m.type && m.type !== 'model') {
    warnings.push(`layer type "${m.type}" not supported`);
    return { layers: [], warnings };
  }
  if (scale <= 0) return { layers: [], warnings };
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
  if (linesOn && line.armCount !== undefined && line.armCount !== 4) warnings.push('radial arms drawn as 4 arms');
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
  const l = ch.layers.find((x) => x.visible && (x.lines.enabled || x.dot.enabled)) || ch.layers[0];
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
  const name = `${colorName(L.enabled ? L.color : dotColor)} ${shape}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
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

module.exports = { convertCrosshairX, describe };
