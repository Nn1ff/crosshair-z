'use strict';

/**
 * Converts crosshairs saved by Crosshair X (user's local JSON data files) into Crosshair Z format.
 * Works on the documented-by-example data shape only:
 *   { name?, pos:{x,y}, model:[{ type:'model', line, dot, outline, position, layer:{size}, firingOptions }] }
 * Unknown/unsupported parts (custom images, animations beyond a simple spread) are skipped.
 */
const core = require('./crosshair-core');

const ARMS = ['top', 'bottom', 'left', 'right'];
const DEFAULT_ANIM_MS = 120;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function color(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** Firing: map simple outward/inward offset to spread; everything else is not representable. */
function convertFiring(fo) {
  const f = obj(fo);
  const off = num(f.firingOffset);
  if (!off) return { enabled: false };
  return { enabled: true, spread: Math.abs(Math.round(off)), kick: 0, speed: Math.max(20, num(f.duration, DEFAULT_ANIM_MS) || DEFAULT_ANIM_MS) };
}

/**
 * Convert one Crosshair X model entry into 1–2 Z layers.
 * Dot gets its own layer when its opacity differs from the lines (Z has one opacity per layer).
 * @returns {{layers: object[], warnings: string[]}}
 */
function convertModel(m, index, pos) {
  const warnings = [];
  const line = obj(m.line);
  const dot = obj(m.dot);
  const outline = obj(m.outline);
  const position = obj(m.position);
  const scale = num(obj(m.layer).size, 1) || 1;
  const visible = Array.isArray(line.visible) ? line.visible : ARMS;

  const lineOpacity = num(line.opacity, 1);
  const dotOpacity = num(dot.opacity, 0);
  const linesOn = lineOpacity > 0 && num(line.length) > 0 && visible.length > 0;
  const dotOn = dotOpacity > 0 && num(dot.diameter) > 0;
  const outlineOn = num(outline.thickness) > 0 && num(outline.opacity) > 0;
  if (line.shape && line.shape !== 'rectangle') warnings.push(`line shape "${line.shape}" drawn as rectangle`);
  if (m.type && m.type !== 'model') warnings.push(`layer type "${m.type}" not supported`);

  const base = {
    name: `Layer ${index + 1}`,
    visible: true,
    kind: 'shape',
    offsetX: Math.round(num(position.x) + num(pos.x)),
    offsetY: Math.round(num(position.y) + num(pos.y)),
    color: color(line.color, '#ffffff'),
    rotation: Math.round(num(line.rotation)),
    scale,
    blur: Math.round(Math.max(num(line.blur), num(dot.blur))),
    lines: {
      enabled: linesOn,
      length: Math.round(num(line.length)),
      thickness: Math.max(1, Math.round(num(line.thickness, 1))),
      gap: Math.round(num(line.offset)),
      top: visible.includes('top'),
      bottom: visible.includes('bottom'),
      left: visible.includes('left'),
      right: visible.includes('right'),
    },
    dot: {
      enabled: false,
      size: Math.max(1, Math.round(num(dot.diameter, 2))),
      shape: dot.shape === 'square' ? 'square' : 'circle',
      color: color(dot.color, '#ffffff'),
      useMainColor: false,
    },
    circle: { enabled: false },
    firing: convertFiring(m.firingOptions),
  };

  // Z composites outline under the layer opacity → divide so effective outline alpha matches.
  const outlineFor = (layerOpacity) => ({
    enabled: outlineOn,
    thickness: Math.max(1, Math.round(num(outline.thickness, 1))),
    color: color(outline.color, '#000000'),
    opacity: layerOpacity > 0 ? Math.min(1, num(outline.opacity, 1) / layerOpacity) : 1,
  });

  const layers = [];
  const sameOpacity = !linesOn || !dotOn || Math.abs(lineOpacity - dotOpacity) < 0.001;
  if (sameOpacity) {
    const op = linesOn ? lineOpacity : dotOn ? dotOpacity : 1;
    layers.push({ ...base, opacity: op, dot: { ...base.dot, enabled: dotOn }, outline: outlineFor(op) });
  } else {
    layers.push({ ...base, opacity: lineOpacity, outline: outlineFor(lineOpacity) });
    layers.push({
      ...base,
      name: `Layer ${index + 1} dot`,
      opacity: dotOpacity,
      lines: { ...base.lines, enabled: false },
      dot: { ...base.dot, enabled: true },
      outline: outlineFor(dotOpacity),
    });
  }
  if (!linesOn && !dotOn) warnings.push(`layer ${index + 1} is empty`);
  return { layers, warnings };
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
  const l = ch.layers.find((x) => x.visible && (x.lines.enabled || x.dot.enabled || x.circle.enabled)) || ch.layers[0];
  const L = l.lines;
  const arms = ['top', 'bottom', 'left', 'right'].filter((a) => L[a]).length;
  let shape = 'dot';
  if (L.enabled && L.length > 0) {
    if (arms === 3) shape = 'T';
    else if (arms < 3) shape = 'lines';
    else shape = Math.abs(l.rotation % 90) === 45 ? 'X' : 'cross';
    if (l.dot.enabled) shape += ' with dot';
  } else if (l.circle.enabled) {
    shape = 'circle';
  }
  const color = colorName(l.lines.enabled ? l.color : l.dot.useMainColor ? l.color : l.dot.color);
  const name = `${color} ${shape}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Convert a parsed Crosshair X crosshair JSON.
 * @param {unknown} data
 * @param {string} fallbackName
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
  const crosshair = core.sanitizeCrosshair({ layers });
  const named = typeof src.name === 'string' && src.name.trim();
  const name = named ? src.name.trim().slice(0, 40) : fallbackName || describe(crosshair);
  return { name, crosshair, warnings };
}

module.exports = { convertCrosshairX, describe };
