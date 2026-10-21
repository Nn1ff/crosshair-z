'use strict';

/* Local CrossY-derived samples. Lazy, bounded playback; no sounds on startup or hover. */
(function () {
  const KEY = 'cz.uiSounds';
  const DEFAULTS = { enabled: true, volume: 0.35 };
  const FILES = {
    tab: ['tab-1', 'tab-2', 'tab-3', 'tab-4'],
    click: ['click-1', 'click-2'],
    on: ['toggle-on'], off: ['toggle-off'],
    high: ['adjust-high'], low: ['adjust-low'],
  };
  let prefs = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && typeof saved.enabled === 'boolean') prefs.enabled = saved.enabled;
    if (saved && Number.isFinite(saved.volume)) prefs.volume = Math.max(0, Math.min(1, saved.volume));
  } catch { /* Storage may be unavailable; the controls still work for this window. */ }
  const players = new Map();
  const last = new Map();
  const positions = new Map();
  let lastAny = -Infinity;

  function stop() {
    for (const pool of players.values()) for (const audio of pool) audio.pause();
  }

  function setPreferences(patch) {
    if (typeof patch.enabled === 'boolean') prefs.enabled = patch.enabled;
    if (Number.isFinite(patch.volume)) prefs.volume = Math.max(0, Math.min(1, patch.volume));
    for (const pool of players.values()) for (const audio of pool) audio.volume = prefs.volume;
    if (!prefs.enabled || !prefs.volume) stop();
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* Optional persistence. */ }
  }

  function play(kind) {
    if (!prefs.enabled || prefs.volume === 0 || !FILES[kind] || document.hidden) return;
    const now = performance.now();
    const group = kind === 'high' || kind === 'low' ? 'adjust' : kind;
    if (now - lastAny < 45 || now - (last.get(group) ?? -Infinity) < (group === 'adjust' ? 100 : 70)) return;
    lastAny = now;
    last.set(group, now);
    const variants = FILES[kind];
    const position = positions.get(kind) || 0;
    positions.set(kind, position + 1);
    const file = variants[position % variants.length];
    let pool = players.get(file);
    if (!pool) {
      pool = [new Audio(`sounds/${file}.wav`), new Audio(`sounds/${file}.wav`)];
      players.set(file, pool);
    }
    const audio = pool.find(a => a.paused || a.ended) || pool[0];
    // Repeated feedback replaces the previous tick instead of building a wall of sound.
    if (group === 'adjust') {
      for (const file of ['adjust-high', 'adjust-low']) {
        for (const player of players.get(file) || []) player.pause();
      }
    }
    audio.pause();
    audio.currentTime = 0;
    audio.volume = prefs.volume;
    const playing = audio.play();
    if (playing) playing.catch(() => {}); // A missing output device never interrupts editing.
  }

  document.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button || button.disabled || button.closest('.cz-wc') || button.id === 'soundPreview') return;
    if (button.matches('.rail-btn, .tab, [data-goto]')) {
      if (!button.classList.contains('active')) play('tab');
    } else play('click');
  }, true); // Read the previous active state before navigation updates the rail.
  document.addEventListener('change', e => {
    if (e.target.matches('input[type=checkbox]') && e.target.id !== 'uiSoundsEnabled') {
      play(e.target.checked ? 'on' : 'off');
    }
  });
  const values = new WeakMap();
  document.addEventListener('input', e => {
    const input = e.target;
    if (!input.matches('input[type=range]') || input.id === 'uiSoundVolume') return;
    const value = Number(input.value);
    play(value < (values.get(input) ?? value) ? 'low' : 'high');
    values.set(input, value);
  });
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.CZSfx = Object.freeze({ play, setPreferences, getPreferences: () => ({ ...prefs }) });
})();
