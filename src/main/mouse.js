'use strict';

const POLL_MS = 8;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const KEY_DOWN_BIT = 0x8000;

/**
 * Global mouse button poller via user32 GetAsyncKeyState (works while games have focus).
 * Returns null-safe API; `available` false when FFI cannot load.
 * @param {ReturnType<import('./logger').createLogger>} log
 */
function createMousePoller(log) {
  let getKey = null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    getKey = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    log.info('mouse poller ready');
  } catch (err) {
    log.error('mouse poller unavailable (firing/right-click features disabled)', { error: err.message });
  }

  let timer = null;
  let last = { left: false, right: false };

  function read() {
    try {
      return {
        left: (getKey(VK_LBUTTON) & KEY_DOWN_BIT) !== 0,
        right: (getKey(VK_RBUTTON) & KEY_DOWN_BIT) !== 0,
      };
    } catch (err) {
      log.error('GetAsyncKeyState failed, stopping poller', { error: err.message });
      stop();
      return last;
    }
  }

  /** Start polling; cb({left, right}, prev) fires only on change. Idempotent. */
  function start(cb) {
    if (!getKey || timer) return;
    last = read();
    timer = setInterval(() => {
      const now = read();
      if (now.left !== last.left || now.right !== last.right) {
        const prev = last;
        last = now;
        cb(now, prev);
      }
    }, POLL_MS);
    log.info('mouse polling started');
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    last = { left: false, right: false };
    log.info('mouse polling stopped');
  }

  return { available: !!getKey, start, stop, isRunning: () => !!timer };
}

module.exports = { createMousePoller };
