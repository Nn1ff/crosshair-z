'use strict';

/*
 * Crosshair Z designer: pixel-grid canvas, floating layer panel, property panel (Design / Animate),
 * bottom tool dock, undo/redo, drag-to-move, scrub-able number fields. Exposes window.CZDesigner.
 */
(function () {
  const C = CrosshairCore;
  const { el, icon, getPath, setPath, toast, clone } = CZUI;

  const ZOOM_MIN = 2;
  const ZOOM_MAX = 40;
  const ZOOM_DEFAULT = 16;
  const GRID_STEPS = [1, 2, 5, 10, 20, 50, 100];
  const GRID_MIN_SCREEN_PX = 10;
  const HISTORY_MAX = 100;
  const HISTORY_DEBOUNCE_MS = 250;
  const IMAGE_MAX_EDGE = 256;
  const SCRUB_PX_PER_STEP = 4;
  const COLORS = {
    grid: 'rgba(255,255,255,0.045)',
    gridMajor: 'rgba(255,255,255,0.09)',
    guide: 'rgba(255,255,255,0.22)',
    select: '#7cc4ff',
    selectText: '#0b1a2a',
  };

  /** Property panel definition. `layer` = selected layer. */
  const SECTIONS = [
    { id: 'image', title: 'Image', tab: 'design', showIf: (l) => l.kind === 'image', fields: [
      { k: 'image' },
      { k: 'pair', items: [
        { k: 'num', path: 'image.size', label: 'Size' },
        { k: 'num', path: 'rotation', label: 'Rotation' },
      ] },
      { k: 'pair', items: [
        { k: 'pct', path: 'opacity', label: 'Opacity' },
        { k: 'num', path: 'blur', label: 'Blur' },
      ] },
    ] },
    { id: 'style', title: 'Style', tab: 'design', showIf: (l) => l.kind === 'shape', fields: [
      { k: 'color', path: 'color', alpha: 'opacity', label: 'Color' },
      { k: 'pair', items: [
        { k: 'num', path: 'rotation', label: 'Rotation' },
        { k: 'num', path: 'blur', label: 'Blur' },
      ] },
    ] },
    { id: 'lines', title: 'Lines', tab: 'design', toggle: 'lines.enabled', showIf: (l) => l.kind === 'shape', fields: [
      { k: 'arms' },
      { k: 'pair', items: [
        { k: 'num', path: 'lines.length', label: 'Length' },
        { k: 'num', path: 'lines.thickness', label: 'Thickness' },
      ] },
      { k: 'pair', items: [{ k: 'num', path: 'lines.gap', label: 'Gap' }] },
    ] },
    { id: 'dot', title: 'Center dot', tab: 'design', toggle: 'dot.enabled', showIf: (l) => l.kind === 'shape', fields: [
      { k: 'dotcolor' },
      { k: 'pair', items: [
        { k: 'num', path: 'dot.size', label: 'Size' },
        { k: 'opts', path: 'dot.shape', label: 'Shape', values: ['square', 'circle'] },
      ] },
    ] },
    { id: 'outline', title: 'Outline', tab: 'design', toggle: 'outline.enabled', showIf: (l) => l.kind === 'shape', fields: [
      { k: 'color', path: 'outline.color', alpha: 'outline.opacity', label: 'Color' },
      { k: 'pair', items: [{ k: 'num', path: 'outline.thickness', label: 'Thickness' }] },
    ] },
    { id: 'circle', title: 'Circle', tab: 'design', toggle: 'circle.enabled', showIf: (l) => l.kind === 'shape', fields: [
      { k: 'pair', items: [
        { k: 'num', path: 'circle.radius', label: 'Radius' },
        { k: 'num', path: 'circle.thickness', label: 'Thickness' },
      ] },
    ] },
    { id: 'firing', title: 'Firing', tab: 'animate', toggle: 'firing.enabled', fields: [
      { k: 'note', text: 'Plays while left mouse button is held in game.' },
      { k: 'pair', items: [
        { k: 'num', path: 'firing.spread', label: 'Spread' },
        { k: 'num', path: 'firing.kick', label: 'Kick up' },
      ] },
      { k: 'pair', items: [{ k: 'num', path: 'firing.speed', label: 'Speed (ms)', step: 10 }] },
      { k: 'testfire' },
    ] },
  ];

  /**
   * @param {{onChange:(draft:object, structural:boolean)=>void, onRename:(name:string)=>void,
   *          onSave:()=>void, onShare:()=>void, getScale:()=>number}} opts
   */
  function create(opts) {
    const $ = (id) => document.getElementById(id);
    const canvas = $('dzCanvas');
    const ctx = canvas.getContext('2d');
    const st = {
      draft: null,
      sel: 0,
      tab: 'design',
      zoom: ZOOM_DEFAULT,
      collapsed: {},
      syncers: [],
      history: [],
      hIdx: -1,
      hTimer: null,
      anim: new C.FireAnimator(),
      raf: 0,
      ts: 0,
      drag: null,
      bounds: null,
    };

    const layer = () => st.draft.layers[st.sel];

    // ---------- history ----------

    function snapshot() {
      const snap = JSON.stringify({ d: st.draft, s: st.sel });
      if (st.history[st.hIdx] === snap) return;
      st.history = st.history.slice(0, st.hIdx + 1);
      st.history.push(snap);
      if (st.history.length > HISTORY_MAX) st.history.shift();
      st.hIdx = st.history.length - 1;
      syncHistoryButtons();
    }

    function scheduleSnapshot() {
      clearTimeout(st.hTimer);
      st.hTimer = setTimeout(snapshot, HISTORY_DEBOUNCE_MS);
    }

    function restore(i) {
      clearTimeout(st.hTimer);
      if (i < 0 || i >= st.history.length) return;
      st.hIdx = i;
      const { d, s } = JSON.parse(st.history[i]);
      st.draft = C.sanitizeCrosshair(d);
      st.sel = Math.min(s, st.draft.layers.length - 1);
      refresh(true, false);
      syncHistoryButtons();
    }

    function syncHistoryButtons() {
      $('dzUndo').disabled = st.hIdx <= 0;
      $('dzRedo').disabled = st.hIdx >= st.history.length - 1;
    }

    // ---------- change pipeline ----------

    /** Re-validate, redraw, notify owner. structural = layer list changed. */
    function refresh(structural, record = true) {
      st.draft = C.sanitizeCrosshair(st.draft);
      st.sel = Math.max(0, Math.min(st.sel, st.draft.layers.length - 1));
      st.bounds = null;
      sync();
      draw();
      if (structural) renderLayers();
      else updateLayerThumb(st.sel);
      if (record) scheduleSnapshot();
      opts.onChange(st.draft, structural);
    }

    function setValue(path, value, structural) {
      setPath(layer(), path, value);
      refresh(structural);
    }

    function sync() {
      if (!st.draft) return;
      for (const s of st.syncers) s();
      $('dzLayerTitle').textContent = layer().name;
    }

    // ---------- canvas ----------

    function gridStep() {
      return GRID_STEPS.find((g) => g * st.zoom >= GRID_MIN_SCREEN_PX) || GRID_STEPS[GRID_STEPS.length - 1];
    }

    /** Screen geometry: crosshair pixel (px,py) → screen (ox + px*z, oy + py*z). Center pixel at src (cx,cy). */
    function geometry() {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.width;
      const H = canvas.height;
      const z = st.zoom * dpr;
      const srcW = Math.ceil(W / z) + 2;
      const srcH = Math.ceil(H / z) + 2;
      const cx = Math.floor(srcW / 2);
      const cy = Math.floor(srcH / 2);
      return { dpr, W, H, z, srcW, srcH, cx, cy, ox: Math.round(W / 2 - cx * z), oy: Math.round(H / 2 - cy * z) };
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
      draw();
    }

    function drawGrid(g) {
      const step = gridStep();
      ctx.lineWidth = 1;
      for (let i = -Math.ceil(g.cx / step) * step; i * g.z + g.ox < g.W; i += step) {
        const x = Math.round(g.ox + (g.cx + i) * g.z) + 0.5;
        ctx.strokeStyle = (i / step) % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, g.H);
        ctx.stroke();
      }
      for (let i = -Math.ceil(g.cy / step) * step; i * g.z + g.oy < g.H; i += step) {
        const y = Math.round(g.oy + (g.cy + i) * g.z) + 0.5;
        ctx.strokeStyle = (i / step) % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(g.W, y);
        ctx.stroke();
      }
      $('dzScaleLabel').textContent = `${step} px`;
      $('dzScaleBar').style.width = `${(step * g.z) / g.dpr}px`;
    }

    function drawGuides(g) {
      // Crosshair center: pixel center for odd line thickness, pixel corner for even.
      const t = st.draft.layers[0].lines.thickness;
      const half = t % 2 ? 0.5 : 0;
      const x = Math.round(g.ox + (g.cx + half) * g.z) + 0.5;
      const y = Math.round(g.oy + (g.cy + half) * g.z) + 0.5;
      ctx.strokeStyle = COLORS.guide;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, g.H);
      ctx.moveTo(0, y);
      ctx.lineTo(g.W, y);
      ctx.stroke();
    }

    function drawSelection(g) {
      const scale = opts.getScale();
      if (!st.bounds) st.bounds = C.layerBounds(st.draft, st.sel, { scale, fire: st.anim.levels }) || { x: 0, y: 0, w: 0, h: 0, empty: true };
      const b = st.bounds;
      if (b.empty) return;
      const x = Math.round(g.ox + (g.cx + b.x) * g.z) + 0.5;
      const y = Math.round(g.oy + (g.cy + b.y) * g.z) + 0.5;
      const w = Math.round(b.w * g.z);
      const h = Math.round(b.h * g.z);
      const pad = 6 * g.dpr;
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
      ctx.fillStyle = COLORS.select;
      const hs = 3 * g.dpr;
      for (const [hx, hy] of [[x - pad, y - pad], [x + w + pad, y - pad], [x - pad, y + h + pad], [x + w + pad, y + h + pad]]) {
        ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(hx - hs + 0.5, hy - hs + 0.5, hs * 2 - 1, hs * 2 - 1);
      }
      label(layer().name, x - pad, y - pad - 4 * g.dpr, 'left', g.dpr);
      label(`${b.w} × ${b.h} px`, x + w / 2, y + h + pad + 18 * g.dpr, 'center', g.dpr);
    }

    function label(text, x, y, align, dpr) {
      ctx.font = `600 ${11 * dpr}px "Segoe UI", system-ui, sans-serif`;
      const tw = ctx.measureText(text).width;
      const ph = 4 * dpr;
      const h = 16 * dpr;
      const left = align === 'center' ? x - tw / 2 - ph : x;
      ctx.fillStyle = COLORS.select;
      ctx.fillRect(left, y - h, tw + ph * 2, h);
      ctx.fillStyle = COLORS.selectText;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left + ph, y - h / 2);
    }

    function draw() {
      if (!st.draft || !canvas.width) return;
      const g = geometry();
      ctx.clearRect(0, 0, g.W, g.H);
      drawGrid(g);
      drawGuides(g);
      const off = new OffscreenCanvas(g.srcW, g.srcH);
      C.drawCrosshair(off.getContext('2d'), st.draft, g.cx, g.cy, { scale: opts.getScale(), fire: st.anim.levels });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, g.ox, g.oy, g.srcW * g.z, g.srcH * g.z);
      drawSelection(g);
      $('dzZoomLabel').textContent = `${st.zoom}×`;
    }

    function setZoom(z) {
      st.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z)));
      draw();
    }

    // ---------- firing preview ----------

    function animFrame(ts) {
      const dt = st.ts ? Math.min(100, ts - st.ts) : 16;
      st.ts = ts;
      const moving = st.anim.step(dt, st.draft);
      st.bounds = null;
      draw();
      st.raf = moving ? requestAnimationFrame(animFrame) : 0;
      if (!moving) st.ts = 0;
    }

    function testFire(on) {
      st.anim.setFiring(on);
      document.querySelectorAll('.dz-testfire').forEach((b) => b.classList.toggle('on', on));
      if (!st.raf) st.raf = requestAnimationFrame(animFrame);
    }

    // ---------- drag to move ----------

    function wireCanvas() {
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        setZoom(st.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      }, { passive: false });
      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        st.drag = { x: e.clientX, y: e.clientY, ox: layer().offsetX, oy: layer().offsetY };
        canvas.classList.add('dragging');
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!st.drag) return;
        const dx = Math.round((e.clientX - st.drag.x) / st.zoom);
        const dy = Math.round((e.clientY - st.drag.y) / st.zoom);
        const l = layer();
        if (l.offsetX === st.drag.ox + dx && l.offsetY === st.drag.oy + dy) return;
        l.offsetX = st.drag.ox + dx;
        l.offsetY = st.drag.oy + dy;
        refresh(false);
      });
      const end = () => {
        st.drag = null;
        canvas.classList.remove('dragging');
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      new ResizeObserver(resize).observe(canvas);
    }

    // ---------- layers panel ----------

    function layerThumb(l) {
      const c = el('canvas', { width: 28, height: 28 });
      const one = { layers: [Object.assign({}, l, { visible: true, offsetX: 0, offsetY: 0 })] };
      const fit = Math.min(1, 12 / Math.max(1, C.crosshairExtent(one)));
      C.drawCrosshair(c.getContext('2d'), one, 14, 14, { scale: fit });
      return c;
    }

    function updateLayerThumb(i) {
      const row = $('dzLayerList').children[i];
      const old = row && row.querySelector('canvas');
      if (old) old.replaceWith(layerThumb(st.draft.layers[i]));
    }

    function renderLayers() {
      $('dzLayerCount').textContent = st.draft.layers.length;
      $('dzLayerList').replaceChildren(...st.draft.layers.map((l, i) => {
        const eye = el('button', { class: 'dz-eye' + (l.visible ? '' : ' off'), title: l.visible ? 'Hide layer' : 'Show layer' }, icon(l.visible ? 'eye' : 'eye-off'));
        eye.addEventListener('click', (e) => {
          e.stopPropagation();
          l.visible = !l.visible;
          refresh(true);
        });
        const row = el('li', { class: 'dz-layer' + (i === st.sel ? ' sel' : '') + (l.visible ? '' : ' muted') },
          el('span', { class: 'dz-layer-ico' }, layerThumb(l)), el('span', { class: 'dz-layer-name' }, l.name), eye);
        row.addEventListener('click', () => select(i));
        row.addEventListener('dblclick', () => renameLayer(i));
        return row;
      }));
    }

    function select(i) {
      st.sel = i;
      st.bounds = null;
      renderLayers();
      sync();
      draw();
    }

    function renameLayer(i) {
      const row = $('dzLayerList').children[i];
      const nameEl = row && row.querySelector('.dz-layer-name');
      if (!nameEl) return;
      const input = el('input', { class: 'dz-layer-input', value: st.draft.layers[i].name, maxlength: 24 });
      const done = (commit) => {
        if (commit) st.draft.layers[i].name = input.value;
        refresh(true);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          input.value = st.draft.layers[i].name;
          input.blur();
        }
      });
      input.addEventListener('blur', () => done(true), { once: true });
      nameEl.replaceWith(input);
      input.focus();
      input.select();
    }

    function addLayer(l) {
      if (st.draft.layers.length >= C.MAX_LAYERS) {
        toast(`Max ${C.MAX_LAYERS} layers`, true);
        return false;
      }
      if (!l.name || /^(Layer|Crosshair) \d+$/.test(l.name)) l.name = `Crosshair ${st.draft.layers.length + 1}`;
      st.draft.layers.push(l);
      st.sel = st.draft.layers.length - 1;
      refresh(true);
      return true;
    }

    function deleteLayer() {
      if (st.draft.layers.length <= 1) return toast('A crosshair needs at least one layer', true);
      st.draft.layers.splice(st.sel, 1);
      refresh(true);
    }

    function moveLayer(dir) {
      const ls = st.draft.layers;
      const j = st.sel + dir;
      if (j < 0 || j >= ls.length) return;
      [ls[st.sel], ls[j]] = [ls[j], ls[st.sel]];
      st.sel = j;
      refresh(true);
    }

    // ---------- image ----------

    function loadImageFile(file) {
      if (!file) return;
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Use PNG, JPG, GIF or WEBP', true);
      const reader = new FileReader();
      reader.onerror = () => toast('Could not read file', true);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => toast('Image could not be decoded', true);
        img.onload = () => {
          const k = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * k));
          const h = Math.max(1, Math.round(img.naturalHeight * k));
          const c = el('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          const url = c.toDataURL('image/png');
          if (url.length > C.MAX_IMAGE_CHARS) return toast('Image too large', true);
          const l = layer();
          l.kind = 'image';
          l.image.src = url;
          l.image.size = Math.min(64, Math.max(w, h));
          if (/^Crosshair \d+$/.test(l.name)) l.name = 'Image';
          refresh(true);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }

    // ---------- property fields ----------

    /** Compact number field with icon; drag icon horizontally to scrub. */
    function numField(item, pct) {
      const spec = getPath(C.LAYER_SCHEMA, item.path);
      const factor = pct ? 100 : 1;
      const step = item.step || (pct ? 1 : spec.int ? 1 : 0.05);
      const input = el('input', { type: 'number', step, min: spec.min * factor, max: spec.max * factor });
      const handle = el('span', { class: 'nf-ico', title: 'Drag to adjust' }, pct ? `${item.label} %` : item.label);
      const commit = (v) => {
        const n = Number(v);
        if (v === '' || !Number.isFinite(n)) return sync();
        setValue(item.path, n / factor);
      };
      input.addEventListener('change', () => commit(input.value));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      handle.addEventListener('pointerdown', (e) => {
        handle.setPointerCapture(e.pointerId);
        const start = { x: e.clientX, v: getPath(layer(), item.path) * factor };
        const move = (ev) => {
          const steps = Math.round((ev.clientX - start.x) / SCRUB_PX_PER_STEP);
          const next = Math.round((start.v + steps * step) * 1000) / 1000;
          if (next / factor !== getPath(layer(), item.path)) setValue(item.path, next / factor);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
      st.syncers.push(() => {
        if (document.activeElement !== input) input.value = Math.round(getPath(layer(), item.path) * factor * 1000) / 1000;
      });
      return el('label', { class: 'pf' }, el('span', { class: 'nf' }, handle, input));
    }

    function colorField(item) {
      const picker = el('input', { type: 'color', class: 'cf-swatch' });
      const hex = el('input', { type: 'text', class: 'cf-hex', maxlength: 7, spellcheck: 'false' });
      const alpha = el('input', { type: 'number', class: 'cf-alpha', min: 0, max: 100, step: 1 });
      picker.addEventListener('input', () => setValue(item.path, picker.value));
      hex.addEventListener('change', () => {
        const v = hex.value.trim().replace(/^([^#])/, '#$1');
        if (/^#[0-9a-fA-F]{6}$/.test(v)) setValue(item.path, v.toLowerCase());
        else sync();
      });
      alpha.addEventListener('change', () => {
        const n = Number(alpha.value);
        if (Number.isFinite(n)) setValue(item.alpha, n / 100);
        else sync();
      });
      st.syncers.push(() => {
        const v = getPath(layer(), item.path);
        picker.value = v;
        if (document.activeElement !== hex) hex.value = v.toUpperCase();
        if (document.activeElement !== alpha) alpha.value = Math.round(getPath(layer(), item.alpha) * 100);
      });
      return el('div', { class: 'pf full' }, el('span', { class: 'pf-label' }, item.label),
        el('div', { class: 'cf' }, picker, hex, el('span', { class: 'cf-sep' }), alpha, el('span', { class: 'cf-pct' }, '%')));
    }

    function dotColorField() {
      const same = el('button', { class: 'chipbtn' }, 'Line color');
      const own = el('button', { class: 'chipbtn' }, 'Custom');
      same.addEventListener('click', () => setValue('dot.useMainColor', true));
      own.addEventListener('click', () => setValue('dot.useMainColor', false));
      const picker = el('input', { type: 'color', class: 'cf-swatch' });
      picker.addEventListener('input', () => setValue('dot.color', picker.value));
      st.syncers.push(() => {
        const useMain = layer().dot.useMainColor;
        same.classList.toggle('on', useMain);
        own.classList.toggle('on', !useMain);
        picker.classList.toggle('hidden', useMain);
        picker.value = layer().dot.color;
      });
      return el('div', { class: 'pf full' }, el('span', { class: 'pf-label' }, 'Color'), el('div', { class: 'row-tight' }, same, own, picker));
    }

    function optsField(item) {
      const btns = item.values.map((v) => el('button', { class: 'chipbtn', onclick: () => setValue(item.path, v) }, v));
      st.syncers.push(() => btns.forEach((b, i) => b.classList.toggle('on', getPath(layer(), item.path) === item.values[i])));
      return el('div', { class: 'pf' }, el('span', { class: 'pf-label' }, item.label), el('div', { class: 'row-tight' }, ...btns));
    }

    function armsField() {
      const arms = [['top'], ['left'], ['right'], ['bottom']];
      const btns = arms.map(([a]) => el('button', { class: 'arm', title: `${a} line`, 'data-arm': a, onclick: () => setValue('lines.' + a, !layer().lines[a]) }, icon('up')));
      st.syncers.push(() => btns.forEach((b, i) => b.classList.toggle('on', layer().lines[arms[i][0]])));
      return el('div', { class: 'pf full' }, el('span', { class: 'pf-label' }, 'Visible lines'), el('div', { class: 'arms-pad' }, ...btns));
    }

    function imageField() {
      const img = el('img', { alt: '' });
      const btn = el('button', { class: 'btn ghost small', onclick: () => $('dzImageFile').click() }, 'Choose image');
      st.syncers.push(() => {
        const src = layer().image.src;
        if (src) img.src = src;
        else img.removeAttribute('src');
        btn.textContent = src ? 'Replace image' : 'Choose image';
      });
      return el('div', { class: 'pf full image-pick' }, img, btn);
    }

    function testFireField() {
      const b = el('button', { class: 'btn ghost small dz-testfire' }, 'Hold to test fire');
      b.addEventListener('pointerdown', () => testFire(true));
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => st.anim.firing && testFire(false));
      return el('div', { class: 'pf full' }, b);
    }

    function buildField(item) {
      switch (item.k) {
        case 'num': return numField(item, false);
        case 'pct': return numField(item, true);
        case 'color': return colorField(item);
        case 'dotcolor': return dotColorField();
        case 'opts': return optsField(item);
        case 'arms': return armsField();
        case 'image': return imageField();
        case 'testfire': return testFireField();
        case 'note': return el('p', { class: 'pf-note' }, item.text);
        case 'pair': return el('div', { class: 'pf-pair' }, ...item.items.map(buildField));
        default: throw new Error(`unknown field ${item.k}`);
      }
    }

    function buildSection(sec) {
      const chevron = icon('chevron');
      chevron.classList.add('sec-chev');
      const toggleBtn = el('button', { class: 'sec-toggle' });
      const head = el('div', { class: 'sec-head' }, chevron, el('span', { class: 'sec-title' }, sec.title), sec.toggle ? toggleBtn : null);
      const body = el('div', { class: 'sec-body' }, ...sec.fields.map(buildField));
      const node = el('section', { class: 'sec' }, head, body);
      head.addEventListener('click', (e) => {
        if (e.target === toggleBtn) return;
        st.collapsed[sec.id] = !st.collapsed[sec.id];
        sync();
      });
      if (sec.toggle) {
        toggleBtn.addEventListener('click', () => {
          const on = !getPath(layer(), sec.toggle);
          if (on) st.collapsed[sec.id] = false;
          setValue(sec.toggle, on);
        });
      }
      st.syncers.push(() => {
        const visible = st.tab === sec.tab && (!sec.showIf || sec.showIf(layer()));
        const enabled = !sec.toggle || getPath(layer(), sec.toggle);
        node.classList.toggle('hidden', !visible);
        node.classList.toggle('disabled', !enabled);
        const open = enabled && !st.collapsed[sec.id];
        node.classList.toggle('open', open);
        toggleBtn.replaceChildren(icon(enabled ? 'x' : 'plus'));
        toggleBtn.title = enabled ? `Remove ${sec.title}` : `Add ${sec.title}`;
      });
      return node;
    }

    function buildTransform() {
      const xy = el('div', { class: 'pf-pair' },
        numField({ path: 'offsetX', label: 'X' }),
        numField({ path: 'offsetY', label: 'Y' }));
      const scale = el('div', { class: 'pf-pair' }, numField({ path: 'scale', label: 'Scale', step: 0.1 }));
      const kind = optsField({ path: 'kind', label: 'Type', values: ['shape', 'image'] });
      const node = el('section', { class: 'sec open transform' }, el('div', { class: 'sec-body' }, xy, scale, el('div', { class: 'pf-pair' }, kind)));
      st.syncers.push(() => node.classList.toggle('hidden', st.tab !== 'design'));
      return node;
    }

    function buildProps() {
      $('dzProps').replaceChildren(buildTransform(), ...SECTIONS.map(buildSection));
      document.querySelectorAll('#dzTabs button').forEach((b) =>
        b.addEventListener('click', () => {
          st.tab = b.dataset.tab;
          document.querySelectorAll('#dzTabs button, #dzDockTabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === st.tab));
          sync();
        }));
      document.querySelectorAll('#dzDockTabs button').forEach((b) => b.addEventListener('click', () => $('dzTabs').querySelector(`[data-tab="${b.dataset.tab}"]`).click()));
    }

    // ---------- toolbar / dock / keys ----------

    function newShapeLayer() {
      const l = clone(C.DEFAULT_LAYER);
      return addLayer(l);
    }

    function wireToolbar() {
      $('dzUndo').addEventListener('click', () => restore(st.hIdx - 1));
      $('dzRedo').addEventListener('click', () => restore(st.hIdx + 1));
      $('dzDupLayer').addEventListener('click', () => addLayer(clone(layer())));
      $('dzDelLayer').addEventListener('click', deleteLayer);
      $('dzLayerUp').addEventListener('click', () => moveLayer(-1));
      $('dzLayerDown').addEventListener('click', () => moveLayer(1));
      $('dzNewLayer').addEventListener('click', newShapeLayer);
      $('dzSave').addEventListener('click', () => opts.onSave());
      $('dzShare').addEventListener('click', () => opts.onShare());
      $('dzName').addEventListener('change', (e) => opts.onRename(e.target.value));
      $('dzName').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
      $('dzToolCenter').addEventListener('click', () => {
        layer().offsetX = 0;
        layer().offsetY = 0;
        refresh(false);
      });
      $('dzToolImage').addEventListener('click', () => {
        const l = clone(C.DEFAULT_LAYER);
        l.kind = 'image';
        l.name = 'Image';
        if (addLayer(l)) $('dzImageFile').click();
      });
      $('dzToolShape').addEventListener('click', newShapeLayer);
      $('dzZoomIn').addEventListener('click', () => setZoom(st.zoom * 1.25));
      $('dzZoomOut').addEventListener('click', () => setZoom(st.zoom / 1.25));
      $('dzZoomLabel').addEventListener('click', () => setZoom(ZOOM_DEFAULT));
      $('dzImageFile').addEventListener('change', (e) => {
        loadImageFile(e.target.files && e.target.files[0]);
        e.target.value = '';
      });
      window.addEventListener('keydown', onKey);
    }

    function onKey(e) {
      if (!isActive()) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'z' && !e.shiftKey) restore(st.hIdx - 1);
      else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) restore(st.hIdx + 1);
      else if (e.ctrlKey && k === 'd') addLayer(clone(layer()));
      else if (k === 'delete') deleteLayer();
      else if (k.startsWith('arrow')) {
        const step = e.shiftKey ? 10 : 1;
        const l = layer();
        if (k === 'arrowleft') l.offsetX -= step;
        if (k === 'arrowright') l.offsetX += step;
        if (k === 'arrowup') l.offsetY -= step;
        if (k === 'arrowdown') l.offsetY += step;
        refresh(false);
      } else return;
      e.preventDefault();
    }

    function isActive() {
      const page = document.querySelector('.page[data-page="designer"]');
      return page && !page.classList.contains('hidden');
    }

    // ---------- public ----------

    /**
     * Load crosshair into designer. resetHistory when switching crosshair.
     * @param {object} crosshair
     * @param {string} name
     * @param {boolean} resetHistory
     */
    function load(crosshair, name, resetHistory) {
      st.draft = C.sanitizeCrosshair(clone(crosshair));
      if (resetHistory) {
        st.sel = 0;
        st.history = [];
        st.hIdx = -1;
        snapshot();
      }
      st.sel = Math.min(st.sel, st.draft.layers.length - 1);
      st.bounds = null;
      if (document.activeElement !== $('dzName')) $('dzName').value = name;
      renderLayers();
      sync();
      draw();
    }

    wireCanvas();
    wireToolbar();
    buildProps();
    C.onImageLoaded(() => {
      st.bounds = null;
      draw();
      if (st.draft) renderLayers();
      if (opts.onImageLoaded) opts.onImageLoaded();
    });

    return { load, redraw: () => { st.bounds = null; draw(); }, resize };
  }

  window.CZDesigner = { create };
})();
