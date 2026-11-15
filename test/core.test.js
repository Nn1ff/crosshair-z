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

test('share code length cap', () => {
  assert.throws(() => core.decodeShareCode('CZ3-' + 'A'.repeat(2000001)), /too long/);
  // a code of exactly the cap is still read (and rejected only for its content)
  assert.throws(() => core.decodeShareCode('CZ3-' + 'A'.repeat(core.MAX_SHARE_CODE_CHARS - 4)), /corrupted/);
});

test('oversized drawing source dropped on decode', () => {
  const png = (chars) => 'data:image/png;base64,' + 'A'.repeat(chars - 'data:image/png;base64,'.length);
  const ch = core.sanitizeCrosshair({ version: core.SCHEMA_VERSION, layers: [
    { kind: 'draw', draw: { src: png(40000) } },
    { kind: 'draw', draw: { src: png(core.MAX_DRAW_SRC_CHARS) } },
  ] });
  assert.strictEqual(ch.layers[0].draw.src.length, 40000, 'kept locally');
  const decoded = core.decodeShareCode(core.encodeShareCode(ch));
  assert.strictEqual(decoded.layers[0].kind, 'draw');
  assert.strictEqual(decoded.layers[0].draw.src, '');
  assert.strictEqual(decoded.layers[1].draw.src, ch.layers[1].draw.src, 'a source at the cap survives');
});

test('sanitizeCrosshair tolerates broken shapes', () => {
  const inputs = [
    { version: 3 },
    { layers: {} },
    { version: 3, layers: {} },
    { version: 3, layers: 'x' },
    { layers: [null, 'x'] },
    { version: 3, layers: [null, 'x', 7, []] },
    { layers: [{ kind: 'crosshair', outline: null, firing: null }] },
    { version: 3, layers: [{ outline: null, firing: null, lines: null, dot: null, form: null, text: null, draw: null, image: null }] },
  ];
  for (const input of inputs) {
    const ch = core.sanitizeCrosshair(input);
    assert.ok(ch.layers.length >= 1, JSON.stringify(input));
    assert.ok(core.overlaySizePx(ch) > 0, JSON.stringify(input));
  }
  const nulls = core.sanitizeCrosshair(inputs[7]).layers[0];
  assert.deepStrictEqual([nulls.outline, nulls.firing, nulls.lines], [plain(core.DEFAULT_LAYER.outline), plain(core.DEFAULT_LAYER.firing), plain(core.DEFAULT_LAYER.lines)]);
  assert.deepStrictEqual(core.sanitizeCrosshair(inputs[5]), plain(core.DEFAULT_CROSSHAIR), 'non-object layers dropped');
});

const CORE_PATH = require.resolve('../src/shared/crosshair-core');

/**
 * Minimal stand-ins for the browser image APIs (Node has no Image / OffscreenCanvas / animation
 * frames). Fake images load only when the test calls img.load(); frame callbacks run on demand.
 * Every call loads its own crosshair-core, so the image cache, listener, pins, miss count and
 * scratch canvases of one test never reach another.
 */
function withFakeBrowser(fn) {
  const names = ['OffscreenCanvas', 'Image', 'requestAnimationFrame'];
  const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
  const images = [];
  const frames = [];
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
  };
  globalThis.Image = class {
    constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; images.push(this); }
    load(w = 1, h = 1) { this.complete = true; this.naturalWidth = w; this.naturalHeight = h; this.onload(); }
  };
  globalThis.requestAnimationFrame = (cb) => frames.push(cb);
  const shared = require.cache[CORE_PATH];
  delete require.cache[CORE_PATH];
  try {
    return fn({ core: require(CORE_PATH), images, frames });
  } finally {
    if (shared) require.cache[CORE_PATH] = shared;
    else delete require.cache[CORE_PATH];
    names.forEach((n, i) => (saved[i] ? Object.defineProperty(globalThis, n, saved[i]) : delete globalThis[n]));
  }
}

test('image tests get their own core', () => {
  let first;
  withFakeBrowser(({ core: fresh }) => {
    first = fresh;
    fresh.primeImage('data:image/png;base64,own', { width: 1, height: 1 });
    assert.notStrictEqual(fresh, core, 'not the module the other tests share');
  });
  withFakeBrowser(({ core: fresh }) => {
    assert.notStrictEqual(fresh, first, 'a new module per test');
    assert.strictEqual(fresh.getImage('data:image/png;base64,own'), null, 'nothing cached by an earlier test');
  });
  assert.strictEqual(require(CORE_PATH), core, 'the shared module is restored afterwards');
});

test('image cache is LRU', () => withFakeBrowser(({ core }) => {
  assert.strictEqual(core.MAX_IMAGE_CACHE, 256);
  const src = (i) => `data:image/png;base64,lru${i}`;
  for (let i = 0; i < core.MAX_IMAGE_CACHE; i++) core.primeImage(src(i), { width: 1, height: 1 });
  assert.ok(core.getImage(src(0)), 'primed image is served (and touched)');
  core.primeImage(src(core.MAX_IMAGE_CACHE), { width: 1, height: 1 });
  assert.ok(core.getImage(src(0)), 'recently used image kept');
  assert.ok(core.getImage(src(core.MAX_IMAGE_CACHE)), 'newest image kept');
  assert.strictEqual(core.getImage(src(1)), null, 'least recently used image evicted');
}));

