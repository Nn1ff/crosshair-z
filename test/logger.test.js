'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../src/main/logger');

test('broken console (EPIPE) does not throw and file logging continues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-log-'));
  const orig = console.log;
  let calls = 0;
  console.log = () => {
    calls++;
    const err = new Error('EPIPE: broken pipe, write');
    err.code = 'EPIPE';
    throw err;
  };
  try {
    const log = createLogger(dir, 't');
    assert.doesNotThrow(() => log.info('one'));
    assert.doesNotThrow(() => log.info('two'));
    assert.strictEqual(calls, 1); // console dropped after the first failure
    assert.match(fs.readFileSync(log.file, 'utf8'), /one[\s\S]*two/);
  } finally {
    console.log = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
