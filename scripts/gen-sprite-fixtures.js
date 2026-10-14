'use strict';

/*
 * Golden fixtures for the native compositor (native/app/tests/golden.rs).
 * Renders crosshairs in Chrome with the real crosshair-core.js twice: as per-layer sprites
 * (src/native/sprite-export.js) and as one whole reference image per firing level. The Rust test
 * composites the sprites and must reproduce the reference.
 *
 *   node scripts/gen-sprite-fixtures.js        (needs Google Chrome installed)
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const core = require('../src/shared/crosshair-core');
const { loadDefaultPack } = require('../src/shared/default-pack');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'native', 'app', 'tests', 'fixtures', 'golden');
const PAGE = path.join(ROOT, 'src', 'native', 'fixture-gen.html');
const PACK_SAMPLES = 12;
const PAGE_TIMEOUT_MS = 120000;
// 1×1 opaque red PNG
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** Layer kinds the presets do not cover (text, form, image, blur, firing + blur). */
function syntheticCases() {
  const layer = (o) => core.sanitizeLayer ? core.sanitizeLayer(o) : o;
  return [
    { name: 'synthetic text', crosshair: { version: 3, layers: [layer({ kind: 'text', text: { value: 'Z', size: 16 } })] } },
    { name: 'synthetic form circle', crosshair: { version: 3, layers: [layer({ kind: 'form', form: { type: 'circle' } })] } },
    {
      name: 'synthetic blur firing',
      crosshair: {
        version: 3,
        layers: [
          layer({ kind: 'shape', lines: { blur: 1.5, color: '#ff00aa' }, firing: { enabled: true, spread: 8, kick: 2, speed: 150 } }),
          layer({ kind: 'shape', lines: { enabled: false }, dot: { size: 4, color: '#ffffff' }, outline: { enabled: true } }),
        ],
      },
    },
    { name: 'synthetic image', crosshair: { version: 3, layers: [layer({ kind: 'image', image: { src: RED_PNG } })] } },
  ];
}

function cases() {
  const presets = core.PRESETS.map((p) => ({ name: `preset ${p.category}/${p.name}`, crosshair: p.crosshair }));
  const pack = loadDefaultPack().slice(0, PACK_SAMPLES).map((p) => ({ name: `pack ${p.name}`, crosshair: p.crosshair }));
  return [...presets, ...pack, ...syntheticCases()];
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.warn('[page]', m.text());
    });
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.goto(pathToFileURL(PAGE).href);
    const items = cases();
    const results = await page.evaluate((list) => window.czFixtures(list), items);

    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const index = results.map((r, i) => {
      const id = String(i).padStart(3, '0');
      fs.writeFileSync(path.join(OUT_DIR, `${id}.sprite`), Buffer.from(r.sprite, 'base64'));
      for (const [lv, b64] of Object.entries(r.refs)) {
        fs.writeFileSync(path.join(OUT_DIR, `${id}-${Math.round(Number(lv) * 100)}.bgra`), Buffer.from(b64, 'base64'));
      }
      return { id, name: r.name, size: r.size };
    });
    fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1) + '\n');
    const bytes = fs.readdirSync(OUT_DIR).reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);
    console.log(`wrote ${index.length} fixtures (${(bytes / 1024 / 1024).toFixed(2)} MB) to ${path.relative(ROOT, OUT_DIR)}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('fixture generation failed:', err);
  process.exit(1);
});
