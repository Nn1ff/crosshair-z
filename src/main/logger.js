'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 1024 * 1024;
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

/**
 * Create file+console logger with single-file rotation (.1 backup).
 * @param {string} dir log directory
 * @param {string} name file base name
 */
function createLogger(dir, name) {
  const file = path.join(dir, `${name}.log`);
  let fileOk = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    fileOk = false;
    console.error('[logger] cannot create log dir', dir, err);
  }

  function rotateIfNeeded() {
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[logger] rotate failed', err);
    }
  }

  function write(level, msg, ctx) {
    const line = `${new Date().toISOString()} ${level} ${msg}${ctx ? ' ' + safeJson(ctx) : ''}`;
    (level === 'ERROR' ? console.error : console.log)(line);
    if (!fileOk) return;
    try {
      rotateIfNeeded();
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch (err) {
      fileOk = false;
      console.error('[logger] write failed, file logging disabled', err);
    }
  }

  const api = {};
  for (const lvl of LEVELS) api[lvl.toLowerCase()] = (msg, ctx) => write(lvl, msg, ctx);
  api.file = file;
  return api;
}

function safeJson(v) {
  if (v instanceof Error) return JSON.stringify({ message: v.message, stack: v.stack });
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

module.exports = { createLogger };
