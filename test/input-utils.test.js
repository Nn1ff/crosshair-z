'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CzInput = require('../src/renderer/input-utils');
const core = require('../src/shared/crosshair-core');

const k = (o) => CzInput.toAccelerator({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });

test('toAccelerator_layout_cases', () => {
  assert.equal(k({ key: 'z', code: 'KeyY' }), 'Z'); // German layout
  assert.equal(k({ key: 'ß', code: 'Minus' }), 'ß');
  assert.equal(k({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), 'CommandOrControl+Alt+Q'); // AltGr
  assert.equal(k({ key: '+', code: 'NumpadAdd' }), 'numadd');
  assert.equal(k({ key: 'j', code: 'KeyJ', metaKey: true }), 'Super+J');
  assert.equal(k({ key: '!', code: 'Digit1', shiftKey: true }), 'Shift+1');
  assert.equal(k({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), null);
});

test('toAccelerator: numpad, named keys, case and modifier order', () => {
  assert.equal(k({ key: '5', code: 'Numpad5' }), 'num5');
  assert.deepEqual([['-', 'NumpadSubtract'], ['*', 'NumpadMultiply'], ['/', 'NumpadDivide'], [',', 'NumpadDecimal']].map(([key, code]) => k({ key, code })),
    ['numsub', 'nummult', 'numdiv', 'numdec']);
  assert.equal(k({ key: 'я', code: 'KeyZ' }), 'Z', 'non-Latin letter → physical key');
  assert.equal(k({ key: 'ä', code: 'Quote' }), 'Ä', 'uppercase that stays one character');
  assert.equal(k({ key: 'F5', code: 'F5', altKey: true }), 'Alt+F5');
  assert.equal(k({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }), 'Shift+Up');
  assert.equal(k({ key: '+', code: 'Equal' }), 'Plus');
  assert.equal(k({ key: ' ', code: 'Space' }), 'Space');
  assert.equal(k({ key: 'PageDown', code: 'PageDown' }), 'PageDown');
  assert.equal(k({ key: 'x', code: 'KeyX', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }), 'CommandOrControl+Alt+Shift+Super+X');
  for (const key of ['Control', 'Alt', 'AltGraph', 'Meta']) assert.equal(k({ key, code: '' }), null, key);
  assert.equal(k({}), null, 'no key at all');
});

test('nextZoom and dragDelta', () => {
  assert.equal(CzInput.nextZoom(3, true), 4);
  assert.equal(CzInput.nextZoom(3, false), 2);
  assert.equal(CzInput.nextZoom(40, true), 40);
  assert.equal(CzInput.dragDelta(40, 10, 2), 2);
  assert.equal(CzInput.nextZoom(2, false), 2, 'clamped at the minimum');
  assert.equal(CzInput.nextZoom(16, true), 18, '×1.15 when that is more than one step');
  assert.equal(CzInput.nextZoom(16, false), 14);
  assert.equal(CzInput.nextZoom(10, true, 1, 12), 12, 'custom bounds');
  assert.equal(CzInput.dragDelta(40, 1, 2), 20, 'display scale 2 at zoom 1: 40 px → 20 px');
  assert.equal(CzInput.dragDelta(-7, 16, 1), 0, 'small moves round to zero (never -0)');
  assert.equal(CzInput.dragDelta(-9, 16, 1), -1);
  assert.equal(CzInput.dragDelta(10, 0, 1), 0, 'degenerate zoom');
});

test('settings page loads input utils before its users and caps the import field', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.html'), 'utf8');
  const at = (name) => html.indexOf(`<script src="${name}"></script>`);
  assert.ok(at('input-utils.js') > 0, 'input-utils.js is loaded');
  assert.ok(at('input-utils.js') < at('designer.js') && at('input-utils.js') < at('settings.js'), 'before designer.js and settings.js');
  // one more than the cap: an over-long paste still reaches decode ("share code too long")
  // instead of being cut to a valid-length but corrupted code
  assert.match(html, new RegExp(`<textarea id="importCode"[^>]*\\smaxlength="${core.MAX_SHARE_CODE_CHARS + 1}"`));
  assert.throws(() => core.decodeShareCode('CZ3-' + 'A'.repeat(core.MAX_SHARE_CODE_CHARS + 1 - 4)), /too long/, 'what the field can hold is reported as too long');
});
