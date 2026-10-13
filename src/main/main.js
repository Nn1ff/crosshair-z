'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, clipboard, nativeImage, dialog, net, shell } = require('electron');
const core = require('../shared/crosshair-core');
const { createLogger } = require('./logger');
const { createMousePoller } = require('./mouse');
const { scanCrosshairX, convertFile } = require('./crosshairx-scan');
const { loadDefaultPack } = require('../shared/default-pack');
const { checkForUpdate, downloadUpdate, compareVersions, cleanupOldVersions } = require('./updater');
const { ConfigStore, cleanName, cleanAccel, newId, fingerprint, dedupeProfiles, DEFAULT_HOTKEYS, MAX_PROFILES } = require('./store');
const { readRunKey, staleEntryNames } = require('./autostart');

const TOPMOST_REASSERT_MS = 2000;
const UPDATE_CHECK_DELAY_MS = 5000; // after boot, so startup is never slowed by the network
const UPDATE_HANDOVER_TIMEOUT_MS = 30000; // new version should have taken over by then
const UPDATE_CLEANUP_DELAY_MS = 15000; // old version needs a moment to quit and release its exe
const MOVE_STEP_PX = 1;
const APP_USER_MODEL_ID = 'com.crosshairz.app'; // = build.appId; shortcut and process must match for taskbar grouping
const START_MENU_LINK_NAME = 'Crosshair Z.lnk';
const LOGIN_ITEM_NAME = APP_USER_MODEL_ID; // Run-key value name of our one autostart entry
const LEGACY_LOGIN_ITEM_NAMES = ['electron.app.Crosshair Z']; // Run-key names used by older builds
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'tray.png');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const CAPTURE_PAGES = ['library', 'saved', 'import', 'share', 'designer', 'hotkeys', 'toggle', 'position', 'settings', 'designer:light', 'designer:game', 'designer:dark'];

// Capture mode must not share profile/cache dirs with a running instance.
if (process.env.CZ_CAPTURE_DIR) app.setPath('userData', path.join(process.env.CZ_CAPTURE_DIR, 'userdata'));
// Dev aid: CZ_USERDATA=<dir> runs normally with an isolated config (for live tests).
else if (process.env.CZ_USERDATA) app.setPath('userData', process.env.CZ_USERDATA);

const log = createLogger(path.join(app.getPath('userData'), 'logs'), 'crosshair-z');

/** Runtime state of the app (single owner: this module). */
const state = {
  store: null,
  overlay: null,
  settings: null,
  tray: null,
  mouse: null,
  topmostTimer: null,
  hotkeyStatus: {},
  hotkeysSuspended: false,
  quitting: false,
  capture: false,
  kbAlt: false, // keyboard toggle active (hide or switch)
  rcAlt: false, // right-click alternate active (hide or switch)
  firing: false,
  launchHidden: false, // 'hide crosshair on launch' until first toggle
  /** status: idle | checking | none | available | downloading | launched | error */
  update: { status: 'idle', release: null, error: null },
};

// A closed stdout/stderr (EPIPE) is harmless for a tray app; logging it again could loop.
let epipeLogged = false;
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') {
    if (!epipeLogged) log.warn('console pipe closed, console output disabled');
    epipeLogged = true;
    return;
  }
  log.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err instanceof Error ? err : { err }));

// ---------- config helpers ----------

function cfg() {
  return state.store.get();
}

function profileById(id) {
  return cfg().profiles.find((p) => p.id === id) || null;
}

function activeProfile() {
  return profileById(cfg().activeProfileId) || cfg().profiles[0];
}

/** Visible flag + crosshair after applying keyboard / right-click alternates. */
function effective() {
  const c = cfg();
  let visible = c.enabled && !state.launchHidden;
  let profile = activeProfile();
  if (state.kbAlt) {
    if (c.toggle.mode === 'hide') visible = false;
    else profile = profileById(c.toggle.profileId) || profile;
  }
  if (state.rcAlt) {
    if (c.rightClick.mode.startsWith('hide')) visible = false;
    else profile = profileById(c.rightClick.profileId) || profile;
  }
  return { visible, profile };
}

