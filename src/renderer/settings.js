'use strict';

/* Settings window shell: library, saved, position, toggle, hotkeys, share, settings. Designer lives in designer.js. */
(function () {
  const C = CrosshairCore;
  const { el, icon, toast, call } = CZUI;
  const PUSH_DEBOUNCE_MS = 40;
  // Card preview buffer in device pixels; drawn 1:1 like in-game (no upscaling).
  const CARD_W = 128;
  const CARD_H = 96;
  const MAX_OFFSET = 4000;
  const HOTKEY_LABELS = {
    toggle: 'Show / hide',
    next: 'Next crosshair',
    prev: 'Previous crosshair',
    settings: 'Open app',
    moveUp: 'Move up',
    moveDown: 'Move down',
    moveLeft: 'Move left',
    moveRight: 'Move right',
  };
  const KB_MODES = [
    { v: 'hide', t: 'Hide crosshair', d: 'Shortcut hides / shows the crosshair.' },
    { v: 'switch', t: 'Switch crosshair', d: 'Shortcut swaps to a secondary saved crosshair.' },
  ];
  const RC_MODES = [
    { v: 'off', t: 'Off', d: 'Right mouse button does nothing.' },
    { v: 'hideHold', t: 'Hide while holding', d: 'Great for scoped weapons with own reticle.' },
    { v: 'hideToggle', t: 'Hide on click', d: 'Single click hides, next click shows.' },
    { v: 'switchHold', t: 'Switch while holding', d: 'Secondary crosshair while button held.' },
    { v: 'switchToggle', t: 'Switch on click', d: 'Single click swaps, next click swaps back.' },
  ];

  /** Rail groups → top tabs. */
  const GROUPS = {
    crosshairs: [['discover', 'Discover'], ['library', 'Browse'], ['saved', 'Saved'], ['import', 'Import'], ['share', 'Share']],
    designer: [['designer', 'Designer']],
    keys: [['hotkeys', 'Hotkeys'], ['toggle', 'Toggle']],
    display: [['position', 'Position and size']],
    app: [['settings', 'Settings']],
  };
  const CX_COLLECTION = 'Crosshair X';
  const CATEGORY_ICONS = {
    All: 'grid', Classic: 'shape', Dot: 'dot', Circle: 'ring', 'T-Shape': 'tshape', Sniper: 'scope',
    Dynamic: 'pulse', Layered: 'stack', Stylized: 'spark', [CX_COLLECTION]: 'import', Workshop: 'share', 'Starter pack': 'reticle',
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    config: null,
    presets: [],
    hotkeyStatus: {},
    defaults: {},
    runtime: {},
    draft: null, // crosshair being edited (active profile)
    draftId: null,
    category: 'All',
    search: '',
    lastPage: {}, // group → last visited page
    pushTimer: null,
    syncers: [],
    recording: null, // {kind:'global'|'profile', key}
    designer: null,
    cx: null, // last Crosshair X scan result
  };

  function activeProfile() {
    const c = ui.config;
    return c.profiles.find((p) => p.id === c.activeProfileId) || c.profiles[0];
  }

  // ---------- thumbnails ----------

  /** Draw crosshair at 1:1 pixels into small canvas (CSS upscales pixelated); shrink if it does not fit. */
  function drawThumb(canvas, ch, w = 36, h = 36) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const extent = C.crosshairExtent(ch);
    const fit = Math.min(1, (Math.min(w, h) / 2 - 2) / Math.max(1, extent));
    C.drawCrosshair(ctx, ch, w / 2, h / 2, { scale: fit });
  }

  /** Card preview: true screen size, CSS box = buffer / devicePixelRatio so 1 crosshair px = 1 screen px. */
  function drawCardThumb(canvas, ch) {
    drawThumb(canvas, ch, CARD_W, CARD_H);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${CARD_W / dpr}px`;
    canvas.style.height = `${CARD_H / dpr}px`;
  }

  /**
   * Crosshair card: preview "slide", name, optional tag/extra row and bookmark button.
   * @param {{onMark?: () => void, marked?: boolean}} [opts]
   */
  function card(ch, name, tag, active, extra, opts = {}) {
    const canvas = el('canvas');
    drawCardThumb(canvas, ch);
    const li = el('li', { class: 'card' + (active ? ' active' : ''), title: name }, el('div', { class: 'slide' }, canvas),
      el('div', { class: 'meta' }, el('span', { class: 'name' }, name), tag ? el('span', { class: 'tag' }, tag) : null), extra);
    if (opts.onMark) {
      const mark = el('button', { class: 'mark' + (opts.marked ? ' on' : ''), title: opts.marked ? 'Already in Saved' : 'Add to Saved' }, icon(opts.marked ? 'bookmarked' : 'bookmark'));
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!opts.marked) opts.onMark();
      });
      li.append(mark);
    }
    return li;
  }

  /** Fingerprints of saved crosshairs, to show which library items are already saved. */
  function savedPrints() {
    return new Set(ui.config.profiles.map((p) => JSON.stringify(C.sanitizeCrosshair(p.crosshair))));
  }

  // ---------- library / saved ----------

  function renderProfiles() {
    const list = $('profileList');
    list.replaceChildren();
    for (const p of ui.config.profiles) {
      const active = p.id === ui.config.activeProfileId;
      const sc = p.hotkey ? el('div', { class: 'shortcut' }, prettyAccel(p.hotkey)) : null;
      const li = card(p.id === ui.draftId ? ui.draft : p.crosshair, p.name, active ? 'equipped' : '', active, sc);
      li.addEventListener('click', () => activate(p.id));
      li.addEventListener('dblclick', () => showPage('designer'));
      list.append(li);
    }
    $('activeName').textContent = activeProfile().name;
    drawThumb($('currentThumb'), ui.draft || activeProfile().crosshair, 44, 44);
  }

  /**
   * Library entries: shipped starter pack (ui.presets) plus this user's own Crosshair X crosshairs.
   * Crosshair X entries identical to a starter-pack design are not listed twice.
   */
  function libraryItems() {
    const prints = new Set(ui.presets.map((p) => JSON.stringify(p.crosshair)));
    const cx = (ui.cx ? ui.cx.items : [])
      .filter((it) => !prints.has(JSON.stringify(it.crosshair)))
      .map((it) => ({ name: it.name, category: it.source === 'Workshop' ? 'Workshop' : CX_COLLECTION, crosshair: it.crosshair }));
    return [...ui.presets, ...cx];
  }

  function renderPresets() {
    const items = libraryItems();
    const cats = ['All', ...new Set(items.map((p) => p.category))];
    if (!cats.includes(ui.category)) ui.category = 'All';
    $('categoryList').replaceChildren(...cats.map((c) => {
      const count = c === 'All' ? items.length : items.filter((p) => p.category === c).length;
      const b = el('button', { class: 'side-item' + (c === ui.category ? ' active' : '') }, icon(CATEGORY_ICONS[c] || 'reticle'),
        el('span', null, c === 'All' ? 'All crosshairs' : c), el('span', { class: 'n' }, String(count)));
      b.addEventListener('click', () => {
        ui.category = c;
        renderPresets();
      });
      return el('li', null, b);
    }));
    const q = ui.search.trim().toLowerCase();
    const shown = items.filter((p) => (ui.category === 'All' || p.category === ui.category)
      && (!q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)));
    $('libraryTitle').textContent = ui.category === 'All' ? 'All crosshairs' : ui.category;
    $('libraryEmpty').textContent = items.length
      ? 'No crosshair matches that search.'
      : 'No crosshairs yet. Save some in Crosshair X, or make one with New crosshair under Saved.';
    $('libraryEmpty').classList.toggle('hidden', shown.length > 0);
    const prints = savedPrints();
    $('presetList').replaceChildren(...shown.map((p) => {
      const marked = prints.has(JSON.stringify(p.crosshair));
      const li = card(p.crosshair, p.name, ui.category === 'All' && p.category !== 'Starter pack' ? p.category : '', false, null, {
        marked,
        onMark: () => saveProfile(p.name, p.crosshair),
      });
      li.addEventListener('click', () => createProfile(p.name, p.crosshair, true));
      return li;
    }));
  }

  /** Add to Saved without equipping. */
  async function saveProfile(name, crosshair) {
    flushPush();
    const res = await call('profile:create', { name, crosshair, activate: false, dedupe: true });
    if (res) {
      applyConfig(res.config, false);
      toast(res.existed ? `"${name}" is already in Saved` : `Saved "${name}"`);
    }
  }

  async function activate(id) {
    flushPush();
    const cfg = await call('profile:activate', id);
    if (cfg) applyConfig(cfg, true);
  }

  /** Create + equip. dedupe=true reuses an identical saved crosshair (library clicks). */
  async function createProfile(name, crosshair, dedupe = false) {
    flushPush();
    const res = await call('profile:create', { name, crosshair, dedupe });
    if (res) {
      applyConfig(res.config, true);
      toast(`Equipped "${name}"`);
    }
  }

  async function moveProfile(dir) {
    const cfg = await call('profile:move', { id: ui.config.activeProfileId, dir });
    if (cfg) applyConfig(cfg, false);
  }

  async function deleteProfile() {
    const p = activeProfile();
    if (!window.confirm(`Delete "${p.name}"?`)) return;
    clearTimeout(ui.pushTimer);
    ui.pushTimer = null;
    const cfg = await call('profile:delete', p.id);
    if (cfg) applyConfig(cfg, true);
  }

  // ---------- designer bridge ----------

  function onDesignerChange(draft) {
    ui.draft = draft;
    ui.designer.setStatus('saving');
    schedulePush();
    updateShare();
    const li = $('profileList').querySelector('li.active canvas');
    if (li) drawCardThumb(li, ui.draft);
    drawThumb($('currentThumb'), ui.draft, 44, 44);
  }

  function schedulePush() {
    clearTimeout(ui.pushTimer);
    ui.pushTimer = setTimeout(flushPush, PUSH_DEBOUNCE_MS);
  }

  function flushPush() {
    if (!ui.pushTimer) return;
    clearTimeout(ui.pushTimer);
    ui.pushTimer = null;
    call('profile:update', { id: ui.draftId, crosshair: ui.draft }).then((res) => {
      // only report saved when nothing newer is queued; failures already toast via call()
      if (res && !ui.pushTimer) ui.designer.setStatus('saved');
    });
  }

  async function rename(name) {
    flushPush();
    const cfg = await call('profile:update', { id: ui.draftId, name });
    if (cfg) applyConfig(cfg, false);
  }

  async function copyShareCode() {
    try {
      const code = C.encodeShareCode(ui.draft);
      if ((await call('clipboard:write', code)) !== null) {
        toast(C.hasImageLayers(ui.draft) ? 'Code copied (image layers skipped)' : 'Share code copied');
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- position ----------

  /** Slider + number box bound to getter/setter. */
  function sliderRow(label, spec, step, get, set) {
    const range = el('input', { type: 'range', min: spec.min, max: spec.max, step });
    const num = el('input', { type: 'number', min: spec.min, max: spec.max, step });
    const commit = (v) => {
      const n = Number(v);
      if (v !== '' && Number.isFinite(n)) set(n);
    };
    // --p drives the filled part of the track (CSS gradient)
    const paint = () => range.style.setProperty('--p', `${((range.value - spec.min) / (spec.max - spec.min)) * 100}%`);
    range.addEventListener('input', () => {
      paint();
      commit(range.value);
    });
    num.addEventListener('change', () => commit(num.value));
    ui.syncers.push(() => {
      const v = get();
      range.value = v;
      paint();
      if (document.activeElement !== num) num.value = v;
    });
    return el('div', { class: 'ctrl' }, el('label', null, label), range, num);
  }

  function buildPosition() {
    $('sizeControls').append(sliderRow('Size', { min: 0.25, max: 4 }, 0.05, () => ui.config.display.scale, (n) => patch({ display: { scale: n } })));
    for (const axis of ['offsetX', 'offsetY']) {
      $('offsetControls').append(sliderRow(axis === 'offsetX' ? 'X' : 'Y', { min: -500, max: 500 }, 1,
        () => ui.config.display[axis], (n) => patch({ display: { [axis]: Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(n))) } })));
    }
    document.querySelectorAll('[data-nudge]').forEach((b) =>
      b.addEventListener('click', () => {
        const [dx, dy] = b.dataset.nudge.split(',').map(Number);
        patch({ display: { offsetX: ui.config.display.offsetX + dx, offsetY: ui.config.display.offsetY + dy } });
      }),
    );
    $('btnCenter').addEventListener('click', () => patch({ display: { offsetX: 0, offsetY: 0 } }));
  }

  async function patch(p) {
    const cfg = await call('config:patch', p);
    if (cfg) applyConfig(cfg, false);
  }

  async function loadMonitors() {
    const list = (await call('displays:list')) || [];
    const sel = $('monitorSelect');
    sel.replaceChildren(el('option', { value: '' }, 'Primary display'), ...list.map((d) => el('option', { value: String(d.id) }, d.label)));
    sel.value = ui.config.display.monitorId == null ? '' : String(ui.config.display.monitorId);
  }

  // ---------- toggle page ----------

  function optionGrid(rootId, modes, current, onPick) {
    $(rootId).replaceChildren(...modes.map((m) =>
      el('button', { class: 'option' + (m.v === current ? ' on' : ''), onclick: () => onPick(m.v) }, el('b', null, m.t), el('span', null, m.d))));
  }

  function profileSelect(sel, value) {
    const opts = ui.config.profiles.map((p) => el('option', { value: p.id }, p.name));
    sel.replaceChildren(el('option', { value: '' }, '— choose saved crosshair —'), ...opts);
    sel.value = value || '';
  }

  function renderToggle() {
    const c = ui.config;
    optionGrid('kbModes', KB_MODES, c.toggle.mode, (mode) => patch({ toggle: { mode } }));
    optionGrid('rcModes', RC_MODES, c.rightClick.mode, (mode) => patch({ rightClick: { mode } }));
    profileSelect($('kbProfile'), c.toggle.profileId);
    profileSelect($('rcProfile'), c.rightClick.profileId);
    $('kbProfileField').classList.toggle('hidden', c.toggle.mode !== 'switch');
    $('rcProfileField').classList.toggle('hidden', !c.rightClick.mode.startsWith('switch'));
    $('toggleKeyLabel').textContent = prettyAccel(c.hotkeys.toggle);
    $('mouseWarn').classList.toggle('hidden', ui.runtime.mouseAvailable !== false);
  }

  // ---------- hotkeys ----------

  const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
  const KEY_MAP = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    '+': 'Plus', Escape: 'Esc', Enter: 'Return',
  };

  /** KeyboardEvent → Electron accelerator, or null if only modifiers. */
  function toAccelerator(e) {
    if (MOD_KEYS.has(e.key)) return null;
    let key;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
    else if (/^Numpad[0-9]$/.test(e.code)) key = 'num' + e.code.slice(6);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
    else key = KEY_MAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const mods = [];
    if (e.ctrlKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    return [...mods, key].join('+');
  }

  function prettyAccel(a) {
    return a ? a.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ') : '— none —';
  }

  function hotkeyRow(label, accel, status, rec) {
    const recording = ui.recording && ui.recording.kind === rec.kind && ui.recording.key === rec.key;
    const btn = el('button', { class: 'hk-btn' + (recording ? ' recording' : ''), onclick: () => startRecording(rec) }, recording ? 'Press keys…' : prettyAccel(accel));
    const ok = status === 'ok';
    const shown = status && status !== 'empty';
    const badge = el('span', { class: 'badge' + (shown ? (ok ? ' ok' : ' bad') : ''), title: status || '' }, shown ? (ok ? 'active' : status) : '');
    return el('div', { class: 'hk-row' }, el('span', { class: 'hk-name', title: label }, label), btn, badge);
  }

  function renderHotkeys() {
    const row = (k) => hotkeyRow(HOTKEY_LABELS[k], ui.config.hotkeys[k], ui.hotkeyStatus[k], { kind: 'global', key: k });
    $('hotkeyRows').replaceChildren(row('toggle'));
    $('moreHotkeyRows').replaceChildren(...Object.keys(HOTKEY_LABELS).filter((k) => k !== 'toggle').map(row));
    $('profileHotkeyRows').replaceChildren(...ui.config.profiles.map((p) =>
      hotkeyRow(p.name, p.hotkey, ui.hotkeyStatus[`profile:${p.id}`], { kind: 'profile', key: p.id })));
  }

  async function startRecording(rec) {
    ui.recording = rec;
    await call('hotkeys:suspend', true);
    renderHotkeys();
  }

  async function stopRecording(accel) {
    const rec = ui.recording;
    ui.recording = null;
    if (accel !== undefined && rec) {
      if (rec.kind === 'global') {
        const status = await call('hotkeys:set', { [rec.key]: accel });
        if (status) ui.hotkeyStatus = status;
      } else {
        const cfg = await call('profile:update', { id: rec.key, hotkey: accel });
        if (cfg) ui.config = cfg;
      }
    }
    await call('hotkeys:suspend', false);
    renderHotkeys();
    renderToggle();
  }

  function onRecordKey(e) {
    if (!ui.recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopRecording();
    if (e.key === 'Backspace' || e.key === 'Delete') return stopRecording('');
    const accel = toAccelerator(e);
    if (accel) stopRecording(accel);
  }

  // ---------- share ----------

  function updateShare() {
    let code = '';
    try {
      code = C.encodeShareCode(ui.draft);
    } catch (err) {
      code = err.message;
    }
    $('exportCode').value = code;
    $('shareImageWarn').classList.toggle('hidden', !C.hasImageLayers(ui.draft));
  }

  async function importCode() {
    let ch;
    try {
      ch = C.decodeShareCode($('importCode').value);
    } catch (err) {
      toast(err.message, true);
      return;
    }
    await createProfile('Imported', ch);
    $('importCode').value = '';
  }

  // ---------- Crosshair X import ----------

  function renderImport(res) {
    ui.cx = res;
    renderPresets();
    const list = $('cxList');
    const n = res.items.length;
    $('cxStatus').textContent = n
      ? `Found ${n} crosshair${n === 1 ? '' : 's'}${res.errors.length ? ` (${res.errors.length} could not be read)` : ''}. They also appear in the library under ${CX_COLLECTION}.`
      : res.exists === false ? 'Crosshair X is not installed for this Windows user. Use Import file to pick a crosshair .json.' : 'Crosshair X has no saved crosshairs yet.';
    $('cxImportAll').disabled = n === 0;
    list.replaceChildren(...res.items.map((it) => {
      const extra = it.warnings.length ? el('div', { class: 'shortcut', title: it.warnings.join(', ') }, `Converted with ${it.warnings.length} change${it.warnings.length > 1 ? 's' : ''}`) : null;
      const li = card(it.crosshair, it.name, it.source, false, extra);
      li.addEventListener('click', () => importCx([it]));
      return li;
    }));
  }

  async function scanCx() {
    $('cxStatus').textContent = 'Scanning…';
    const res = await call('cx:scan');
    if (res) renderImport(res);
  }

  async function importCx(items) {
    flushPush();
    const res = await call('profile:importMany', items.map((it) => ({ name: it.name, crosshair: it.crosshair })));
    if (!res) return;
    applyConfig(res.config, true);
    const notes = [];
    if (res.duplicates) notes.push(`${res.duplicates} already saved`);
    if (res.overLimit) notes.push(`${res.overLimit} over the limit`);
    toast(`Imported ${res.imported} crosshair${res.imported === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }

  async function removeDuplicates() {
    flushPush();
    const res = await call('profile:dedupe');
    if (!res) return;
    applyConfig(res.config, true);
    toast(res.removed ? `Removed ${res.removed} duplicate${res.removed === 1 ? '' : 's'}` : 'No duplicates found');
  }

  async function importCxFile() {
    const res = await call('cx:openFile');
    if (!res) return;
    if (res.errors.length) toast(`${res.errors[0].file}: ${res.errors[0].error}`, true);
    if (res.items.length) await importCx(res.items);
  }

  // ---------- config application ----------

  /**
   * Take config from main. resetDraft=true reloads designer from active profile.
   * @param {object} cfg
   * @param {boolean} resetDraft
   */
  function applyConfig(cfg, resetDraft) {
    ui.config = cfg;
    const active = activeProfile();
    const switched = active.id !== ui.draftId;
    if (resetDraft || switched || !ui.pushTimer) {
      ui.draftId = active.id;
      ui.draft = C.sanitizeCrosshair(active.crosshair);
      ui.designer.load(ui.draft, active.name, resetDraft || switched);
    } else {
      ui.designer.redraw();
    }
    $('enabledToggle').checked = cfg.enabled;
    for (const k of ['launchAtLogin', 'startHidden', 'hideOnLaunch']) $(k).checked = cfg[k];
    const sel = $('monitorSelect');
    if (sel.options.length) sel.value = cfg.display.monitorId == null ? '' : String(cfg.display.monitorId);
    for (const s of ui.syncers) s();
    updateShare();
    renderProfiles();
    renderPresets();
    renderToggle();
    if (!ui.recording) renderHotkeys();
  }

  // ---------- wiring ----------

  function groupOf(page) {
    return Object.keys(GROUPS).find((g) => GROUPS[g].some(([p]) => p === page)) || 'crosshairs';
  }

  function showPage(page) {
    if (page === 'discover' && ui.config) {
      drawThumb($('discoverPreview'), ui.draft || activeProfile().crosshair, 240, 100);
      $('discoverName').textContent = activeProfile().name;
      $('discoverCards').replaceChildren(...ui.presets.slice(0, 10).map(p => {
        const item = card(p.crosshair, p.name, p.category, false);
        item.addEventListener('click', () => createProfile(p.name, p.crosshair));
        return item;
      }));
    }
    const group = groupOf(page);
    ui.lastPage[group] = page;
    document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
    // a section with a single page needs no tab strip (its page has its own header/toolbar)
    document.querySelector('.shell').classList.toggle('single', GROUPS[group].length === 1);
    $('tabs').replaceChildren(...GROUPS[group].map(([p, label]) =>
      el('button', { class: 'tab' + (p === page ? ' active' : ''), role: 'tab', onclick: () => showPage(p) }, label)));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== page));
    if (page === 'position') loadMonitors();
    if (page === 'library') $('librarySearch').focus({ preventScroll: true });
    if (page === 'designer') ui.designer.resize();
  }

  function wire() {
    document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.goto)));
    document.querySelectorAll('.rail-btn').forEach((b) => b.addEventListener('click', () => {
      const g = b.dataset.group;
      showPage(ui.lastPage[g] || GROUPS[g][0][0]);
    }));
    $('librarySearch').addEventListener('input', (e) => {
      ui.search = e.target.value;
      renderPresets();
    });
    // used by capture mode; "designer:light" also picks a stage background
    window.czShowPage = (spec) => {
      const [page, bg] = String(spec).split(":");
      showPage(page);
      const btn = bg && document.querySelector(`#dzBg [data-bg="${bg}"]`);
      if (btn) btn.click();
    };
    $('btnNew').addEventListener('click', () => createProfile('New Crosshair', C.DEFAULT_CROSSHAIR));
    $('btnDup').addEventListener('click', () => createProfile(activeProfile().name + ' copy', ui.draft));
    $('btnDel').addEventListener('click', deleteProfile);
    $('btnDedupe').addEventListener('click', removeDuplicates);
    $('btnUp').addEventListener('click', () => moveProfile(-1));
    $('btnDown').addEventListener('click', () => moveProfile(1));

    $('monitorSelect').addEventListener('change', (e) => patch({ display: { monitorId: e.target.value === '' ? null : Number(e.target.value) } }));
    $('kbProfile').addEventListener('change', (e) => patch({ toggle: { profileId: e.target.value || null } }));
    $('rcProfile').addEventListener('change', (e) => patch({ rightClick: { profileId: e.target.value || null } }));
    for (const key of ['launchAtLogin', 'startHidden', 'hideOnLaunch']) {
      $(key).addEventListener('change', (e) => patch({ [key]: e.target.checked }));
    }
    $('enabledToggle').addEventListener('change', (e) => patch({ enabled: e.target.checked }));

    $('btnHotkeyDefaults').addEventListener('click', async () => {
      const status = await call('hotkeys:set', ui.defaults);
      if (status) ui.hotkeyStatus = status;
    });
    window.addEventListener('keydown', onRecordKey, true);
    window.addEventListener('blur', () => ui.recording && stopRecording());

    $('btnCopy').addEventListener('click', async () => {
      if ((await call('clipboard:write', $('exportCode').value)) !== null) toast('Code copied');
    });
    $('btnPaste').addEventListener('click', async () => {
      const text = await call('clipboard:read');
      if (text != null) $('importCode').value = text;
    });
    $('btnImport').addEventListener('click', importCode);
    $('cxRescan').addEventListener('click', scanCx);
    $('cxFile').addEventListener('click', importCxFile);
    $('cxImportAll').addEventListener('click', () => ui.cx && ui.cx.items.length && importCx(ui.cx.items));

    window.addEventListener('beforeunload', flushPush);
    window.cz.on('config:changed', (cfg) => applyConfig(cfg, false));
    window.cz.on('runtime:changed', (rt) => {
      ui.runtime = rt || {};
      renderToggle();
    });
    window.cz.on('hotkeys:status', (s) => {
      ui.hotkeyStatus = s || {};
      if (!ui.recording) renderHotkeys();
    });
  }

  async function init() {
    ui.designer = CZDesigner.create({
      onChange: onDesignerChange,
      onRename: rename,
      onSave: () => {
        flushPush();
        toast('Saved');
      },
      onShare: copyShareCode,
      getScale: () => (ui.config ? ui.config.display.scale : 1),
      onImageLoaded: () => ui.config && renderProfiles(),
    });
    wire();
    buildPosition();
    const res = await call('config:get');
    if (!res) return;
    ui.presets = res.presets || [];
    ui.hotkeyStatus = res.hotkeyStatus || {};
    ui.runtime = res.runtime || {};
    ui.defaults = res.defaults || {};
    applyConfig(res.config, true);
    showPage('discover');
    loadMonitors();
    scanCx();
    const logPath = await call('log:path');
    if (logPath) $('logPath').textContent = logPath;
  }

  init();
})();