test('image cache keeps a pixel budget', () => withFakeBrowser(({ core }) => {
  assert.strictEqual(core.MAX_IMAGE_CACHE_PIXELS, 64 * 1024 * 1024);
  const src = (i) => `data:image/png;base64,px${i}`;
  const half = { width: 4096, height: core.MAX_IMAGE_CACHE_PIXELS / 4096 / 2 };
  core.primeImage(src(0), half);
  core.primeImage(src(1), half);
  core.primeImage(src(2), { width: 1, height: 1 });
  assert.ok(core.getImage(src(1)) && core.getImage(src(2)), 'newer images kept');
  assert.strictEqual(core.getImage(src(0)), null, 'oldest image evicted once the budget is exceeded');
  core.primeImage(src(3), { width: 10000, height: 10000 });
  assert.ok(core.getImage(src(3)), 'an image larger than the budget is still served');
  assert.strictEqual(core.getImage(src(1)), null, 'everything older made room for it');
}));

test('image loads notify once per frame, only for images still cached', () => withFakeBrowser(({ core, images, frames }) => {
  let calls = 0;
  core.onImageLoaded(() => calls++);
  const src = (i) => `data:image/png;base64,load${i}`;
  for (let i = 0; i < 3; i++) assert.strictEqual(core.getImage(src(i)), null, 'not decoded yet');
  images.forEach((img) => img.load());
  assert.deepStrictEqual([frames.length, calls], [1, 0], 'one frame for three loads');
  frames.shift()();
  assert.strictEqual(calls, 1);
  assert.ok(core.getImage(src(0)), 'decoded image served');
  core.getImage(src(9));
  const stale = images[images.length - 1];
  for (let i = 0; i < core.MAX_IMAGE_CACHE; i++) core.primeImage(`data:image/png;base64,fill${i}`, { width: 1, height: 1 });
  stale.load();
  assert.strictEqual(frames.length, 0, 'an image evicted before it loaded does not notify');
}));

test('a load listener that draws more images than the cache holds settles', () => withFakeBrowser(({ core, images, frames }) => {
  const srcs = Array.from({ length: core.MAX_IMAGE_CACHE + 44 }, (_, i) => `data:image/png;base64,scan${i}`);
  assert.ok(srcs.length > 256, 'more images than the cache holds');
  const drawAll = () => srcs.filter((s) => core.getImage(s)).length;
  let runs = 0;
  core.onImageLoaded(() => {
    runs++;
    drawAll();
  });
  drawAll();
  for (let frame = 0; frame < 20 && (frames.length || images.some((img) => !img.complete)); frame++) {
    images.filter((img) => !img.complete).forEach((img) => img.load());
    while (frames.length) frames.shift()();
  }
  assert.ok(runs <= 3, `listener ran ${runs} times (redraw loop)`);
  assert.strictEqual(drawAll(), srcs.length, 'every image drawn once the loads settle');
}));

test('image cache counts draws that wait for an image', () => withFakeBrowser(({ core, images }) => {
  const src = (name) => `data:image/png;base64,${name}`;
  assert.strictEqual(core.imageCacheMisses(), 0, 'a fresh core has missed nothing');
  assert.strictEqual(core.getImage(src('slow')), null);
  assert.strictEqual(core.imageCacheMisses(), 1, 'a request that starts decoding counts');
  assert.strictEqual(core.getImage(src('slow')), null);
  assert.strictEqual(core.imageCacheMisses(), 2, 'so does one while it still decodes');
  images[0].load();
  assert.ok(core.getImage(src('slow')));
  core.primeImage(src('primed'), { width: 1, height: 1 });
  assert.ok(core.getImage(src('primed')));
  assert.strictEqual(core.imageCacheMisses(), 2, 'decoded and primed images are hits');
  assert.strictEqual(core.getImage(src('broken')), null);
  images[1].complete = true; // decoding failed: no load event will ever follow
  assert.strictEqual(core.getImage(src('broken')), null);
  assert.strictEqual(core.imageCacheMisses(), 3, 'a failed image is not waited for');
  assert.strictEqual(core.getImage(''), null);
  assert.strictEqual(core.imageCacheMisses(), 3, 'no source: nothing to wait for');
}));

test('layerBounds estimates instead of throwing', () => withFakeBrowser(({ core }) => {
  const square = (side) => ({ x: -side / 2, y: -side / 2, w: side, h: side });
  const huge = core.sanitizeCrosshair({ version: core.SCHEMA_VERSION, layers: [{ kind: 'image', scale: 8, image: { size: 512 } }] });
  const side = core.overlaySizePx(huge, 4);
  assert.ok(side > core.MAX_BOUNDS_SIDE, 'too large to scan');
  assert.deepStrictEqual(core.layerBounds(huge, 0, { scale: 4 }), square(side));
  // a canvas whose pixel read fails (e.g. out of memory)
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      const canvas = this;
      const noop = () => {};
      return new Proxy({}, { get: (t, k) => (k === 'canvas' ? canvas : k === 'getImageData' ? () => { throw new RangeError('no memory'); } : k in t ? t[k] : noop) });
    }
  };
  const small = core.sanitizeCrosshair(null);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.deepStrictEqual(core.layerBounds(small, 0), square(core.overlaySizePx(small)));
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(warnings.length, 1, 'the fallback is logged');
  assert.strictEqual(core.layerBounds(small, 3), null, 'no such layer');
}));

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
