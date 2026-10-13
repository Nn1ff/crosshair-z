'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../shared/crosshair-core');
const { loadDefaultPack } = require('../shared/default-pack');

const CONFIG_VERSION = 5;
const SAVE_DEBOUNCE_MS = 300;
const MAX_PROFILES = 200;
const MAX_NAME_LEN = 40;
const MAX_OFFSET_PX = 4000;
const MAX_ACCEL_LEN = 64;
const TOGGLE_MODES = ['hide', 'switch'];
const RIGHT_CLICK_MODES = ['off', 'hideHold', 'hideToggle', 'switchHold', 'switchToggle'];

/** Only toggle is bound by default; the rest are optional (empty = not registered). */
const DEFAULT_HOTKEYS = Object.freeze({
  toggle: 'Alt+Shift+X',
  next: '',
  prev: '',
  settings: '',
  moveUp: '',
  moveDown: '',
  moveLeft: '',
  moveRight: '',
});

/** Toggle default before v4. */
const LEGACY_TOGGLE_DEFAULT = 'CommandOrControl+Shift+X';

/** Toggle default in v4. */
const V4_TOGGLE_DEFAULT = 'Alt+Shift+Z';

/** v1/v2 defaults for optional actions — cleared on migration to v3 unless user changed them. */
const LEGACY_DEFAULT_HOTKEYS = Object.freeze({
  next: 'CommandOrControl+Shift+Right',
  prev: 'CommandOrControl+Shift+Left',
  settings: 'CommandOrControl+Shift+S',
  moveUp: 'Alt+Shift+Up',
  moveDown: 'Alt+Shift+Down',
  moveLeft: 'Alt+Shift+Left',
  moveRight: 'Alt+Shift+Right',
});

function newId() {
  return crypto.randomUUID();
}

function cleanName(name, fallback) {
  const s = typeof name === 'string' ? name.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_NAME_LEN) : '';
  return s || fallback;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function clampInt(v, min, max, fallback) {
  return Math.round(clampNum(v, min, max, fallback));
}

function cleanAccel(v) {
  return typeof v === 'string' && v.length <= MAX_ACCEL_LEN ? v : '';
}

function obj(v) {
  return v && typeof v === 'object' ? v : {};
}

function defaultConfig() {
  // New users start with the first shipped game preset (fallback: built-in preset).
  const first = loadDefaultPack()[0] || core.PRESETS[0];
  const profiles = [{ id: newId(), name: first.name, hotkey: '', crosshair: first.crosshair }];
  return {
    version: CONFIG_VERSION,
    enabled: true,
    activeProfileId: profiles[0].id,
    profiles,
    display: { monitorId: null, offsetX: 0, offsetY: 0, scale: 1 },
    hotkeys: { ...DEFAULT_HOTKEYS },
    toggle: { mode: 'hide', profileId: null },
    rightClick: { mode: 'off', profileId: null },
    launchAtLogin: false,
    startHidden: false,
    hideOnLaunch: false,
    checkUpdates: true,
  };
}

/**
 * Validate full config. Never throws; repairs instead.
 * @param {unknown} raw
 * @returns {object}
 */
