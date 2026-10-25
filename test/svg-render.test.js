'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const C = require('../src/shared/crosshair-core');
const { convertCrosshairX } = require('../src/shared/crosshairx-import');
const raw = require('./fixtures/dom-fortnite.json');

test('DOM Fortnite retains fractional geometry and local SVG outline units through sharing', () => {
  const ch = convertCrosshairX(raw, 'DOM').crosshair;
  assert.equal(ch.layers[0].renderer, 'svg');
  assert.equal(ch.layers[0].lines.length, 2.5);
  assert.equal(ch.layers[0].outline.thickness, 1);
  assert.equal(ch.layers[0].outline.blur, 1);
  assert.deepEqual(C.decodeShareCode(C.encodeShareCode(ch)), ch);
});

test('DOM Fortnite SVG matches original geometry at overlay size and designer zoom', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/native/fixture-gen.html')).href);
    const result = await page.evaluate(async ({ ch, reference }) => {
      const out = [];
      for (const resolution of [1, 2, 8, 16]) {
        await CrosshairCore.prepareCrosshair(ch, { resolution });
        const size = 128 * resolution;
        const canvas = new OffscreenCanvas(size, size), ctx = canvas.getContext('2d');
        CrosshairCore.drawCrosshair(ctx, ch, 64, 64, { resolution });
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(reference.replace('width="128" height="128"', `width="${size}" height="${size}"`));
        await img.decode();
        const expected = new OffscreenCanvas(size, size).getContext('2d');
        expected.drawImage(img, 0, 0);
        const a = ctx.getImageData(0, 0, size, size).data;
        const b = expected.getImageData(0, 0, size, size).data;
        let maxDelta = 0;
        for (let i = 0; i < a.length; i += 4) {
          for (let k = 0; k < 4; k++) {
            const av = k === 3 ? a[i+3] : Math.round(a[i+k] * a[i+3] / 255);
            const bv = k === 3 ? b[i+3] : Math.round(b[i+k] * b[i+3] / 255);
            maxDelta = Math.max(maxDelta, Math.abs(av-bv));
          }
        }
        out.push({ resolution, maxDelta });
      }
      const sprite = await CzSpriteExport.buildSpriteSet(ch, 1);
      const view = new DataView(sprite.buffer, sprite.byteOffset, sprite.byteLength);
      const size = view.getUint32(8, true), x = view.getInt32(28, true), y = view.getInt32(32, true);
      const w = view.getUint32(36, true), h = view.getUint32(40, true);
      const expected = new OffscreenCanvas(size, size).getContext('2d');
      CrosshairCore.drawCrosshair(expected, ch, size/2, size/2);
      const pixels = CzSpriteFormat.rgbaToBgraPremul(expected.getImageData(0,0,size,size).data);
      let spriteDelta = 0;
      for (let row = 0; row < h; row++) for (let col = 0; col < w*4; col++) {
        spriteDelta = Math.max(spriteDelta, Math.abs(sprite[44+row*w*4+col] - pixels[((row+y)*size+x)*4+col]));
      }
      return { comparisons: out, spriteBytes: sprite.length, spriteDelta };
    }, { ch: convertCrosshairX(raw, 'DOM').crosshair, reference: fs.readFileSync(path.join(__dirname, 'fixtures/dom-fortnite.svg'), 'utf8') });
    // SVG filter tiling can differ by 1–3 premultiplied levels between image viewports.
    for (const r of result.comparisons) assert.ok(r.maxDelta <= 3, JSON.stringify(r));
    assert.ok(result.spriteBytes > 100, 'native exporter must wait for the SVG to decode');
    assert.equal(result.spriteDelta, 0, 'CPU sprite export and GPU preview use identical cached SVG pixels');
  } finally {
    await browser.close();
  }
});
