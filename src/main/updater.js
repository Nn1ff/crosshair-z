'use strict';

/*
 * Optional update check against GitHub releases. Never required for the app to work:
 * every failure is logged and reported as "no update"; nothing runs in the background.
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const RELEASES_URL = 'https://api.github.com/repos/Nn1ff/crosshair-z/releases/latest';
const ASSET_NAME = 'Crosshair-Z.exe';
const DOWNLOAD_HOST_PREFIX = 'https://github.com/';
const CHECK_TIMEOUT_MS = 10000;
const CHECK_RETRIES = 2;
const RETRY_BASE_MS = 2000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ASSET_BYTES = 300 * 1024 * 1024;
const VERSION_RE = /^v?(\d+(?:\.\d+){0,3})$/;

/** Compare dotted versions. Returns >0 when a is newer than b. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Extract the portable exe asset from a GitHub "latest release" payload.
 * @returns {{version: string, url: string, size: number, page: string} | null}
 */
function parseRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const m = typeof json.tag_name === 'string' ? VERSION_RE.exec(json.tag_name.trim()) : null;
  if (!m) return null;
  const asset = Array.isArray(json.assets) ? json.assets.find((a) => a && a.name === ASSET_NAME) : null;
  if (!asset || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith(DOWNLOAD_HOST_PREFIX)) return null;
  const size = Number(asset.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_ASSET_BYTES) return null;
  const page = typeof json.html_url === 'string' && json.html_url.startsWith(DOWNLOAD_HOST_PREFIX) ? json.html_url : null;
  return { version: m[1], url: asset.browser_download_url, size, page };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transient = worth retrying (network error, timeout, 5xx). */
class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
    this.transient = status >= 500;
  }
}

async function fetchJson(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Crosshair-Z' },
    });
    if (res.status === 404) return null; // no published release yet
    if (!res.ok) throw new HttpError(res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask GitHub for the latest release. Never throws.
 * @param {{fetchFn: typeof fetch, currentVersion: string, log: object, retryBaseMs?: number}} opts
 * @returns {Promise<{version: string, url: string, size: number, page: string|null} | null>} newer release or null
 */
async function checkForUpdate({ fetchFn, currentVersion, log, retryBaseMs = RETRY_BASE_MS }) {
  const started = Date.now();
  for (let attempt = 0; attempt <= CHECK_RETRIES; attempt++) {
    try {
      const json = await fetchJson(fetchFn, RELEASES_URL, CHECK_TIMEOUT_MS);
      const rel = json && parseRelease(json);
      if (json && !rel) log.warn('update check: unusable release payload', { tag: json.tag_name });
      const newer = rel && compareVersions(rel.version, currentVersion) > 0 ? rel : null;
      log.info('update check done', { current: currentVersion, latest: rel && rel.version, newer: !!newer, ms: Date.now() - started });
      return newer;
    } catch (err) {
      const transient = !(err instanceof HttpError) || err.transient;
      log.warn('update check failed', { attempt, transient, error: err.message });
      if (!transient || attempt === CHECK_RETRIES) return null;
      await sleep(retryBaseMs * 2 ** attempt);
    }
  }
  return null;
}

/**
 * Stream the release exe next to the running one as "Crosshair Z <version>.exe".
 * Writes to a .part file and renames only after the size matches. Throws on failure.
 * @returns {Promise<string>} path of the downloaded exe
 */
async function downloadUpdate({ fetchFn, release, dir, log, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  if (!release || !VERSION_RE.test(release.version)) throw new Error('invalid release');
  const dest = path.join(dir, `Crosshair Z ${release.version}.exe`);
  const part = `${dest}.part`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  log.info('update download start', { version: release.version, dest });
  try {
    const res = await fetchFn(release.url, { signal: ctrl.signal, headers: { 'User-Agent': 'Crosshair-Z' } });
    if (!res.ok || !res.body) throw new HttpError(res.status);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part), { signal: ctrl.signal });
    const { size } = await fs.promises.stat(part);
    if (size !== release.size) throw new Error(`size mismatch: got ${size}, expected ${release.size}`);
    await fs.promises.rename(part, dest);
    log.info('update download done', { dest, bytes: size, ms: Date.now() - started });
    return dest;
  } catch (err) {
    await fs.promises.rm(part, { force: true }).catch((rmErr) => log.warn('update cleanup failed', { error: rmErr.message }));
    log.error('update download failed', { version: release.version, error: err.message });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { compareVersions, parseRelease, checkForUpdate, downloadUpdate, RELEASES_URL, ASSET_NAME };