/** Apply mutation to a config copy, persist, push to all windows. */
function mutate(fn) {
  const next = structuredClone(cfg());
  fn(next);
  state.store.set(next);
  broadcast();
  return cfg();
}

function broadcast() {
  layoutOverlay();
  refreshTray();
  updateMousePolling();
  sendTo(state.settings, 'config:changed', cfg());
}

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ---------- overlay ----------

function targetDisplay() {
  const id = cfg().display.monitorId;
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

function createOverlay() {
  const win = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('overlay renderer gone, recreating', details);
    recreateOverlay();
  });
  win.webContents.on('did-finish-load', () => layoutOverlay());
  win.loadFile(path.join(RENDERER_DIR, 'overlay.html')).catch((err) => log.error('overlay load failed', err));
  return win;
}

function recreateOverlay() {
  if (state.quitting) return;
  if (state.overlay && !state.overlay.isDestroyed()) state.overlay.destroy();
  state.overlay = createOverlay();
}

/** Size + position overlay so crosshair center = display center + offset (physical px). */
function layoutOverlay() {
  const win = state.overlay;
  if (!win || win.isDestroyed()) return;
  const c = cfg();
  const { visible, profile } = effective();
  const ch = profile.crosshair;
  const display = targetDisplay();
  const sf = display.scaleFactor || 1;
  const sizePx = core.overlaySizePx(ch, c.display.scale);
  const sizeDip = Math.ceil(sizePx / sf);
  const centerX = display.bounds.x + display.bounds.width / 2 + c.display.offsetX / sf;
  const centerY = display.bounds.y + display.bounds.height / 2 + c.display.offsetY / sf;
  try {
    win.setBounds({
      x: Math.round(centerX - sizeDip / 2),
      y: Math.round(centerY - sizeDip / 2),
      width: sizeDip,
      height: sizeDip,
    });
  } catch (err) {
    log.error('overlay setBounds failed', err);
  }
  // Visibility is applied inside the renderer; the window itself stays shown. Hiding/showing a
  // transparent native window raced with its repaint and z-order, so toggles sometimes did nothing.
  sendTo(win, 'overlay:render', { crosshair: ch, scale: c.display.scale, firing: state.firing, visible });
  if (state.capture) return;
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
}

/** Games grab z-order; reassert topmost periodically while visible. */
function startTopmostWatch() {
  state.topmostTimer = setInterval(() => {
    const win = state.overlay;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    } catch (err) {
      log.warn('topmost reassert failed', { error: err.message });
    }
  }, TOPMOST_REASSERT_MS);
}

// ---------- mouse (firing + right click) ----------

function needsMouse() {
  const c = cfg();
  if (c.rightClick.mode !== 'off') return true;
  const ids = [c.activeProfileId, c.toggle.profileId, c.rightClick.profileId];
  return ids.some((id) => {
    const p = profileById(id);
    return p && core.hasFiring(p.crosshair);
  });
}

function updateMousePolling() {
  if (!state.mouse || state.capture) return;
  if (needsMouse()) {
    state.mouse.start(onMouse);
  } else if (state.mouse.isRunning()) {
    state.mouse.stop();
    state.rcAlt = false;
    setFiring(false);
  }
}

function setFiring(on) {
  if (state.firing === on) return;
  state.firing = on;
  sendTo(state.overlay, 'overlay:fire', on);
}

function onMouse(now, prev) {
  if (now.left !== prev.left) setFiring(now.left);
  if (now.right === prev.right) return;
  const mode = cfg().rightClick.mode;
  if (mode === 'off') return;
  if (mode.endsWith('Hold')) state.rcAlt = now.right;
  else if (now.right) state.rcAlt = !state.rcAlt;
  else return;
  layoutOverlay();
}

// ---------- settings window ----------

/**
 * Show the settings window (create on demand).
 * @param {{front?: boolean}} [opts] front: force it above other windows (startup after a slow portable unpack,
 *   when Windows may otherwise open it behind whatever the user clicked meanwhile)
 */
