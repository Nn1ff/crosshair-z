'use strict';

/* Generates assets/icon.png (256) and assets/tray.png (32) without deps. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ACCENT = [124, 196, 255];
const DARK = [25, 28, 34];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rounded dark tile with accent ring + cross + "gap". */
function iconPixel(x, y, s) {
  const c = s / 2;
  const dx = x - c, dy = y - c;
  const r = Math.hypot(dx, dy);
  const u = s / 32;
  const corner = 6 * u;
  const qx = Math.max(Math.abs(dx) - (c - corner), 0), qy = Math.max(Math.abs(dy) - (c - corner), 0);
  if (Math.hypot(qx, qy) > corner) return [0, 0, 0, 0];
  const ring = Math.abs(r - 10 * u) < 1.3 * u;
  const arm = (Math.abs(dx) < 1.2 * u && Math.abs(dy) > 4 * u && Math.abs(dy) < 13 * u) ||
              (Math.abs(dy) < 1.2 * u && Math.abs(dx) > 4 * u && Math.abs(dx) < 13 * u);
  const dot = r < 1.6 * u;
  return ring || arm || dot ? [...ACCENT, 255] : [...DARK, 255];
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(256, iconPixel));
fs.writeFileSync(path.join(out, 'tray.png'), png(32, iconPixel));
console.log('icons written to', out);
