'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../src/renderer/sounds.js'), 'utf8');

function harness(storage = new Map()) {
  let time = 1000;
  const audio = [];
  const listeners = {};
  class Audio {
    constructor(src) { this.src = src; this.paused = true; this.plays = 0; audio.push(this); }
    pause() { this.paused = true; }
    play() { this.paused = false; this.plays++; return Promise.resolve(); }
  }
  const window = { addEventListener: (key, fn) => { listeners[key] = fn; } };
  const document = { hidden: false, addEventListener: () => {} };
  const context = vm.createContext({ window, document, Audio,
    performance: { now: () => time },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(script, context);
  return { sfx: window.CZSfx, audio, listeners, document, storage,
    advance: (ms = 120) => { time += ms; }, plays: () => audio.reduce((sum, a) => sum+a.plays, 0) };
}

test('sounds stay silent at startup, when muted, at zero volume and in the background', () => {
  const h = harness();
  assert.equal(h.audio.length, 0);
  h.sfx.setPreferences({ enabled: false });
  h.sfx.play('tab');
  assert.equal(h.plays(), 0);
  h.sfx.setPreferences({ enabled: true, volume: 0 });
  h.sfx.play('click');
  assert.equal(h.plays(), 0);
  h.sfx.setPreferences({ volume: .4 });
  h.document.hidden = true;
  h.sfx.play('on');
  assert.equal(h.plays(), 0);
});

test('sound preferences survive reopening and malformed storage uses safe defaults', () => {
  const h = harness();
  h.sfx.setPreferences({ volume: .17, enabled: false });
  const reopened = harness(h.storage);
  assert.equal(reopened.sfx.getPreferences().volume, .17);
  assert.equal(reopened.sfx.getPreferences().enabled, false);
  const invalid = harness(new Map([['cz.uiSounds', '{broken']]));
  assert.equal(invalid.sfx.getPreferences().volume, .35);
  assert.equal(invalid.sfx.getPreferences().enabled, true);
});

test('rapid slider movement is throttled and audio pools stay bounded', () => {
  const h = harness();
  for (let i = 0; i < 50; i++) { h.sfx.play(i % 2 ? 'high' : 'low'); h.advance(2); }
  assert.equal(h.plays(), 1);
  h.advance(120);
  h.sfx.play('high');
  assert.equal(h.plays(), 2);
  for (let i = 0; i < 100; i++) { h.advance(); h.sfx.play('tab'); }
  assert.equal(h.audio.filter(a => a.src.includes('tab-')).length, 8);
  for (const a of h.audio.filter(a => a.plays)) assert.equal(a.volume, .35);
});

test('muting and window blur stop active playback immediately', () => {
  const h = harness();
  h.sfx.play('on');
  assert.ok(h.audio.some(a => !a.paused));
  h.listeners.blur();
  assert.ok(h.audio.every(a => a.paused));
  h.advance();
  h.sfx.play('off');
  h.sfx.setPreferences({ enabled: false });
  assert.ok(h.audio.every(a => a.paused));
});

test('adapted samples are mono PCM, audible, balanced and below clipping', () => {
  const folder = path.join(__dirname, '../src/renderer/sounds');
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'sources.json'), 'utf8'));
  assert.equal(Object.keys(manifest).length, 10);
  for (const name of Object.keys(manifest)) {
    const wav = fs.readFileSync(path.join(folder, name+'.wav'));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.ok(wav.length > 1000);
    let peak = 0, energy = 0;
    const count = (wav.length - 44) / 2;
    for (let i = 44; i < wav.length; i += 2) {
      const value = wav.readInt16LE(i) / 32768;
      peak = Math.max(peak, Math.abs(value));
      energy += value * value;
    }
    assert.ok(peak < .301, name+' has headroom');
    assert.ok(Math.abs(Math.sqrt(energy/count) - .022) < .001, name+' matches the feedback level');
  }
});