function openSettings(opts = {}) {
  if (state.settings && !state.settings.isDestroyed()) {
    if (state.settings.isMinimized()) state.settings.restore();
    state.settings.show();
    state.settings.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    title: 'Crosshair Z',
    icon: ICON_PATH,
    backgroundColor: '#191c22',
    autoHideMenuBar: true,
    // Custom title bar: page draws brand + controls, OS draws min/max/close on the right.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#20242b', symbolColor: '#95a0ae', height: 40 },
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => {
    win.show();
    if (opts.front) {
      win.setAlwaysOnTop(true);
      win.focus();
      win.setAlwaysOnTop(false);
    }
  });
  // Destroy instead of hide: keeps the in-game footprint to the overlay only (~100 MB less).
  // The renderer flushes pending edits on beforeunload; the tray keeps the app alive.
  win.on('closed', () => {
    if (state.settings === win) state.settings = null;
    log.info('settings window closed');
  });
  win.webContents.on('render-process-gone', (_e, details) => log.error('settings renderer gone', details));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log.warn('settings console', { message, source: `${source}:${line}` });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(RENDERER_DIR, 'settings.html')).catch((err) => log.error('settings load failed', err));
  state.settings = win;
}

// ---------- tray ----------

function loadIcon(file, size) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) log.warn('icon missing', { file });
  return size && !img.isEmpty() ? img.resize({ width: size, height: size }) : img;
}

function createTray() {
  try {
    state.tray = new Tray(loadIcon(TRAY_ICON_PATH)); // tray.png + tray@2x.png picked by DPI
    state.tray.setToolTip('Crosshair Z');
    state.tray.on('click', () => openSettings());
    refreshTray();
  } catch (err) {
    log.error('tray creation failed', err);
  }
}

