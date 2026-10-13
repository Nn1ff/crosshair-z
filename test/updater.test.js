'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareVersions, parseRelease, checkForUpdate, downloadUpdate, ASSET_NAME } = require('../src/main/updater');

const silentLog = { info() {}, warn() {}, error() {} };

const release = (tag, size = 5) => ({
  tag_name: tag,
  html_url: 'https://github.com/Nn1ff/crosshair-z/releases/tag/' + tag,
  assets: [{ name: ASSET_NAME, size, browser_download_url: 'https://github.com/Nn1ff/crosshair-z/releases/download/' + tag + '/' + ASSET_NAME }],
});
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('compareVersions handles multi-digit parts', () => {
  assert.ok(compareVersions('1.7.10', '1.7.9') > 0);
  assert.ok(compareVersions('1.8.0', '1.7.11') > 0);
  assert.strictEqual(compareVersions('1.7.11', '1.7.11'), 0);
  assert.ok(compareVersions('1.7.2', '1.7.10') < 0);
});

test('parseRelease accepts a valid payload and rejects bad ones', () => {
  assert.deepStrictEqual(parseRelease(release('v1.7.12', 42)), {
    version: '1.7.12',
    url: 'https://github.com/Nn1ff/crosshair-z/releases/download/v1.7.12/Crosshair-Z.exe',
    size: 42,
    page: 'https://github.com/Nn1ff/crosshair-z/releases/tag/v1.7.12',
  });
  assert.strictEqual(parseRelease(null), null);
  assert.strictEqual(parseRelease({ ...release('v1.7.12'), prerelease: true }), null);
  assert.strictEqual(parseRelease(release('latest')), null);
  assert.strictEqual(parseRelease({ ...release('v1.7.12'), assets: [] }), null);
  const evil = release('v1.7.12');
  evil.assets[0].browser_download_url = 'https://evil.example/x.exe';
  assert.strictEqual(parseRelease(evil), null);
  assert.strictEqual(parseRelease(release('v1.7.12', 0)), null);
});

test('checkForUpdate returns newer release, null when same/older', async () => {
  const newer = await checkForUpdate({ fetchFn: async () => jsonRes(release('v1.7.12')), currentVersion: '1.7.11', log: silentLog });
  assert.strictEqual(newer.version, '1.7.12');
  assert.strictEqual(await checkForUpdate({ fetchFn: async () => jsonRes(release('v1.7.11')), currentVersion: '1.7.11', log: silentLog }), null);
  assert.strictEqual(await checkForUpdate({ fetchFn: async () => jsonRes(release('v1.7.10')), currentVersion: '1.7.11', log: silentLog }), null);
});

test('checkForUpdate never throws: offline retries then gives up, 403 does not retry', async () => {
  let calls = 0;
  const offline = async () => { calls++; throw new TypeError('fetch failed'); };
  assert.strictEqual(await checkForUpdate({ fetchFn: offline, currentVersion: '1.0.0', log: silentLog, retryBaseMs: 1 }), null);
  assert.strictEqual(calls, 3);
  calls = 0;
  const limited = async () => { calls++; return jsonRes({}, 403); };
  assert.strictEqual(await checkForUpdate({ fetchFn: limited, currentVersion: '1.0.0', log: silentLog, retryBaseMs: 1 }), null);
  assert.strictEqual(calls, 1);
  assert.strictEqual(await checkForUpdate({ fetchFn: async () => jsonRes({}, 404), currentVersion: '1.0.0', log: silentLog }), null);
});

test('downloadUpdate writes the file and rejects size mismatch without leftovers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-upd-'));
  try {
    const bodyRes = (text) => ({ ok: true, status: 200, body: new Blob([text]).stream() });
    const rel = parseRelease(release('v1.7.12', 5));
    const dest = await downloadUpdate({ fetchFn: async () => bodyRes('hello'), release: rel, dir, log: silentLog });
    assert.strictEqual(path.basename(dest), 'Crosshair Z 1.7.12.exe');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello');

    const bad = parseRelease(release('v1.7.13', 99));
    await assert.rejects(downloadUpdate({ fetchFn: async () => bodyRes('short'), release: bad, dir, log: silentLog }), /size mismatch/);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['Crosshair Z 1.7.12.exe']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupOldVersions removes only older versioned exes and stale .part files', async () => {
  const { cleanupOldVersions } = require('../src/main/updater');
  const fsp = require('fs').promises;
  const os = require('os');
  const pth = require('path');
  const dir = await fsp.mkdtemp(pth.join(os.tmpdir(), 'cz-clean-'));
  const files = ['Crosshair Z 1.7.18.exe', 'Crosshair Z 1.7.19.exe', 'Crosshair Z 1.7.20.exe', 'Crosshair Z 1.7.21.exe', 'Crosshair Z 1.7.21.exe.part', 'Crosshair-Z.exe', 'notes.txt'];
  for (const f of files) await fsp.writeFile(pth.join(dir, f), 'x');
  const quiet = { info() {}, warn() {}, error() {} };
  const removed = await cleanupOldVersions({ dir, currentVersion: '1.7.20', currentExe: pth.join(dir, 'Crosshair Z 1.7.20.exe'), log: quiet });
  assert.deepStrictEqual(removed.sort(), ['Crosshair Z 1.7.18.exe', 'Crosshair Z 1.7.19.exe', 'Crosshair Z 1.7.21.exe.part']);
  assert.deepStrictEqual((await fsp.readdir(dir)).sort(), ['Crosshair Z 1.7.20.exe', 'Crosshair Z 1.7.21.exe', 'Crosshair-Z.exe', 'notes.txt']);
  await fsp.mkdir(pth.join(dir, 'win-unpacked'));
  await fsp.writeFile(pth.join(dir, 'Crosshair Z 1.0.0.exe'), 'x');
  assert.deepStrictEqual(await cleanupOldVersions({ dir, currentVersion: '1.7.20', currentExe: 'x', log: quiet }), []);
  await fsp.rm(dir, { recursive: true, force: true });
});
