/*
 * window.cz for the native (Tauri) host — same API as src/main/preload.js, so settings.js and
 * designer.js run unchanged. Injected as an initialization script, before any page script.
 *
 * Work that needs crosshair-core.js stays in JS: crosshairs are sanitized before they reach Rust,
 * the shipped preset pack and Crosshair X files are decoded here. Also draws the window controls
 * (the Electron build got them from the OS title bar overlay).
 */
(function () {
  'use strict';
  if (window.cz) return;

  const MAX_IMPORT_FILES = 100;
  const MAX_FILE_BYTES = 1024 * 1024;
  const PACK_FALLBACK_CATEGORY = 'Presets';
  const PACK_MAX_NAME = 40;
  const CLOSE_FLUSH_TIMEOUT_MS = 2000;

  const tauri = () => window.__TAURI__;
  const core = () => window.CrosshairCore;
  const inflight = new Set();

  function track(promise) {
    inflight.add(promise);
    const done = () => inflight.delete(promise);
    promise.then(done, done);
    return promise;
  }

  function raw(channel, payload) {
    return tauri().core.invoke('cz_invoke', { channel, payload: payload === undefined ? null : payload });
  }

  const clean = (ch) => core().sanitizeCrosshair(ch);

  /** Same rules as src/shared/default-pack.js loadDefaultPack. */
  function decodePack(pack) {
    const out = [];
    for (const entry of Array.isArray(pack) ? pack : []) {
      try {
        const category = typeof entry.category === 'string' && entry.category.trim() ? entry.category.trim().slice(0, PACK_MAX_NAME) : PACK_FALLBACK_CATEGORY;
        out.push({ name: String(entry.name || 'Crosshair').slice(0, PACK_MAX_NAME), category, crosshair: core().decodeShareCode(entry.code) });
      } catch (err) {
        console.warn('skipping invalid default pack entry:', entry && entry.name, err.message);
      }
    }
    return out;
  }

  function convertText(text) {
    return window.CrosshairXImport.convertCrosshairX(JSON.parse(String(text).replace(/^﻿/, '')));
  }

  /** Rust lists the Crosshair X files, JS converts them (crosshairx-scan.js scanCrosshairX). */
  function convertScan(res) {
    const items = [];
    const errors = [];
    for (const f of res.files || []) {
      if (f.error) {
        errors.push({ file: f.id, error: f.error });
        continue;
      }
      try {
        items.push({ id: f.id, source: f.source, ...convertText(f.text) });
      } catch (err) {
        errors.push({ file: f.id, error: err.message });
      }
    }
    return { dataDir: res.dataDir, exists: res.exists, items, errors };
  }

  /** cx:openFile: the system file picker of the webview (no native dialog needed). */
  function openFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.json,application/json';
      input.addEventListener('cancel', () => resolve({ items: [], errors: [] }));
      input.addEventListener('change', async () => {
        const items = [];
        const errors = [];
        for (const file of Array.from(input.files || []).slice(0, MAX_IMPORT_FILES)) {
          try {
            if (file.size > MAX_FILE_BYTES) throw new Error('file too large');
            items.push({ id: file.name, source: 'File', ...convertText(await file.text()) });
          } catch (err) {
            errors.push({ file: file.name, error: err.message });
          }
        }
        resolve({ items, errors });
      });
      input.click();
    });
  }

  const BEFORE = {
    'profile:update': (p) => (p && p.crosshair ? { ...p, crosshair: clean(p.crosshair) } : p),
    'profile:create': (p) => ({ ...(p || {}), crosshair: clean(p && p.crosshair) }),
    'profile:importMany': (list) => (Array.isArray(list) ? list.map((it) => ({ ...(it || {}), crosshair: clean(it && it.crosshair) })) : list),
  };
  const AFTER = {
    'config:get': (res) => {
      const { presetPack, ...rest } = res;
      return { ...rest, presets: decodePack(presetPack) };
    },
    'cx:scan': convertScan,
  };
  const LOCAL = { 'cx:openFile': openFiles };

  function invoke(channel, payload) {
    if (LOCAL[channel]) return LOCAL[channel](payload);
    let body;
    try {
      body = BEFORE[channel] ? BEFORE[channel](payload) : payload;
    } catch (err) {
      return Promise.reject(err);
    }
    const after = AFTER[channel];
    return track(raw(channel, body).then((r) => (after ? after(r) : r)));
  }

  function on(channel, cb) {
    let unlisten = null;
    let removed = false;
    tauri()
      .event.listen(channel, (e) => cb(e.payload))
      .then((fn) => (removed ? fn() : (unlisten = fn)))
      .catch((err) => console.error('listen failed', channel, err));
    return () => {
      removed = true;
      if (unlisten) unlisten();
    };
  }

  /** Flush pending edits (settings.js listens to beforeunload), then let Rust close the window. */
  async function requestClose() {
    try {
      window.dispatchEvent(new Event('beforeunload'));
      const timeout = new Promise((r) => setTimeout(r, CLOSE_FLUSH_TIMEOUT_MS));
      await Promise.race([Promise.allSettled([...inflight]), timeout]);
    } finally {
      raw('window:close').catch((err) => console.error('close failed', err));
    }
  }

  // ---------- window chrome (min / max / close + drag) ----------

  function svg(path) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 10 10');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    s.append(p);
    return s;
  }

  function button(cls, title, path, onClick) {
    const b = document.createElement('button');
    b.className = cls;
    b.title = title;
    b.tabIndex = -1;
    b.append(svg(path));
    b.addEventListener('click', onClick);
    return b;
  }

  function installChrome() {
    const bar = document.querySelector('.titlebar');
    if (!bar) return;
    document.documentElement.classList.add('cz-native');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '../native/native-chrome.css';
    document.head.append(link);
    const win = () => tauri().window.getCurrentWindow();
    const controls = document.createElement('div');
    controls.className = 'cz-wc';
    controls.append(
      button('min', 'Minimize', 'M0 5.5h10', () => win().minimize()),
      button('max', 'Maximize', 'M.5.5h9v9h-9z', () => win().toggleMaximize()),
      button('close', 'Close', 'M0 0l10 10M10 0L0 10', requestClose),
    );
    bar.append(controls);
    const interactive = 'button, input, label, select, a, canvas, .cz-wc';
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest(interactive)) return;
      if (e.detail === 2) win().toggleMaximize();
      else win().startDragging();
    });
  }

  window.cz = { invoke, on };
  window.czRequestClose = requestClose;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installChrome);
  else installChrome();
})();