function refreshTray() {
  if (!state.tray) return;
  const c = cfg();
  const profileItems = c.profiles.slice(0, 30).map((p) => ({
    label: p.name,
    type: 'radio',
    checked: p.id === c.activeProfileId,
    click: () => equip(p.id),
  }));
  state.tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(state.update.status === 'available'
        ? [{ label: `Update to ${state.update.release.version}`, click: () => installUpdate() }, { type: 'separator' }]
        : []),
      { label: 'Show crosshair', type: 'checkbox', checked: c.enabled, click: () => { state.launchHidden = false; state.kbAlt = false; mutate((n) => (n.enabled = !n.enabled)); } },
      { label: 'Crosshairs', submenu: profileItems },
      { type: 'separator' },
      { label: 'Open Crosshair Z', click: () => openSettings() },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

// ---------- actions ----------

function equip(id) {
  state.kbAlt = false;
  state.launchHidden = false;
  mutate((n) => {
    n.activeProfileId = id;
    n.enabled = true;
  });
}

/**
 * Show/hide hotkey. In 'hide' mode it drives the same `enabled` flag as the app's switch, so
 * switching off in the app and on via hotkey (or vice versa) always works. When the crosshair is
 * off, any mode's hotkey turns it back on. 'switch' mode otherwise swaps to the alternate profile.
 */
function keyboardToggle() {
  const c = cfg();
  if (state.launchHidden) {
    state.launchHidden = false;
    if (!c.enabled) mutate((n) => (n.enabled = true));
  } else if (c.toggle.mode === 'hide' || !c.enabled) {
    state.kbAlt = false;
    mutate((n) => (n.enabled = !c.enabled));
  } else {
    state.kbAlt = !state.kbAlt;
  }
  log.info('keyboard toggle', { enabled: cfg().enabled, alt: state.kbAlt, mode: c.toggle.mode });
  layoutOverlay();
  sendTo(state.settings, 'runtime:changed', runtime());
}

function cycleProfile(dir) {
  const c = cfg();
  const i = c.profiles.findIndex((p) => p.id === c.activeProfileId);
  equip(c.profiles[(i + dir + c.profiles.length) % c.profiles.length].id);
}

function moveCrosshair(dx, dy) {
  mutate((n) => {
    n.display.offsetX += dx * MOVE_STEP_PX;
    n.display.offsetY += dy * MOVE_STEP_PX;
  });
}

function runtime() {
  const u = state.update;
  return {
    kbAlt: state.kbAlt,
    launchHidden: state.launchHidden,
    mouseAvailable: state.mouse ? state.mouse.available : null,
    update: { status: u.status, version: u.release ? u.release.version : null, error: u.error, current: app.getVersion() },
  };
}

// ---------- updates (optional; the app never depends on them) ----------

function setUpdate(patch) {
  state.update = { ...state.update, ...patch };
  sendTo(state.settings, 'runtime:changed', runtime());
  refreshTray();
}

async function runUpdateCheck() {
  if (state.capture || ['checking', 'downloading', 'launched'].includes(state.update.status)) return;
  setUpdate({ status: 'checking', error: null });
  try {
    const release = await checkForUpdate({ fetchFn: (url, opts) => net.fetch(url, opts), currentVersion: app.getVersion(), log });
    setUpdate({ status: release ? 'available' : 'none', release });
  } catch (err) {
    log.error('update check crashed', err);
    setUpdate({ status: 'error', error: err.message });
  }
}

/**
 * Download the new portable exe next to the running one and start it; the single-instance
 * handover then quits this version. Dev/unpacked builds just open the release page.
 */
async function installUpdate() {
  const { release } = state.update;
  if (!release || state.update.status === 'downloading') return;
  if (!process.env.PORTABLE_EXECUTABLE_FILE) {
    if (release.page) await shell.openExternal(release.page);
    return;
  }
  setUpdate({ status: 'downloading', error: null });
  try {
    const exe = await downloadUpdate({ fetchFn: (url, opts) => net.fetch(url, opts), release, dir: path.dirname(LAUNCH_EXE), log });
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      log.error('update launch failed', { exe, error: err.message });
      setUpdate({ status: 'error', error: `Could not start the new version: ${err.message}` });
    });
    child.unref();
    setUpdate({ status: 'launched' });
    log.info('update launched, waiting for handover', { exe });
    // normally the handover quits this process long before; if not, tell the user where the exe is
    setTimeout(() => {
      if (state.update.status !== 'launched') return;
      log.warn('update handover timed out', { exe });
      setUpdate({ status: 'error', error: `Version ${release.version} was saved as "${exe}" but did not take over. Close this window from the tray (Quit) and start it.` });
    }, UPDATE_HANDOVER_TIMEOUT_MS);
  } catch (err) {
    setUpdate({ status: 'error', error: `Download failed: ${err.message}` });
  }
}

const HOTKEY_ACTIONS = {
  toggle: () => keyboardToggle(),
  next: () => cycleProfile(1),
  prev: () => cycleProfile(-1),
  settings: () => openSettings(),
  moveUp: () => moveCrosshair(0, -1),
  moveDown: () => moveCrosshair(0, 1),
  moveLeft: () => moveCrosshair(-1, 0),
  moveRight: () => moveCrosshair(1, 0),
};

/** Register one accelerator; returns status string. */
function tryRegister(accel, fn, used) {
  if (!accel) return 'empty';
  if (used.has(accel)) return 'duplicate';
  try {
    const ok = globalShortcut.register(accel, fn);
    if (ok) used.add(accel);
    return ok ? 'ok' : 'taken';
  } catch (err) {
    log.warn('hotkey invalid', { accel, error: err.message });
    return 'invalid';
  }
}

/** (Re)register global + per-crosshair hotkeys. Status keys: action names and `profile:<id>`. */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  if (state.hotkeysSuspended) return state.hotkeyStatus;
  const status = {};
  const used = new Set();
  for (const [action, accel] of Object.entries(cfg().hotkeys)) status[action] = tryRegister(accel, HOTKEY_ACTIONS[action], used);
  for (const p of cfg().profiles) {
    if (p.hotkey) status[`profile:${p.id}`] = tryRegister(p.hotkey, () => equip(p.id), used);
  }
  state.hotkeyStatus = status;
  log.info('hotkeys registered', { count: used.size });
  sendTo(state.settings, 'hotkeys:status', status);
  return status;
}

