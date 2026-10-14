'use strict';

const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/shared/crosshair-core');


const plain = (o) => JSON.parse(JSON.stringify(o));

test('sanitize fills defaults from garbage', () => {
  assert.deepStrictEqual(core.sanitizeCrosshair(null), plain(core.DEFAULT_CROSSHAIR));
  assert.deepStrictEqual(core.sanitizeCrosshair({ layers: [] }), plain(core.DEFAULT_CROSSHAIR));
});

test('legacy flat crosshair becomes single layer', () => {
  const ch = core.sanitizeCrosshair({ color: '#ff0000', lines: { gap: 7 } });
  assert.strictEqual(ch.version, core.SCHEMA_VERSION);
  assert.strictEqual(ch.layers.length, 1);
  assert.strictEqual(ch.layers[0].lines.color, '#ff0000');
  assert.strictEqual(ch.layers[0].lines.offset, 14); // per-side gap 7, even thickness
});

test('v2 layers upgrade: gap → offset, opacity/blur per part, circle → ring, dot+circle split', () => {
  const ch = core.sanitizeCrosshair({ layers: [
    { color: '#112233', opacity: 0.5, blur: 2, lines: { gap: 2, thickness: 1 }, outline: { opacity: 0.5 } },
    { lines: { gap: -1, thickness: 3 } },
    { color: '#ff0000', lines: { enabled: false }, circle: { enabled: true, radius: 9, thickness: 2 } },
    { name: 'Both', lines: { enabled: false }, dot: { enabled: true }, circle: { enabled: true } },
    { rotation: 45, dot: { enabled: true } },
  ] });
  const [a, b, ring, bothRing, bothDot, turned] = ch.layers;
  assert.deepStrictEqual([a.lines.offset, a.lines.color, a.lines.opacity, a.lines.blur, a.outline.opacity, a.outline.blur], [5, '#112233', 0.5, 2, 0.25, 2]);
  assert.strictEqual(b.lines.offset, 0);
  assert.deepStrictEqual([ring.dot.enabled, ring.dot.shape, ring.dot.size, ring.dot.thickness, ring.lines.color], [true, 'ring', 18, 2, '#ff0000']);
  assert.deepStrictEqual([ch.layers.length, bothRing.dot.shape, bothDot.dot.shape, bothDot.name], [6, 'ring', 'square', 'Both dot']);
  assert.deepStrictEqual([turned.rotation, turned.dot.shape], [45, 'diamond']);
});

test('v3 layers stay v3; old defaults equal new defaults', () => {
  assert.deepStrictEqual(core.sanitizeCrosshair({ layers: [{}] }).layers[0], plain(core.DEFAULT_LAYER));
  const ch = core.sanitizeCrosshair({ layers: [{ lines: { offset: 3, color: '#abcdef' } }] });
  assert.deepStrictEqual([ch.layers[0].lines.offset, ch.layers[0].lines.color], [3, '#abcdef']);
  assert.deepStrictEqual(core.sanitizeCrosshair(ch), ch);
});

test('sanitize clamps numbers, rejects bad colors/enums/images, caps layers', () => {
  const l = core.sanitizeLayer({
    scale: -1, lines: { color: 'red', opacity: 5, length: 1e9, thickness: 'abc', offset: 2.6, shape: 'star' }, dot: { shape: 'star' },
    image: { src: 'javascript:alert(1)' }, offsetX: null,
  });
  assert.strictEqual(l.lines.opacity, 1);
  assert.strictEqual(l.scale, 0.25);
  assert.strictEqual(l.lines.color, core.DEFAULT_LAYER.lines.color);
  assert.strictEqual(l.lines.length, 100);
  assert.strictEqual(l.lines.thickness, core.DEFAULT_LAYER.lines.thickness);
  assert.strictEqual(l.lines.offset, 3);
  assert.strictEqual(l.lines.shape, 'rectangle');
  assert.strictEqual(l.dot.shape, 'square');
  assert.strictEqual(l.image.src, '');
  assert.strictEqual(l.offsetX, 0);
  assert.strictEqual(core.sanitizeCrosshair({ layers: Array(100).fill({}) }).layers.length, core.MAX_LAYERS);
});

test('share code roundtrip for every preset', () => {
  for (const p of core.PRESETS) {
    const code = core.encodeShareCode(p.crosshair);
    assert.ok(code.startsWith(core.SHARE_PREFIX));
    assert.deepStrictEqual(core.decodeShareCode(code), p.crosshair, p.name);
  }
});

test('share code drops image layers, rejects image-only', () => {
  const img = { kind: 'image', image: { src: 'data:image/png;base64,AAAA', size: 32 } };
  const ch = core.sanitizeCrosshair({ layers: [{}, img] });
  assert.strictEqual(core.decodeShareCode(core.encodeShareCode(ch)).layers.length, 1);
  assert.throws(() => core.encodeShareCode({ layers: [img] }), /cannot be shared/);
});

