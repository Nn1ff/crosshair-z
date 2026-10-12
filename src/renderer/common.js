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

  window.CZUI = { el, icon, getPath, setPath, toast, call, clone };
})();
