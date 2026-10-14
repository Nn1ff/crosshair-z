'use strict';

/*
 * End-to-end test of the native settings window: starts native/app's release exe with an isolated
 * data dir and WebView2 remote debugging, attaches with playwright-core over CDP and drives the
 * real settings page (window.cz → Rust → config.json).
 *
 *   node scripts/native-settings-e2e.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'native', 'app', 'target', 'release', 'crosshair-z.exe');
const PORT = 9333;
const START_TIMEOUT_MS = 20000;
const SHOT = path.join(os.tmpdir(), 'cz-native-settings.png');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(ok, what) {
  results.push({ ok: !!ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
}

async function connect() {
  const end = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch (err) {
      if (Date.now() > end) throw err;
      await wait(300);
    }
  }
}

async function settingsPage(browser) {
  const end = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    for (const ctx of browser.contexts()) {
      const p = ctx.pages().find((pg) => pg.url().includes('settings.html'));
      if (p) return p;
    }
    if (Date.now() > end) throw new Error('settings page not found');
    await wait(300);
  }
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-e2e-'));
  const preset = JSON.parse(fs.readFileSync(path.join(ROOT, 'native', 'app', 'resources', 'first-preset.json'), 'utf8'));
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ version: 5, enabled: true, activeProfileId: 'e2e', profiles: [{ id: 'e2e', name: 'E2E', hotkey: '', crosshair: preset.crosshair }], hotkeys: { toggle: 'Ctrl+Alt+Shift+F20' } }),
  );
  const env = { ...process.env, CZ_USERDATA: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
  const app = spawn(EXE, [], { env, stdio: 'ignore' });
  let browser;
  try {
    browser = await connect();
    const page = await settingsPage(browser);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForFunction(() => document.querySelector('#activeName') && document.querySelector('#activeName').textContent.length > 0, null, { timeout: 15000 });

    check((await page.textContent('#activeName')) === 'E2E', 'settings shows the active crosshair from config.json');
    check(await page.evaluate(() => typeof window.cz.invoke === 'function' && !!document.querySelector('.cz-wc .close')), 'bridge + window controls installed');

    const get = await page.evaluate(() => window.cz.invoke('config:get'));
    check(Array.isArray(get.presets) && get.presets.length > 100, `config:get decodes the preset pack (${get.presets && get.presets.length})`);
    check(get.hotkeyStatus && get.hotkeyStatus.toggle === 'ok', 'hotkey status reported');

    const created = await page.evaluate((ch) => window.cz.invoke('profile:create', { name: 'Second', crosshair: ch }), get.presets[1].crosshair);
    check(created.id && created.config.profiles.length === 2 && created.config.activeProfileId === created.id, 'profile:create adds and activates');
    const dup = await page.evaluate((ch) => window.cz.invoke('profile:create', { crosshair: ch, dedupe: true }), get.presets[1].crosshair);
    check(dup.existed === true && dup.id === created.id, 'profile:create dedupe finds the identical crosshair');

    await page.evaluate(() => window.cz.invoke('config:patch', { display: { offsetX: 7 } }));
    await wait(600);
    check(readConfig(data).display.offsetX === 7, 'config:patch persisted to config.json');

    const imported = await page.evaluate((list) => window.cz.invoke('profile:importMany', list), get.presets.slice(2, 5));
    check(imported.imported === 3 && imported.duplicates === 0, 'profile:importMany imports 3');
    const dd = await page.evaluate(() => window.cz.invoke('profile:dedupe'));
    check(dd.removed === 0, 'profile:dedupe finds nothing to remove');

    let rejected = '';
    try {
      await page.evaluate(() => window.cz.invoke('profile:update', { id: 'nope', name: 'x' }));
    } catch (err) {
      rejected = String(err.message);
    }
    check(rejected.includes('profile nope not found'), 'errors reach the page');

    const displays = await page.evaluate(() => window.cz.invoke('displays:list'));
    check(displays.length >= 1 && /Display 1/.test(displays[0].label), `displays:list (${displays[0] && displays[0].label})`);

    await page.evaluate(() => window.cz.invoke('clipboard:write', 'CZ-e2e-clip'));
    check((await page.evaluate(() => window.cz.invoke('clipboard:read'))) === 'CZ-e2e-clip', 'clipboard round trip');

    const changed = page.evaluate(() => new Promise((r) => window.cz.on('config:changed', (c) => r(c.enabled))));
    await page.evaluate(() => window.cz.invoke('config:patch', { enabled: false }));
    check((await Promise.race([changed, wait(3000).then(() => 'timeout')])) === false, 'config:changed event reaches the page');

    await page.screenshot({ path: SHOT });
    console.log('screenshot:', SHOT);
    check(errors.length === 0, `no page errors (${errors.join(' | ')})`);

    await page.evaluate(() => window.czRequestClose());
    await wait(1500);
    const stillOpen = browser.contexts().some((c) => c.pages().some((p) => p.url().includes('settings.html')));
    check(!stillOpen, 'close button destroys the settings window');
  } finally {
    if (browser) await browser.close().catch(() => {});
    app.kill();
    await wait(500);
    const log = path.join(data, 'logs', 'crosshair-z.log');
    if (fs.existsSync(log)) {
      // the one error this test provokes on purpose (unknown profile id) is expected
      const errs = fs.readFileSync(log, 'utf8').split('\n').filter((l) => / ERROR /.test(l) && !l.includes('profile nope not found'));
      check(errs.length === 0, `no ERROR lines in app log${errs.length ? ': ' + errs.slice(0, 3).join(' / ') : ''}`);
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `E2E FAILED: ${failed}` : 'E2E OK');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
