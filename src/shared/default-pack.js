'use strict';

/**
 * Starter pack shipped with the app (src/shared/default-pack.json, built by scripts/build-default-pack.js).
 * Entries are CZ2 share codes; invalid entries are skipped, never fatal.
 */
const core = require('./crosshair-core');

const PACK_CATEGORY = 'Starter pack';

/** @returns {{name: string, category: string, crosshair: object}[]} */
function loadDefaultPack() {
  let raw;
  try {
    raw = require('./default-pack.json');
  } catch (err) {
    console.warn('default pack missing or unreadable:', err.message);
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    try {
      out.push({ name: String(entry.name || 'Crosshair').slice(0, 40), category: PACK_CATEGORY, crosshair: core.decodeShareCode(entry.code) });
    } catch (err) {
      console.warn('skipping invalid default pack entry:', entry && entry.name, err.message);
    }
  }
  return out;
}

module.exports = { loadDefaultPack, PACK_CATEGORY };
