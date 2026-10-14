'use strict';

// Capture the real Rust/WebView2 settings UI with disposable, isolated sample data.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const root = path.join(__dirname, '..');
const images = path.join(root, 'docs', 'images');
const workspace = path.join(root, '.superpowers', 'screenshots');
const data = path.join(workspace, `data-${Date.now()}`);
const port = 9345;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(data, { recursive: true });
  const preset = JSON.parse(fs.readFileSync(path.join(root, 'native/app/resources/first-preset.json'), 'utf8'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    version: 5, enabled: false, checkUpdates: false, activeProfileId: 'sample',
    profiles: [{ id: 'sample', name: preset.name, hotkey: '', crosshair: preset.crosshair }],
    hotkeys: { toggle: 'Ctrl+Alt+Shift+F20' },
  }));
  const app = spawn(path.join(root, 'native/app/target/release/crosshair-z.exe'), [], {
    env: { ...process.env, CZ_USERDATA: data,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
    windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    const deadline = Date.now() + 30000;
    while (!browser && Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await wait(300); }
    }
    if (!browser) throw new Error('Native WebView2 debugging endpoint did not start');
    let page;
    while (!page && Date.now() < deadline) {
      page = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('settings.html'));
      if (!page) await wait(200);
    }
    if (!page) throw new Error('Native settings page not found');
    await page.waitForFunction(() => window.czShowPage && document.querySelector('#activeName')?.textContent);
    await page.evaluate(() => document.fonts.ready);
    for (const [name, view] of [['discover', 'discover'], ['designer', 'designer'], ['browse', 'library'], ['toggle', 'toggle']]) {
      await page.evaluate(view => window.czShowPage(view), view);
      await wait(800);
      await page.screenshot({ path: path.join(images, `${name}.png`) });
      console.log(`Captured ${name}: ${page.url()}`);
    }
    await page.evaluate(() => window.czRequestClose());
    await wait(600);
  } finally {
    if (browser) await browser.close().catch(() => {});
    app.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
