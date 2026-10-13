'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { convertCrosshairX } = require('../src/shared/crosshairx-import');

/** Shape taken from a real Crosshair X saved crosshair file. */
const sample = (patch = {}) => ({
  name: 'My crosshair',
  pos: { x: 0, y: 0 },
  model: [{
    dot: { diameter: 4, opacity: 0, color: '#FFFFFF', shape: 'circle', blur: 0 },
    line: { length: 4, thickness: 2, offset: 2, opacity: 1, color: '#FFFFFF', shape: 'rectangle', blur: 0, rotation: 0, visible: ['left', 'right', 'top', 'bottom'] },
    outline: { thickness: 1, opacity: 0.8, color: '#0000FF', blur: 0 },
    firingOptions: { firingOffset: 0 },
    position: { x: 0, y: 0 },
    layer: { size: 1 },
    type: 'model',
    ...patch,
  }],
});

test('maps lines, outline, scale, name', () => {
  const r = convertCrosshairX(sample(), 'fallback');
  assert.strictEqual(r.name, 'My crosshair');
  assert.strictEqual(r.crosshair.layers.length, 1);
  const l = r.crosshair.layers[0];
  // X offset 2 = 2 empty px between opposite arms; even thickness → Z gap 1 per side
  assert.deepStrictEqual([l.lines.length, l.lines.thickness, l.lines.gap], [4, 2, 1]);
  assert.strictEqual(l.color, '#ffffff');
  assert.strictEqual(l.dot.enabled, false);
  assert.deepStrictEqual([l.outline.enabled, l.outline.color, l.outline.opacity], [true, '#0000ff', 0.8]);
  assert.strictEqual(l.scale, 1);
});

test('outline thickness/opacity 0 disables outline; layer.size → scale', () => {
  const l = convertCrosshairX(sample({ outline: { thickness: 0, opacity: 0, color: '#FF0000' }, layer: { size: 1.18 } }), 'x').crosshair.layers[0];
  assert.strictEqual(l.outline.enabled, false);
  assert.strictEqual(l.scale, 1.18);
});

test('visible arms subset → T-shape', () => {
  const l = convertCrosshairX(sample({ line: { length: 5, thickness: 2, offset: 3, opacity: 1, color: '#00FF00', visible: ['left', 'right', 'bottom'] } }), 'x').crosshair.layers[0];
  assert.deepStrictEqual([l.lines.top, l.lines.bottom, l.lines.left, l.lines.right], [false, true, true, true]);
});

test('dot with different opacity becomes separate layer, keeps dot color', () => {
  const r = convertCrosshairX(sample({ dot: { diameter: 3, opacity: 0.5, color: '#FF0000', shape: 'square' } }), 'x');
  assert.strictEqual(r.crosshair.layers.length, 2);
  const [lines, dot] = r.crosshair.layers;
  assert.strictEqual(lines.dot.enabled, false);
  assert.deepStrictEqual([dot.lines.enabled, dot.dot.enabled, dot.dot.size, dot.dot.shape, dot.dot.color, dot.opacity], [false, true, 3, 'square', '#ff0000', 0.5]);
});

test('dot with same opacity stays in one layer', () => {
  const r = convertCrosshairX(sample({ dot: { diameter: 2, opacity: 1, color: '#00FF00', shape: 'circle' } }), 'x');
  assert.strictEqual(r.crosshair.layers.length, 1);
  assert.strictEqual(r.crosshair.layers[0].dot.enabled, true);
  assert.strictEqual(r.crosshair.layers[0].dot.useMainColor, false);
});

test('position + global pos → offsets; firing offset → spread', () => {
  const data = sample({ position: { x: 3, y: -4 }, firingOptions: { firingOffset: 5, duration: 200 } });
  data.pos = { x: 1, y: 1 };
  const l = convertCrosshairX(data, 'x').crosshair.layers[0];
  assert.deepStrictEqual([l.offsetX, l.offsetY], [4, -3]);
  assert.deepStrictEqual([l.firing.enabled, l.firing.spread, l.firing.speed], [true, 5, 200]);
});

