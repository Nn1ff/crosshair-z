'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/native/sprite-format');

// Same vector is asserted in native/app/src/sprites/codec.rs (SHARED_VECTOR_HEX).
const SHARED_VECTOR_HEX =
  '435a53500100000004000000020000000000000000000000010000000100000001000000010000000100000001020304' +
  '010000000000f0420200000000000000000000000000000000000000020000000200000001000000010000000a141e28';

function sharedSet() {
  return {
    sizePx: 4,
    layers: [
      { fireSpeedMs: null, frames: [{ x: 1, y: 1, w: 1, h: 1, bgra: new Uint8Array([1, 2, 3, 4]) }] },
      {
        fireSpeedMs: 120,
        frames: [
          { x: 0, y: 0, w: 0, h: 0, bgra: new Uint8Array(0) },
          { x: 2, y: 2, w: 1, h: 1, bgra: new Uint8Array([10, 20, 30, 40]) },
        ],
      },
    ],
  };
}

test('encodes the shared vector', () => {
  assert.equal(Buffer.from(F.encodeSpriteSet(sharedSet())).toString('hex'), SHARED_VECTOR_HEX);
});

test('rejects frames whose pixel length does not match', () => {
  const set = sharedSet();
  set.layers[0].frames[0].bgra = new Uint8Array(3);
  assert.throws(() => F.encodeSpriteSet(set), /pixel length/);
});

test('premultiplies and swaps channels', () => {
  const out = F.rgbaToBgraPremul(new Uint8Array([255, 128, 0, 128, 10, 20, 30, 0, 200, 100, 50, 255]));
  assert.deepEqual(Array.from(out), [0, 64, 128, 128, 0, 0, 0, 0, 50, 100, 200, 255]);
});
