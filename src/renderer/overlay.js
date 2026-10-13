'use strict';

/* Overlay renderer: draws active crosshair at physical-pixel resolution, animates firing. */
(function () {
  const C = CrosshairCore;
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const anim = new C.FireAnimator();
  let current = null;
  let scale = 1;
  let rafId = 0;
  let lastTs = 0;

  function render() {
    if (!current) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    try {
      C.drawCrosshair(ctx, current, w / 2, h / 2, { scale, fire: anim.levels });
    } catch (err) {
      console.error('overlay draw failed', err);
    }
  }

  function frame(ts) {
    const dt = lastTs ? Math.min(100, ts - lastTs) : 16;
    lastTs = ts;
    const moving = current ? anim.step(dt, current) : false;
    render();
    rafId = moving ? requestAnimationFrame(frame) : 0;
    if (!moving) lastTs = 0;
  }

  function kick() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  window.cz.on('overlay:render', (data) => {
    current = C.sanitizeCrosshair(data && data.crosshair);
    scale = (data && data.scale) || 1;
    anim.setFiring(!!(data && data.firing));
    // missing flag (older main) counts as visible
    canvas.style.visibility = data && data.visible === false ? 'hidden' : 'visible';
    render();
    kick();
  });
  window.cz.on('overlay:fire', (on) => {
    anim.setFiring(on);
    kick();
  });
  C.onImageLoaded(render);
  window.addEventListener('resize', render);
})();
