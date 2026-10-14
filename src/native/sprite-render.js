/* Hidden renderer page for the native app: pulls jobs, renders sprite sets, sends them back raw. */
(function () {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  let running = false;

  async function renderOne(job) {
    try {
      const bytes = await CzSpriteExport.buildSpriteSet(job.crosshair, job.scale);
      await invoke('sprite_result', bytes, { headers: { 'x-job-key': job.key } });
    } catch (err) {
      await invoke('sprite_failed', { key: job.key, error: String((err && err.message) || err) });
    }
  }

  async function runJobs() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const jobs = await invoke('sprite_jobs');
        if (!jobs.length) break;
        for (const job of jobs) await renderOne(job);
      }
    } catch (err) {
      console.error('sprite job loop failed', err);
    } finally {
      running = false;
    }
    await invoke('sprite_idle');
  }

  window.czRunJobs = runJobs;
  runJobs();
})();
