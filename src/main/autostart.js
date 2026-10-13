'use strict';

/**
 * Finds Windows autostart (HKCU Run key) entries that start some Crosshair Z exe but are not the
 * app's own entry: values left by older builds (other value names) or by copies in other folders.
 * Only reads the registry; deleting is done by the caller through Electron.
 */
const { execFile } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_TIMEOUT_MS = 5000;
const CZ_EXE_RE = /crosshair[ _-]?z[^\\/"]*\.exe/i;
const VALUE_LINE_RE = /^\s{4}(.+?)\s{4}REG_(?:EXPAND_)?SZ\s{4}(.*)$/;

/**
 * Parse `reg query` output into {name, data} pairs.
 * @param {string} text
 * @returns {{name: string, data: string}[]}
 */
function parseRunKey(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = VALUE_LINE_RE.exec(line);
    if (m) out.push({ name: m[1], data: m[2] });
  }
  return out;
}

/**
 * Names of entries that launch a Crosshair Z exe but are not `ownName`.
 * @param {{name: string, data: string}[]} entries
 * @param {string} ownName value name the app registers itself under
 * @returns {string[]}
 */
function staleEntryNames(entries, ownName) {
  return entries.filter((e) => e.name !== ownName && CZ_EXE_RE.test(e.data)).map((e) => e.name);
}

/**
 * Read the Run key. Resolves [] on any failure (autostart cleanup must never break startup).
 * @param {{warn: Function}} log
 * @returns {Promise<{name: string, data: string}[]>}
 */
function readRunKey(log) {
  return new Promise((resolve) => {
    execFile('reg', ['query', RUN_KEY], { timeout: REG_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        log.warn('reading autostart entries failed', { error: err.message });
        resolve([]);
        return;
      }
      resolve(parseRunKey(stdout));
    });
  });
}

module.exports = { parseRunKey, staleEntryNames, readRunKey };