test('legacy CZ1 / CZ2 codes still decode', () => {
  const cz1 = 'CZ1-' + Buffer.from(JSON.stringify({ color: '#123456' })).toString('base64url');
  assert.strictEqual(core.decodeShareCode(cz1).layers[0].lines.color, '#123456');
  // CZ2 diffs were taken against the old defaults: an empty layer is the old default cross
  const cz2 = 'CZ2-' + Buffer.from(JSON.stringify([{}, { lines: { gap: 1, thickness: 1 } }])).toString('base64url');
  const ch = core.decodeShareCode(cz2);
  assert.deepStrictEqual(ch.layers[0], plain(core.DEFAULT_LAYER));
  assert.strictEqual(ch.layers[1].lines.offset, 3);
});

test('share code rejects invalid input', () => {
  assert.throws(() => core.decodeShareCode(''), /must start/);
  assert.throws(() => core.decodeShareCode('CZ2-!!'), /invalid characters/);
  assert.throws(() => core.decodeShareCode('CZ2-AAAA'), /corrupted/);
});

test('overlay size even, covers extent incl. firing + offsets + global scale', () => {
  for (const p of core.PRESETS) {
    for (const g of [0.5, 1, 2]) {
      const s = core.overlaySizePx(p.crosshair, g);
      assert.strictEqual(s % 2, 0);
      assert.ok(s / 2 >= core.crosshairExtent(p.crosshair, g));
    }
  }
  const base = core.sanitizeCrosshair({ layers: [{}] });
  const fired = core.sanitizeCrosshair({ layers: [{ firing: { enabled: true, spread: 30, kick: 20 } }] });
  const moved = core.sanitizeCrosshair({ layers: [{ offsetY: 100 }] });
  assert.ok(core.crosshairExtent(fired) > core.crosshairExtent(base));
  assert.ok(core.crosshairExtent(moved) >= 100);
});

test('fire animator ramps up and down per layer speed', () => {
  const ch = core.sanitizeCrosshair({ layers: [{ firing: { enabled: true, speed: 100 } }, {}] });
  const a = new core.FireAnimator();
  a.setFiring(true);
  assert.strictEqual(a.step(50, ch), true);
  assert.strictEqual(a.levels[0], 0.5);
  assert.strictEqual(a.levels[1], 0);
  a.step(60, ch);
  assert.strictEqual(a.levels[0], 1);
  a.setFiring(false);
  a.step(200, ch);
  assert.strictEqual(a.levels[0], 0);
});

test('game presets decode completely and native defaults match', () => {
  const { loadDefaultPack } = require('../src/shared/default-pack');
  const raw = require('../src/shared/default-pack.json');
  const pack = loadDefaultPack();
  assert.ok(pack.length > 0);
  assert.strictEqual(pack.length, raw.length, 'every entry must decode');
  assert.deepStrictEqual(require('../native/app/resources/first-preset.json').crosshair, pack[0].crosshair);
  const cats = new Set(pack.map((p) => p.category));
  for (const c of ['CS2 pros', 'Valorant pros', 'Fortnite pros', 'Rust creators']) assert.ok(cats.has(c), `missing ${c}`);
});

test('new arm shapes / layer kinds: sanitize, share, overlay size', () => {
  const ch = core.sanitizeCrosshair({ version: core.SCHEMA_VERSION, layers: [
    { lines: { shape: 'arc', count: 6, offset: 20 } },
    { lines: { shape: 'tShape', capLength: 30, capThickness: 4 } },
    { kind: 'form', form: { type: 'triangle', width: 40, height: 30 } },
    { kind: 'text', text: { value: 'HELLO', size: 30 } },
    { kind: 'text', text: { value: '' } },
  ] });
  assert.deepStrictEqual(ch.layers.map((l) => l.kind), ['shape', 'shape', 'form', 'text', 'text']);
  assert.deepStrictEqual([ch.layers[0].lines.shape, ch.layers[0].lines.count], ['arc', 6]);
  assert.strictEqual(ch.layers[4].text.value, '');
  assert.deepStrictEqual(core.decodeShareCode(core.encodeShareCode(ch)), ch);
  assert.ok(core.crosshairExtent({ layers: [ch.layers[2]] }) >= 25);
  assert.ok(core.crosshairExtent({ layers: [ch.layers[3]] }) >= 50);
  assert.ok(core.crosshairExtent({ layers: [ch.layers[1]] }) >= 15);
  assert.strictEqual(core.sanitizeLayer({ lines: { count: 12 } }).lines.count, 8);
});
