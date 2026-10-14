'use strict';

/*
 * Writes the JS-defined defaults the native (Rust) runtime needs but cannot compute itself:
 *   native/app/resources/default-crosshair.json  core.sanitizeCrosshair(null)
 *   native/app/resources/first-preset.json       first shipped game preset {name, crosshair}
 * Run after changing crosshair-core.js or the default pack:  node scripts/export-native-defaults.js
 */

const fs = require('fs');
const path = require('path');
const core = require('../src/shared/crosshair-core');
const { loadDefaultPack } = require('../src/shared/default-pack');

const OUT_DIR = path.join(__dirname, '..', 'native', 'app', 'resources');

function writeJson(name, value) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  console.log('wrote', path.relative(process.cwd(), file));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeJson('default-crosshair.json', core.sanitizeCrosshair(null));
  const first = loadDefaultPack()[0] || { name: core.PRESETS[0].name, crosshair: core.PRESETS[0].crosshair };
  writeJson('first-preset.json', { name: first.name, crosshair: core.sanitizeCrosshair(first.crosshair) });
}

main();
