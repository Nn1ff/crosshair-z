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
 * Crosshair X / Y "offset" is the total pixel gap between opposite arms; Z "gap" is the distance
 * from the layer origin to each arm. Odd thickness: origin is a pixel center, so empty pixels = 2·gap + 1;
 * even thickness: origin is a pixel corner, so empty pixels = 2·gap. Offset 0 with odd thickness
 * means the arms meet in the center pixel (gap -1). Parity mismatches round to the nearest symmetric gap.
 */
function zGap(offset, thickness) {
  const o = Math.max(0, Math.round(offset));
  if (thickness % 2 === 1) return o === 0 ? -1 : Math.round((o - 1) / 2);
  return Math.round(o / 2);
}

/**
 * Convert one Crosshair X model entry into 0–2 Z layers.
 * Z has one color/opacity/rotation per layer, so the dot gets its own layer when it cannot share
 * the lines' layer: different opacity, a ring (drawn as Z circle in the layer color) in another color,
 * or a non-round dot under rotated lines (X rotates only the lines, never the dot).
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
  const thickness = Math.round(num(line.thickness, 1));
  const linesOn = lineOpacity > 0 && num(line.length) > 0 && thickness > 0 && visible.length > 0;
  const diameter = Math.round(num(dot.diameter, 2));
  const dotOn = dotOpacity > 0 && diameter > 0;
  // X draws the outline whenever it is visible; thickness 0 still renders 1px (crispThickness)
  const outlineOn = num(outline.opacity) > 0;
  const ring = dot.shape === 'ring';
  const rotation = ((Math.round(num(line.rotation)) % 360) + 540) % 360 - 180; // 360 → 0, 270 → -90
  const lineBlur = Math.round(num(line.blur));
  const dotBlur = Math.round(num(dot.blur));
  const lineColor = color(line.color, '#ffffff');
  const dotColor = color(dot.color, '#ffffff');
  if (linesOn && line.shape && line.shape !== 'rectangle') warnings.push(`line shape "${line.shape}" drawn as rectangle`);
  if (dotOn && dot.shape === 'diamond') warnings.push('diamond dot drawn as square');
  if (m.type && m.type !== 'model') warnings.push(`layer type "${m.type}" not supported`);

  const base = {
    name: `Layer ${index + 1}`,
    visible: true,
    kind: 'shape',
    offsetX: Math.round(num(position.x) + num(pos.x)),
    offsetY: Math.round(num(position.y) + num(pos.y)),
    color: lineColor,
    rotation,
    scale,
    blur: linesOn ? lineBlur : dotBlur, // X blurs lines and dot separately
    lines: {
      enabled: linesOn,
      length: Math.round(num(line.length)),
      thickness: Math.max(1, thickness),
      gap: zGap(num(line.offset), Math.max(1, thickness)),
      top: visible.includes('top'),
      bottom: visible.includes('bottom'),
      left: visible.includes('left'),
      right: visible.includes('right'),
    },
    dot: { enabled: false, size: Math.max(1, diameter), shape: dot.shape === 'circle' ? 'circle' : 'square', color: dotColor, useMainColor: false },
    circle: { enabled: false },
    firing: convertFiring(m.firingOptions),
  };
  // ring = stroked circle of the given diameter; X draws thickness 0/missing as 1px
  const dotPart = ring
    ? { circle: { enabled: true, radius: Math.max(1, Math.round(diameter / 2)), thickness: Math.max(1, Math.round(num(dot.thickness, 1)) || 1) } }
    : { dot: { ...base.dot, enabled: true } };

  // Z composites outline under the layer opacity → divide so effective outline alpha matches.
  const outlineFor = (layerOpacity) => ({
    enabled: outlineOn,
    // X scales the outline with the layer, Z draws it unscaled
    thickness: Math.max(1, Math.round(Math.max(1, Math.round(num(outline.thickness, 1))) * scale)),
    color: color(outline.color, '#000000'),
    opacity: layerOpacity > 0 ? Math.min(1, num(outline.opacity, 1) / layerOpacity) : 1,
  });

  const layers = [];
  const dotRotates = !ring && dot.shape !== 'circle' && rotation % 90 !== 0;
  const shared = !linesOn || (Math.abs(lineOpacity - dotOpacity) < 0.001 && !(ring && dotColor !== lineColor) && !dotRotates && lineBlur === dotBlur);
  if (linesOn) {
    const withDot = dotOn && shared;
    layers.push({ ...base, opacity: lineOpacity, ...(withDot ? dotPart : {}), outline: outlineFor(lineOpacity) });
  }
  if (dotOn && !(linesOn && shared)) {
    layers.push({
      ...base,
      name: linesOn ? `Layer ${index + 1} dot` : base.name,
      color: ring ? dotColor : base.color,
      rotation: 0, // X never rotates the dot
      blur: dotBlur,
      opacity: dotOpacity,
      lines: { ...base.lines, enabled: false },
      ...dotPart,
      outline: outlineFor(dotOpacity),
    });
  }
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
  if (layers.length === 0) throw new Error('crosshair has no visible parts');
  const crosshair = core.sanitizeCrosshair({ layers });
  const named = typeof src.name === 'string' && src.name.trim();
  const name = named ? src.name.trim().slice(0, 40) : fallbackName || describe(crosshair);
  return { name, crosshair, warnings };
}

module.exports = { convertCrosshairX, describe };