/**
 * Exactly one autostart entry may exist. Any other Run-key value that starts a Crosshair Z exe
 * (older builds used other value names; other copies of the exe) is deleted. Never throws.
 */
async function removeStaleLoginItems() {
  if (process.platform !== 'win32') return;
  const names = new Set(LEGACY_LOGIN_ITEM_NAMES);
  for (const n of staleEntryNames(await readRunKey(log), LOGIN_ITEM_NAME)) names.add(n);
  names.delete(LOGIN_ITEM_NAME);
  for (const name of names) {
    try {
      app.setLoginItemSettings({ openAtLogin: false, name });
      log.info('removed stale autostart entry', { name });
    } catch (err) {
      log.warn('removing stale autostart entry failed', { name, error: err.message });
    }
  }
}

/**
 * Register/unregister autostart. The portable build runs from a temp extraction dir that is
 * wiped on exit, so the login item must point at the original portable exe instead.
 */
function applyLoginItem() {
  // Dev runs (`electron .`) share the entry name; they would point autostart at electron.exe.
  if (!app.isPackaged) {
    log.info('login item untouched (not a packaged build)');
    return;
  }
  const path = LAUNCH_EXE;
  const openAtLogin = cfg().launchAtLogin;
  removeStaleLoginItems().catch((err) => log.warn('autostart cleanup failed', { error: err.message }));
  try {
    app.setLoginItemSettings({ openAtLogin, path, args: ['--hidden'], name: LOGIN_ITEM_NAME });
    const now = app.getLoginItemSettings({ path, args: ['--hidden'], name: LOGIN_ITEM_NAME });
    log.info('login item applied', { openAtLogin, path, registered: now.openAtLogin, willLaunch: now.executableWillLaunchAtLogin });
  } catch (err) {
    log.error('setLoginItemSettings failed', { error: err.message, path });
  }
}

/**
 * Portable builds are not installed, so Windows search does not know them. Keep a per-user
 * Start Menu shortcut pointing at the launched portable exe (re-pointed after an update or move).
 */
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !process.env.PORTABLE_EXECUTABLE_FILE) return;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', START_MENU_LINK_NAME);
  try {
    let current = null;
    try {
      current = shell.readShortcutLink(link).target;
    } catch {
      // missing or unreadable link → (re)create below
    }
    if (current && path.resolve(current).toLowerCase() === path.resolve(LAUNCH_EXE).toLowerCase()) return;
    const ok = shell.writeShortcutLink(link, current ? 'replace' : 'create', {
      target: LAUNCH_EXE,
      cwd: path.dirname(LAUNCH_EXE),
      icon: LAUNCH_EXE,
      iconIndex: 0,
      description: 'Crosshair overlay for Windows games',
      appUserModelId: APP_USER_MODEL_ID,
    });
    if (ok) log.info('start menu shortcut written', { link, target: LAUNCH_EXE, previous: current });
    else log.warn('start menu shortcut not written', { link, target: LAUNCH_EXE });
  } catch (err) {
    log.error('start menu shortcut failed', { link, error: err.message });
  }
}

// ---------- IPC ----------

function requireString(v, name) {
  if (typeof v !== 'string' || !v) throw new Error(`${name} must be non-empty string`);
  return v;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, payload) => {
    try {
      return await fn(payload);
    } catch (err) {
      log.error(`ipc ${channel} failed`, { error: err.message });
      throw err;
    }
  });
}

const PATCH_FLAGS = ['enabled', 'launchAtLogin', 'startHidden', 'hideOnLaunch', 'checkUpdates'];

function applyPatch(n, p) {
  if (p.display && typeof p.display === 'object') Object.assign(n.display, p.display);
  if (p.toggle && typeof p.toggle === 'object') Object.assign(n.toggle, p.toggle);
  if (p.rightClick && typeof p.rightClick === 'object') Object.assign(n.rightClick, p.rightClick);
  for (const k of PATCH_FLAGS) if (typeof p[k] === 'boolean') n[k] = p[k];
}