test('missing name uses fallback; garbage rejected', () => {
  const d = sample();
  delete d.name;
  assert.strictEqual(convertCrosshairX(d, 'CrosshairX 123').name, 'CrosshairX 123');
  assert.throws(() => convertCrosshairX({}, 'x'), /not a Crosshair X/);
  assert.throws(() => convertCrosshairX(null, 'x'), /not a Crosshair X/);
});

test('unnamed crosshairs get a descriptive name', () => {
  const d = sample();
  delete d.name;
  assert.strictEqual(convertCrosshairX(d).name, 'White cross');
  const dot = sample({ line: { length: 0, opacity: 0 }, dot: { diameter: 3, opacity: 1, color: '#FF0000' } });
  delete dot.name;
  assert.strictEqual(convertCrosshairX(dot).name, 'Red dot');
  const t = sample({ line: { length: 5, thickness: 2, offset: 2, opacity: 1, color: '#00FF00', visible: ['left', 'right', 'bottom'] } });
  delete t.name;
  assert.strictEqual(convertCrosshairX(t).name, 'Green T');
});

test('X total offset → Z per-side gap (odd/even thickness, offset 0)', () => {
  const gap = (thickness, offset) => convertCrosshairX(sample({ line: { length: 4, thickness, offset, opacity: 1, color: '#FFFFFF' } }), 'x').crosshair.layers[0].lines.gap;
  assert.deepStrictEqual([gap(1, 3), gap(1, 1), gap(1, 0), gap(2, 4), gap(2, 0), gap(3, 5)], [1, 0, -1, 2, 0, 2]);
});

test('ring dot → circle in dot color; square dot not rotated with lines; thickness 0 hides lines', () => {
  const ring = convertCrosshairX(sample({ dot: { diameter: 8, thickness: 2, opacity: 1, color: '#FF0000', shape: 'ring' } }), 'x').crosshair.layers;
  assert.strictEqual(ring.length, 2);
  assert.deepStrictEqual([ring[1].circle.enabled, ring[1].circle.radius, ring[1].circle.thickness, ring[1].color, ring[1].dot.enabled], [true, 4, 2, '#ff0000', false]);
  const rot = convertCrosshairX(sample({
    dot: { diameter: 3, opacity: 1, color: '#FFFFFF', shape: 'square' },
    line: { length: 4, thickness: 1, offset: 3, opacity: 1, color: '#FFFFFF', rotation: 45 },
  }), 'x').crosshair.layers;
  assert.deepStrictEqual(rot.map((l) => l.rotation), [45, 0]);
  const noLines = convertCrosshairX(sample({ line: { length: 4, thickness: 0, offset: 2, opacity: 1 }, dot: { diameter: 2, opacity: 1, color: '#FFFFFF', shape: 'square' } }), 'x').crosshair.layers;
  assert.deepStrictEqual([noLines.length, noLines[0].lines.enabled, noLines[0].dot.enabled], [1, false, true]);
  assert.throws(() => convertCrosshairX(sample({ line: { length: 0, opacity: 0 } }), 'x'), /no visible parts/);
});

test('line blur stays off the dot; outline with thickness 0 renders 1px like X (Oilrats)', () => {
  const l = convertCrosshairX(sample({
    dot: { diameter: 4, opacity: 1, color: '#00A2FF', shape: 'circle', blur: 0 },
    line: { length: 0, thickness: 0, offset: 0, opacity: 0, color: '#0C9A9C', blur: 20, rotation: 360 },
    outline: { thickness: 0, opacity: 1, color: '#000000', blur: 0 },
  }), 'x').crosshair.layers;
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual([l[0].blur, l[0].rotation, l[0].dot.enabled, l[0].outline.enabled, l[0].outline.thickness], [0, 0, true, true, 1]);
});