function sanitizeConfig(raw) {
  const def = defaultConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const profiles = (Array.isArray(src.profiles) ? src.profiles : [])
    .slice(0, MAX_PROFILES)
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => {
      let id = typeof p.id === 'string' && p.id.length <= 64 ? p.id : newId();
      if (seen.has(id)) id = newId();
      seen.add(id);
      return { id, name: cleanName(p.name, `Crosshair ${i + 1}`), hotkey: cleanAccel(p.hotkey), crosshair: core.sanitizeCrosshair(p.crosshair) };
    });
  if (profiles.length === 0) profiles.push(...def.profiles);

  const d = obj(src.display);
  const hk = obj(src.hotkeys);
  const version = Number(src.version) || 0;
  const hotkeys = {};
  for (const k of Object.keys(DEFAULT_HOTKEYS)) {
    let v = typeof hk[k] === 'string' && hk[k].length <= MAX_ACCEL_LEN ? hk[k] : DEFAULT_HOTKEYS[k];
    if (version < 3 && v === LEGACY_DEFAULT_HOTKEYS[k]) v = '';
    // Toggle default moved Ctrl+Shift+X (<v4) → Alt+Shift+Z (v4) → Alt+Shift+X (v5).
    // Only untouched defaults migrate; a key the user picked themselves stays.
    if (version < 4 && k === 'toggle' && v === LEGACY_TOGGLE_DEFAULT) v = DEFAULT_HOTKEYS.toggle;
    if (version === 4 && k === 'toggle' && v === V4_TOGGLE_DEFAULT) v = DEFAULT_HOTKEYS.toggle;
    hotkeys[k] = v;
  }
  const ids = new Set(profiles.map((p) => p.id));
  const refId = (v) => (typeof v === 'string' && ids.has(v) ? v : null);
  const tg = obj(src.toggle);
  const rc = obj(src.rightClick);

  return {
    version: CONFIG_VERSION,
    enabled: typeof src.enabled === 'boolean' ? src.enabled : true,
    activeProfileId: profiles.some((p) => p.id === src.activeProfileId) ? src.activeProfileId : profiles[0].id,
    profiles,
    display: {
      monitorId: Number.isInteger(d.monitorId) ? d.monitorId : null,
      offsetX: clampInt(d.offsetX, -MAX_OFFSET_PX, MAX_OFFSET_PX, 0),
      offsetY: clampInt(d.offsetY, -MAX_OFFSET_PX, MAX_OFFSET_PX, 0),
      scale: Math.round(clampNum(d.scale, 0.25, 4, 1) * 100) / 100,
    },
    hotkeys,
    toggle: { mode: TOGGLE_MODES.includes(tg.mode) ? tg.mode : 'hide', profileId: refId(tg.profileId) },
    rightClick: { mode: RIGHT_CLICK_MODES.includes(rc.mode) ? rc.mode : 'off', profileId: refId(rc.profileId) },
    launchAtLogin: src.launchAtLogin === true,
    startHidden: src.startHidden === true,
    hideOnLaunch: src.hideOnLaunch === true,
    // optional update check: on unless the user turned it off
    checkUpdates: src.checkUpdates !== false,
  };
}

/** Canonical identity of a crosshair design (ignores name). */
function fingerprint(crosshair) {
  return JSON.stringify(core.sanitizeCrosshair(crosshair));
}

/**
 * Remove profiles whose crosshair is identical to another one. Keeps the active profile and
 * profiles with a hotkey in preference, otherwise the first occurrence; original order preserved.
 * @returns {object[]} kept profiles
 */
function dedupeProfiles(profiles, activeId) {
  const rank = (p) => (p.id === activeId ? 2 : 0) + (p.hotkey ? 1 : 0);
  const keep = new Set();
  const seen = new Set();
  for (const p of [...profiles].sort((a, b) => rank(b) - rank(a))) {
    const fp = fingerprint(p.crosshair);
    if (seen.has(fp)) continue;
    seen.add(fp);
    keep.add(p.id);
  }
  return profiles.filter((p) => keep.has(p.id));
}

/**
 * JSON config store with atomic writes and corrupt-file recovery.
 */
class ConfigStore {
  /**
   * @param {string} dir userData dir
   * @param {ReturnType<import('./logger').createLogger>} log
   */
  constructor(dir, log) {
    this.file = path.join(dir, 'config.json');
    this.log = log;
    this.timer = null;
    /** true when no config file existed yet (very first start) */
    this.isNew = false;
    this.data = this.load();
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.isNew = true;
        this.log.info('config missing, using defaults', { file: this.file });
      } else {
        this.log.error('config read failed, using defaults', err);
      }
      return defaultConfig();
    }
    try {
      const cfg = sanitizeConfig(JSON.parse(text));
      this.log.info('config loaded', { profiles: cfg.profiles.length });
      return cfg;
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      this.log.error('config corrupt, backing up and resetting', { backup, error: err.message });
      try {
        fs.copyFileSync(this.file, backup);
      } catch (copyErr) {
        this.log.error('config backup failed', copyErr);
      }
      return defaultConfig();
    }
  }

  get() {
    return this.data;
  }

  /** Replace config (sanitized) and schedule save. */
  set(next) {
    this.data = sanitizeConfig(next);
    this.scheduleSave();
    return this.data;
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  /** Write synchronously via temp file + rename. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this.log.debug('config saved');
    } catch (err) {
      this.log.error('config save failed', { file: this.file, error: err.message });
    }
  }
}

module.exports = { ConfigStore, sanitizeConfig, fingerprint, dedupeProfiles, defaultConfig, cleanName, cleanAccel, newId, DEFAULT_HOTKEYS, MAX_PROFILES };