function registerProfileIpc() {
  handle('profile:update', (p) => {
    const id = requireString(p && p.id, 'id');
    const out = mutate((n) => {
      const prof = n.profiles.find((x) => x.id === id);
      if (!prof) throw new Error(`profile ${id} not found`);
      if (p.crosshair) prof.crosshair = core.sanitizeCrosshair(p.crosshair);
      if (p.name !== undefined) prof.name = cleanName(p.name, prof.name);
      if (p.hotkey !== undefined) prof.hotkey = cleanAccel(p.hotkey);
    });
    if (p.hotkey !== undefined) registerHotkeys();
    return out;
  });

  handle('profile:create', (p) => {
    const activate = !p || p.activate !== false;
    // dedupe: an identical crosshair already saved → reuse it instead of adding a copy.
    if (p && p.dedupe) {
      const fp = fingerprint(p.crosshair);
      const existing = cfg().profiles.find((x) => fingerprint(x.crosshair) === fp);
      if (existing) {
        if (activate) equip(existing.id);
        return { id: existing.id, config: cfg(), existed: true };
      }
    }
    if (cfg().profiles.length >= MAX_PROFILES) throw new Error(`max ${MAX_PROFILES} crosshairs`);
    const id = newId();
    mutate((n) => {
      n.profiles.push({ id, name: cleanName(p && p.name, 'New Crosshair'), hotkey: '', crosshair: core.sanitizeCrosshair(p && p.crosshair) });
      if (!p || p.activate !== false) {
        n.activeProfileId = id;
        n.enabled = true;
      }
    });
    if (!p || p.activate !== false) state.kbAlt = false;
    return { id, config: cfg() };
  });

  handle('profile:delete', (id) => {
    requireString(id, 'id');
    if (cfg().profiles.length <= 1) throw new Error('cannot delete last crosshair');
    const out = mutate((n) => {
      n.profiles = n.profiles.filter((x) => x.id !== id);
      if (n.activeProfileId === id) n.activeProfileId = n.profiles[0].id;
    });
    registerHotkeys();
    return out;
  });

  handle('profile:importMany', (list) => {
    if (!Array.isArray(list) || list.length === 0) throw new Error('nothing to import');
    // Skip crosshairs already saved (and duplicates within the list itself).
    const seen = new Set(cfg().profiles.map((x) => fingerprint(x.crosshair)));
    const fresh = list.filter((it) => {
      const fp = fingerprint(it && it.crosshair);
      if (seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });
    const duplicates = list.length - fresh.length;
    const free = MAX_PROFILES - cfg().profiles.length;
    const items = fresh.slice(0, Math.max(0, free));
    const overLimit = fresh.length - items.length;
    if (items.length === 0) return { config: cfg(), imported: 0, duplicates, overLimit };
    const ids = items.map(() => newId());
    const out = mutate((n) => {
      items.forEach((it, i) => {
        n.profiles.push({ id: ids[i], name: cleanName(it && it.name, 'Imported'), hotkey: '', crosshair: core.sanitizeCrosshair(it && it.crosshair) });
      });
      n.activeProfileId = ids[ids.length - 1];
      n.enabled = true;
    });
    log.info('imported crosshairs', { count: items.length, duplicates, overLimit });
    return { config: out, imported: items.length, duplicates, overLimit };
  });

  handle('profile:dedupe', () => {
    const c = cfg();
    const keepIds = new Set(dedupeProfiles(c.profiles, c.activeProfileId).map((p) => p.id));
    const removed = c.profiles.length - keepIds.size;
    if (removed === 0) return { config: c, removed: 0 };
    const out = mutate((n) => {
      n.profiles = n.profiles.filter((p) => keepIds.has(p.id));
    });
    registerHotkeys();
    log.info('removed duplicate crosshairs', { removed });
    return { config: out, removed };
  });

  handle('profile:activate', (id) => {
    equip(requireString(id, 'id'));
    return cfg();
  });

  handle('profile:move', (p) => {
    const id = requireString(p && p.id, 'id');
    return mutate((n) => {
      const i = n.profiles.findIndex((x) => x.id === id);
      const j = i + (p.dir > 0 ? 1 : -1);
      if (i < 0 || j < 0 || j >= n.profiles.length) return;
      [n.profiles[i], n.profiles[j]] = [n.profiles[j], n.profiles[i]];
    });
  });
}

function registerIpc() {
  const pack = loadDefaultPack();
  log.info('game presets loaded', { count: pack.length });
  handle('config:get', () => ({ config: cfg(), hotkeyStatus: state.hotkeyStatus, presets: pack, runtime: runtime(), defaults: DEFAULT_HOTKEYS }));

  handle('config:patch', (p) => {
    if (!p || typeof p !== 'object') throw new Error('patch must be object');
    // switching on in the app must win over launch-hidden / hotkey-hidden state
    if (p.enabled === true) {
      state.launchHidden = false;
      if (cfg().toggle.mode === 'hide') state.kbAlt = false;
    }
    const out = mutate((n) => applyPatch(n, p));
    if (typeof p.launchAtLogin === 'boolean') applyLoginItem();
    if (p.checkUpdates === true && ['idle', 'error'].includes(state.update.status)) runUpdateCheck();
    if (p.toggle || p.rightClick) {
      state.kbAlt = false;
      state.rcAlt = false;
      layoutOverlay();
    }
    return out;
  });

  registerProfileIpc();

  handle('displays:list', () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: `Display ${i + 1}${d.id === primary ? ' (primary)' : ''} — ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)} @ ${Math.round(d.scaleFactor * 100)}%`,
    }));
  });

  handle('hotkeys:set', (p) => {
    if (!p || typeof p !== 'object') throw new Error('hotkeys must be object');
    mutate((n) => {
      for (const k of Object.keys(n.hotkeys)) if (typeof p[k] === 'string') n.hotkeys[k] = p[k];
    });
    return registerHotkeys();
  });

  handle('hotkeys:suspend', (on) => {
    state.hotkeysSuspended = on === true;
    if (state.hotkeysSuspended) globalShortcut.unregisterAll();
    else registerHotkeys();
    return state.hotkeysSuspended;
  });

  handle('cx:scan', () => scanCrosshairX(log));

  handle('cx:openFile', async () => {
    const res = await dialog.showOpenDialog(state.settings, {
      title: 'Import Crosshair X crosshair',
      filters: [{ name: 'Crosshair X crosshair', extensions: ['json'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return { items: [], errors: [] };
    const items = [];
    const errors = [];
    for (const file of res.filePaths.slice(0, 100)) {
      try {
        items.push({ id: file, source: 'File', ...convertFile(file) });
      } catch (err) {
        errors.push({ file: path.basename(file), error: err.message });
      }
    }
    return { items, errors };
  });

  handle('clipboard:write', (text) => clipboard.writeText(String(text).slice(0, 10000)));
  handle('clipboard:read', () => clipboard.readText().slice(0, 10000));
  handle('log:path', () => log.file);
  handle('update:check', () => runUpdateCheck());
  handle('update:install', () => installUpdate());
}

// ---------- lifecycle ----------

function onDisplaysChanged() {
  log.info('displays changed', { count: screen.getAllDisplays().length });
  layoutOverlay();
}

/** Dev aid: CZ_CAPTURE_DIR=<dir> renders windows hidden, saves PNG per page, quits. */
async function captureAndQuit(dir) {
  const fs = require('fs');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    fs.mkdirSync(dir, { recursive: true });
    await wait(2500);
    // hidden windows freeze CSS animations at their first frame; capture the settled state
    await state.settings.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }');
    const shots = [['overlay', state.overlay, null], ...CAPTURE_PAGES.map((p) => [p, state.settings, p])];
    for (const [name, win, page] of shots) {
      if (page) {
        await win.webContents.executeJavaScript(`window.czShowPage(${JSON.stringify(page)})`);
        await wait(300);
      }
      const img = await win.webContents.capturePage(undefined, { stayHidden: true });
      fs.writeFileSync(path.join(dir, `${name.replace(':', '-')}.png`), img.toPNG());
      log.info('captured', { name, size: img.getSize() });
    }
    // smallest allowed window: check that layouts still fit
    const [minW, minH] = state.settings.getMinimumSize();
    state.settings.setSize(minW, minH);
    await wait(400);
    for (const page of ['designer', 'library', 'saved']) {
      await state.settings.webContents.executeJavaScript(`window.czShowPage(${JSON.stringify(page)})`);
      await wait(300);
      const img = await state.settings.webContents.capturePage(undefined, { stayHidden: true });
      fs.writeFileSync(path.join(dir, `${page}-min.png`), img.toPNG());
    }
  } catch (err) {
    log.error('capture failed', err);
  }
  app.quit();
}

function bootCapture(dir) {
  state.store = new ConfigStore(path.join(dir, 'userdata'), log);
  registerIpc();
  state.capture = true;
  state.overlay = createOverlay();
  openSettings();
  state.settings.removeAllListeners('ready-to-show');
  captureAndQuit(dir);
}

function boot() {
  if (process.env.CZ_CAPTURE_DIR) return bootCapture(process.env.CZ_CAPTURE_DIR);
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
  state.store = new ConfigStore(app.getPath('userData'), log);
  state.mouse = createMousePoller(log);
  state.launchHidden = cfg().hideOnLaunch;
  registerIpc();
  state.overlay = createOverlay();
  createTray();
  registerHotkeys();
  applyLoginItem();
  ensureStartMenuShortcut();
  startTopmostWatch();
  updateMousePolling();
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
  // very first start always opens the window so new users can customize right away
  const firstRun = state.store.isNew;
  if (firstRun) state.store.flush(); // persist now so only the very first start counts as first
  const hidden = !firstRun && (process.argv.includes('--hidden') || cfg().startHidden);
  if (!hidden) openSettings({ front: true });
  log.info('boot complete', { version: app.getVersion(), hidden, firstRun });
  if (cfg().checkUpdates) setTimeout(runUpdateCheck, UPDATE_CHECK_DELAY_MS);
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    // in-app updates save each version next to the old one; drop the outdated copies
    setTimeout(() => {
      cleanupOldVersions({ dir: path.dirname(LAUNCH_EXE), currentVersion: app.getVersion(), currentExe: LAUNCH_EXE, log })
        .catch((err) => log.error('update cleanup failed', { error: err.message }));
    }, UPDATE_CLEANUP_DELAY_MS);
  }
}


/** Launched exe path (portable builds run from a temp copy; env var holds the real file). */
const LAUNCH_EXE = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

/**
 * Another instance was started. If it is a newer version, hand over: quit and relaunch that exe.
 * Otherwise just show our window.
 */
function onSecondInstance(_e, _argv, _cwd, data) {
  const incoming = data && typeof data.version === 'string' ? data.version : null;
  const exe = data && typeof data.exe === 'string' ? data.exe : null;
  if (incoming && exe && compareVersions(incoming, app.getVersion()) > 0) {
    log.info('newer version launched, handing over', { from: app.getVersion(), to: incoming, exe });
    app.relaunch({ execPath: exe, args: [] });
    app.quit();
    return;
  }
  openSettings();
}

const isolated = process.env.CZ_CAPTURE_DIR || process.env.CZ_USERDATA;
if (!isolated && !app.requestSingleInstanceLock({ version: app.getVersion(), exe: LAUNCH_EXE })) {
  app.quit();
} else {
  app.on('second-instance', onSecondInstance);
  app.whenReady().then(boot).catch((err) => {
    log.error('boot failed', err);
    app.exit(1);
  });
  // Tray app: keep running when all windows closed.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    state.quitting = true;
    clearInterval(state.topmostTimer);
    if (state.mouse) state.mouse.stop();
    if (state.store) state.store.flush();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
