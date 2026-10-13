'use strict';

const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/shared/crosshair-core');
const { sanitizeConfig, defaultConfig, dedupeProfiles, fingerprint } = require('../src/main/store');

const plain = (o) => JSON.parse(JSON.stringify(o));

test('sanitize fills defaults from garbage', () => {
  assert.deepStrictEqual(core.sanitizeCrosshair(null), plain(core.DEFAULT_CROSSHAIR));
  assert.deepStrictEqual(core.sanitizeCrosshair({ layers: [] }), plain(core.DEFAULT_CROSSHAIR));
});

test('legacy flat crosshair becomes single layer', () => {
  const ch = core.sanitizeCrosshair({ color: '#ff0000', lines: { gap: 7 } });
  assert.strictEqual(ch.layers.length, 1);
  assert.strictEqual(ch.layers[0].color, '#ff0000');
  assert.strictEqual(ch.layers[0].lines.gap, 7);
});

test('sanitize clamps numbers, rejects bad colors/enums/images, caps layers', () => {
  const l = core.sanitizeLayer({
    opacity: 5, scale: -1, color: 'red', lines: { length: 1e9, thickness: 'abc', gap: 2.6 }, dot: { shape: 'star' },
    image: { src: 'javascript:alert(1)' }, offsetX: null,
  });
  assert.strictEqual(l.opacity, 1);
  assert.strictEqual(l.scale, 0.25);
  assert.strictEqual(l.color, core.DEFAULT_LAYER.color);
  assert.strictEqual(l.lines.length, 100);
  assert.strictEqual(l.lines.thickness, core.DEFAULT_LAYER.lines.thickness);
  assert.strictEqual(l.lines.gap, 3);
  assert.strictEqual(l.dot.shape, 'square');
  assert.strictEqual(l.image.src, '');
  assert.strictEqual(l.offsetX, 0);
  assert.strictEqual(core.sanitizeCrosshair({ layers: Array(20).fill({}) }).layers.length, core.MAX_LAYERS);
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

test('legacy CZ1 code still decodes', () => {
  const legacy = 'CZ1-' + Buffer.from(JSON.stringify({ color: '#123456' })).toString('base64url');
  assert.strictEqual(core.decodeShareCode(legacy).layers[0].color, '#123456');
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

test('config sanitize repairs broken config', () => {
  const cfg = sanitizeConfig({
    profiles: [{ id: 'a', name: '', hotkey: 5 }, { id: 'a' }, 5], activeProfileId: 'zzz',
    display: { offsetX: 1e9, scale: 99 }, toggle: { mode: 'x', profileId: 'nope' }, rightClick: { mode: 'hideHold', profileId: 'a' },
  });
  assert.strictEqual(cfg.profiles.length, 2);
  assert.notStrictEqual(cfg.profiles[0].id, cfg.profiles[1].id);
  assert.strictEqual(cfg.activeProfileId, cfg.profiles[0].id);
  assert.strictEqual(cfg.profiles[0].hotkey, '');
  assert.strictEqual(cfg.display.offsetX, 4000);
  assert.strictEqual(cfg.display.scale, 4);
  assert.deepStrictEqual(cfg.toggle, { mode: 'hide', profileId: null });
  assert.deepStrictEqual(cfg.rightClick, { mode: 'hideHold', profileId: 'a' });
  assert.ok(sanitizeConfig(null).profiles.length > 0);
  assert.strictEqual(defaultConfig().enabled, true);
});

test('v3 migration clears legacy optional hotkeys, keeps custom ones', () => {
  const cfg = sanitizeConfig({
    version: 2,
    hotkeys: { toggle: 'F8', next: 'CommandOrControl+Shift+Right', moveUp: 'F9', settings: 'CommandOrControl+Shift+S' },
  });
  assert.strictEqual(cfg.hotkeys.toggle, 'F8');
  assert.strictEqual(cfg.hotkeys.next, '');
  assert.strictEqual(cfg.hotkeys.settings, '');
  assert.strictEqual(cfg.hotkeys.moveUp, 'F9');
  assert.strictEqual(defaultConfig().hotkeys.next, '');
  // Once on v3, user may re-bind a legacy combo and it must stick.
  assert.strictEqual(sanitizeConfig({ version: 3, hotkeys: { next: 'CommandOrControl+Shift+Right' } }).hotkeys.next, 'CommandOrControl+Shift+Right');
});

test('dedupeProfiles keeps one per design, prefers active/hotkey, keeps order', () => {
  const red = core.sanitizeCrosshair({ layers: [{ color: '#ff0000' }] });
  const blue = core.sanitizeCrosshair({ layers: [{ color: '#0000ff' }] });
  const ps = [
    { id: 'a', name: 'Red', crosshair: red },
    { id: 'b', name: 'Blue', crosshair: blue },
    { id: 'c', name: 'Red copy', crosshair: red, hotkey: 'F1' },
    { id: 'd', name: 'Red again', crosshair: red },
    { id: 'e', name: 'Blue copy', crosshair: blue },
  ];
  assert.deepStrictEqual(dedupeProfiles(ps, 'e').map((p) => p.id), ['c', 'e']);
  assert.deepStrictEqual(dedupeProfiles(ps, 'zzz').map((p) => p.id), ['b', 'c']);
  assert.strictEqual(fingerprint({ layers: [{ color: '#FF0000' }] }), fingerprint(red));
});

test('starter pack decodes completely and new configs start from it', () => {
  const { loadDefaultPack } = require('../src/shared/default-pack');
  const raw = require('../src/shared/default-pack.json');
  const pack = loadDefaultPack();
  assert.ok(pack.length > 0);
  assert.strictEqual(pack.length, raw.length, 'every entry must decode');
  assert.deepStrictEqual(defaultConfig().profiles[0].crosshair, pack[0].crosshair);
});

test('toggle default is Alt+Shift+X; old untouched defaults migrate, custom keys stay', () => {
  assert.strictEqual(defaultConfig().hotkeys.toggle, 'Alt+Shift+X');
  assert.strictEqual(sanitizeConfig({ version: 3, hotkeys: { toggle: 'CommandOrControl+Shift+X' } }).hotkeys.toggle, 'Alt+Shift+X');
  assert.strictEqual(sanitizeConfig({ version: 4, hotkeys: { toggle: 'Alt+Shift+Z' } }).hotkeys.toggle, 'Alt+Shift+X');
  assert.strictEqual(sanitizeConfig({ version: 3, hotkeys: { toggle: 'Alt+Shift+Z' } }).hotkeys.toggle, 'Alt+Shift+Z');
  assert.strictEqual(sanitizeConfig({ version: 3, hotkeys: { toggle: 'F7' } }).hotkeys.toggle, 'F7');
  assert.strictEqual(sanitizeConfig({ version: 4, hotkeys: { toggle: 'CommandOrControl+Shift+X' } }).hotkeys.toggle, 'CommandOrControl+Shift+X');
  assert.strictEqual(sanitizeConfig({ version: 5, hotkeys: { toggle: 'Alt+Shift+Z' } }).hotkeys.toggle, 'Alt+Shift+Z');
});
