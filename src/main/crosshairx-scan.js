'use strict';

const fs = require('fs');
const path = require('path');
const { convertCrosshairX } = require('../shared/crosshairx-import');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 500;

/** Default Crosshair X data dir (Windows roaming app data). */
function defaultDataDir() {
  return path.join(process.env.APPDATA || '', 'CrosshairX');
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'manifest.json')
      .map((e) => path.join(dir, e.name));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
}

/**
 * Read + convert one Crosshair X crosshair file.
 * @returns {{name:string, crosshair:object, warnings:string[]}}
 */
function convertFile(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error('file too large');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  // No fallback name: unnamed crosshairs get a descriptive one ("Green cross").
  return convertCrosshairX(JSON.parse(text));
}

/**
 * Scan saved crosshairs + subscribed workshop crosshairs. Never throws; collects per-file errors.
 * @param {ReturnType<import('./logger').createLogger>} log
 * @param {string} [dataDir]
 */
function scanCrosshairX(log, dataDir = defaultDataDir()) {
  const sources = [{ label: 'Saved', files: listJson(path.join(dataDir, 'crosshair-store')) }];
  for (const mod of listDirs(path.join(dataDir, 'mods'))) {
    sources.push({ label: 'Workshop', files: listJson(path.join(mod, 'crosshairs')) });
  }
  const items = [];
  const errors = [];
  for (const src of sources) {
    for (const file of src.files) {
      if (items.length >= MAX_FILES) break;
      const rel = path.relative(dataDir, file);
      try {
        items.push({ id: rel, source: src.label, ...convertFile(file) });
      } catch (err) {
        errors.push({ file: rel, error: err.message });
        log.warn('crosshairx convert failed', { file: rel, error: err.message });
      }
    }
  }
  log.info('crosshairx scan', { dataDir, found: items.length, failed: errors.length });
  return { dataDir, exists: fs.existsSync(dataDir), items, errors };
}

module.exports = { scanCrosshairX, convertFile, defaultDataDir };
