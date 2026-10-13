'use strict';

/*
 * Builds src/shared/default-pack.json from the local community backup of game crosshairs
 * (<games dir>/<game>/<list>.json, items[] = { name, pos?, crosshairId: Crosshair X model[] }).
 * Each game/list becomes one library category ("CS2 pros", "Rust creators", …). Only the lists in
 * LISTS are shipped; community lists are left out.
 * Designs with image layers or that fail to convert are skipped; exact repeats (same name
 * and design) within a category are kept once. Stored as compact CZ2 share codes.
 *
 * Usage: node scripts/build-default-pack.js [gamesDir]
 */
const fs = require('fs');
const path = require('path');
const core = require('../src/shared/crosshair-core');
const { convertCrosshairX } = require('../src/shared/crosshairx-import');

const OUT = path.join(__dirname, '..', 'src', 'shared', 'default-pack.json');
const DEFAULT_SRC = path.join(__dirname, '..', '..', 'crosshair y', 'community-backup', 'crosshairs', 'games');

/** Shipping order and display names; unknown games are appended after these. */
const GAMES = [['cs2', 'CS2'], ['valorant', 'Valorant'], ['fortnite', 'Fortnite'], ['rust', 'Rust']];
const LISTS = [['pros', 'pros'], ['creators', 'creators']];

function ordered(names, known) {
  const keys = known.map(([k]) => k);
  return [...names].sort((a, b) => {
    const ia = keys.includes(a) ? keys.indexOf(a) : keys.length;
    const ib = keys.includes(b) ? keys.indexOf(b) : keys.length;
    return ia - ib || a.localeCompare(b);
  });
}

function label(key, known) {
  const hit = known.find(([k]) => k === key);
  return hit ? hit[1] : key.charAt(0).toUpperCase() + key.slice(1);
}

/** @returns {{name: string, category: string, code: string}[]} */
function packList(file, category, stats) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.warn(`skipping unreadable ${file}: ${err.message}`);
    stats.unreadable++;
    return [];
  }
  const items = Array.isArray(data && data.items) ? data.items : [];
  const seen = new Set();
  const out = [];
  for (const it of items) {
    try {
      const { name, crosshair } = convertCrosshairX({ name: it.name, pos: it.pos, model: it.crosshairId });
      if (core.hasImageLayers(crosshair)) { stats.skipped++; continue; }
      const fp = name + JSON.stringify(crosshair);
      if (seen.has(fp)) { stats.duplicate++; continue; }
      seen.add(fp);
      out.push({ name, category, code: core.encodeShareCode(crosshair) });
    } catch (err) {
      console.warn(`skipping ${category} "${it && it.name}": ${err.message}`);
      stats.skipped++;
    }
  }
  return out;
}

function main() {
  const src = process.argv[2] || DEFAULT_SRC;
  if (!fs.existsSync(src)) throw new Error(`games dir not found: ${src}`);
  const stats = { unreadable: 0, skipped: 0, duplicate: 0 };
  const pack = [];
  const games = fs.readdirSync(src).filter((g) => fs.statSync(path.join(src, g)).isDirectory());
  for (const game of ordered(games, GAMES)) {
    const lists = fs.readdirSync(path.join(src, game)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
      .filter((l) => LISTS.some(([k]) => k === l));
    for (const list of ordered(lists, LISTS)) {
      const category = `${label(game, GAMES)} ${label(list, LISTS)}`;
      const entries = packList(path.join(src, game, `${list}.json`), category, stats);
      if (entries.length) console.log(`${category}: ${entries.length}`);
      pack.push(...entries);
    }
  }
  if (pack.length === 0) throw new Error('no crosshairs found to pack');
  fs.writeFileSync(OUT, JSON.stringify(pack, null, 1) + '\n', 'utf8');
  console.log(`wrote ${pack.length} crosshairs (${stats.skipped} skipped, ${stats.duplicate} duplicate, ${stats.unreadable} unreadable files) → ${OUT}`);
}

try {
  main();
} catch (err) {
  console.error('build-default-pack failed:', err.message);
  process.exit(1);
}
