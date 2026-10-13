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
  // Console mirroring stops for good once stdout/stderr break (e.g. the launching terminal was
  // closed → EPIPE). Writing again would throw, get logged, throw… and spin a CPU core.
  let consoleOk = true;
  const dropConsole = () => {
    consoleOk = false;
  };
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') stream.on('error', dropConsole);
  }

  function toConsole(level, line) {
    if (!consoleOk) return;
    try {
      (level === 'ERROR' ? console.error : console.log)(line);
    } catch {
      dropConsole();
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    fileOk = false;
    toConsole('ERROR', `[logger] cannot create log dir ${dir}: ${err.message}`);
  }

  function rotateIfNeeded() {
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (err) {
      if (err.code !== 'ENOENT') toConsole('ERROR', `[logger] rotate failed: ${err.message}`);
    }
  }

  function write(level, msg, ctx) {
    const line = `${new Date().toISOString()} ${level} ${msg}${ctx ? ' ' + safeJson(ctx) : ''}`;
    toConsole(level, line);
    if (!fileOk) return;
    try {
      rotateIfNeeded();
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch (err) {
      fileOk = false;
      toConsole('ERROR', `[logger] write failed, file logging disabled: ${err.message}`);
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
