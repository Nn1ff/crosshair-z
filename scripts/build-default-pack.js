'use strict';

/*
 * Builds src/shared/default-pack.json from the author's saved Crosshair X crosshairs
 * (%APPDATA%\CrosshairX\crosshair-store). Workshop downloads are excluded.
 * Identical designs are kept once. Names are neutral descriptions ("White cross 2"),
 * original names are not shipped. Stored as compact CZ2 share codes.
 *
 * Usage: node scripts/build-default-pack.js [crosshairXDataDir]
 */
const fs = require('fs');
const path = require('path');
const core = require('../src/shared/crosshair-core');
const { scanCrosshairX } = require('../src/main/crosshairx-scan');
const { describe } = require('../src/shared/crosshairx-import');

const OUT = path.join(__dirname, '..', 'src', 'shared', 'default-pack.json');
const log = { info: () => {}, warn: (m, c) => console.warn(m, c) };

function main() {
  const dataDir = process.argv[2];
  const res = scanCrosshairX(log, dataDir || undefined);
  if (!res.exists) throw new Error(`Crosshair X data dir not found: ${res.dataDir}`);
  const seen = new Set();
  const pack = [];
  const nameCount = new Map();
  for (const it of res.items) {
    if (it.source !== 'Saved') continue;
    if (core.hasImageLayers(it.crosshair)) continue;
    const fp = JSON.stringify(it.crosshair);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const base = describe(it.crosshair);
    const n = (nameCount.get(base) || 0) + 1;
    nameCount.set(base, n);
    pack.push({ name: n === 1 ? base : `${base} ${n}`, code: core.encodeShareCode(it.crosshair) });
  }
  if (pack.length === 0) throw new Error('no crosshairs found to pack');
  fs.writeFileSync(OUT, JSON.stringify(pack, null, 1) + '\n', 'utf8');
  console.log(`wrote ${pack.length} crosshairs (from ${res.items.length} found, ${res.errors.length} unreadable) → ${OUT}`);
}

try {
  main();
} catch (err) {
  console.error('build-default-pack failed:', err.message);
  process.exit(1);
}
