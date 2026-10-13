'use strict';

/**
 * Game crosshair presets shipped with the app (src/shared/default-pack.json, built by scripts/build-default-pack.js).
 * Entries are share codes (CZ3; older CZ2 still decode) grouped by category ("CS2 pros", …); invalid entries are skipped, never fatal.
 */
const core = require('./crosshair-core');

const FALLBACK_CATEGORY = 'Presets';
const MAX_NAME = 40;

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
      const category = typeof entry.category === 'string' && entry.category.trim() ? entry.category.trim().slice(0, MAX_NAME) : FALLBACK_CATEGORY;
      out.push({ name: String(entry.name || 'Crosshair').slice(0, MAX_NAME), category, crosshair: core.decodeShareCode(entry.code) });
    } catch (err) {
      console.warn('skipping invalid default pack entry:', entry && entry.name, err.message);
    }
  }
  return out;
}

module.exports = { loadDefaultPack };
