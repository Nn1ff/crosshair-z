'use strict';

/* Shared renderer helpers (window.CZUI). */
(function () {
  const TOAST_MS = 2200;
  let toastTimer = null;

  /**
   * Create element. attrs: class, on<event> handlers, other attributes.
   * @returns {HTMLElement}
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], obj)[last] = value;
  }

  function toast(msg, isErr) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), TOAST_MS);
  }

  /** IPC wrapper: shows toast on failure, never throws; returns null on error. */
  async function call(channel, payload) {
    try {
      return await window.cz.invoke(channel, payload);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      console.error(channel, err);
      toast(msg, true);
      return null;
    }
  }

  /** Inline SVG icon from the page sprite (#i-<name>). */
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // ---------- tooltips ----------
  // Replaces native title tooltips app-wide: any element with title="Text (Ctrl+Z)" gets a styled tip,
  // a trailing "(shortcut)" is shown as a key cap. Delegated, so elements created later work too.

  const TIP_DELAY_MS = 380;
  const TIP_GAP_PX = 8;
  const SHORTCUT_RE = /^(.*\S)\s+\(((?:Ctrl|Shift|Alt|Del|Esc)[^)]{0,12}|[^\s)]{1,2})\)$/;

  function initTooltips() {
    const tip = el('div', { class: 'tip', id: 'czTooltip', role: 'tooltip' });
    document.body.append(tip);
    let target = null;
    let timer = null;

    const prepare = (node) => {
      if (!node || !node.matches) return;
      if (node.hasAttribute('title')) {
        node.dataset.tip = node.getAttribute('title');
        node.removeAttribute('title');
      }
      if (node.dataset.tip && !node.hasAttribute('aria-label') && !node.textContent.trim()) {
        node.setAttribute('aria-label', node.dataset.tip);
      }
    };

    const showFor = (node) => {
      prepare(node);
      if (!node || !node.dataset.tip || node === target) return;
      hide();
      target = node;
      const m = SHORTCUT_RE.exec(node.dataset.tip);
      tip.replaceChildren(m ? m[1] : node.dataset.tip, m ? el('kbd', null, m[2]) : '');
      if (!node.hasAttribute('aria-describedby')) node.setAttribute('aria-describedby', tip.id);
      timer = setTimeout(place, TIP_DELAY_MS);
    };

    const hide = () => {
      clearTimeout(timer);
      if (target && target.getAttribute('aria-describedby') === tip.id) target.removeAttribute('aria-describedby');
      target = null;
      tip.classList.remove('show');
    };

    const place = () => {
      if (!target || !target.isConnected) return hide();
      const r = target.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const below = r.bottom + TIP_GAP_PX + t.height < window.innerHeight;
      const x = Math.max(6, Math.min(window.innerWidth - t.width - 6, r.left + r.width / 2 - t.width / 2));
      tip.style.left = `${Math.round(x)}px`;
      tip.style.top = `${Math.round(below ? r.bottom + TIP_GAP_PX : r.top - TIP_GAP_PX - t.height)}px`;
      tip.classList.add('show');
    };

    document.addEventListener('mouseover', (e) => {
      const next = e.target.closest && e.target.closest('[title], [data-tip]');
      if (next) showFor(next);
    });
    document.addEventListener('mouseout', (e) => {
      if (target && target.contains(e.target) && !target.contains(e.relatedTarget)) hide();
    });
    document.addEventListener('focusin', (e) => {
      const next = e.target.closest && e.target.closest('[title], [data-tip]');
      if (next) showFor(next);
    });
    document.addEventListener('focusout', (e) => {
      if (target && (e.target === target || target.contains(e.target)) && !target.contains(e.relatedTarget)) hide();
    });
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTooltips);
  else initTooltips();

  window.CZUI = { el, icon, getPath, setPath, toast, call, clone };
})();
