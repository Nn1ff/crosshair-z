'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../src/main/store');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('ConfigStore.isNew is true only on the very first start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-store-'));
  try {
    const first = new ConfigStore(dir, silentLog);
    assert.strictEqual(first.isNew, true);
    first.flush();
    const second = new ConfigStore(dir, silentLog);
    assert.strictEqual(second.isNew, false);
    assert.strictEqual(second.get().checkUpdates, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
