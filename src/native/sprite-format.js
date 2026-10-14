/**
 * Crosshair Z sprite set binary format (shared with native/app/src/sprites/codec.rs).
 * UMD: used by the native renderer page (<script>) and node tests (require).
 *
 * Little endian:
 *   "CZSP" | u16 version=1 | u16 0 | u32 sizePx | u32 layerCount
 *   per layer: u8 fire | 3×u8 0 | f32 speedMs | u32 frameCount
 *     per frame: i32 x | i32 y | u32 w | u32 h | w·h·4 bytes BGRA premultiplied
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CzSpriteFormat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAGIC = [0x43, 0x5a, 0x53, 0x50]; // "CZSP"
  const VERSION = 1;
  const HEADER_BYTES = 16;
  const LAYER_HEADER_BYTES = 12;
  const FRAME_HEADER_BYTES = 16;

  /**
   * Straight RGBA (canvas getImageData) → premultiplied BGRA.
   * @param {Uint8ClampedArray|Uint8Array} rgba
   * @returns {Uint8Array}
   */
  function rgbaToBgraPremul(rgba) {
    const out = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      out[i] = Math.round((rgba[i + 2] * a) / 255);
      out[i + 1] = Math.round((rgba[i + 1] * a) / 255);
      out[i + 2] = Math.round((rgba[i] * a) / 255);
      out[i + 3] = a;
    }
    return out;
  }

  /**
   * @param {{sizePx: number, layers: {fireSpeedMs: number|null, frames: {x:number,y:number,w:number,h:number,bgra:Uint8Array}[]}[]}} set
   * @returns {Uint8Array}
   */
  function encodeSpriteSet(set) {
    let total = HEADER_BYTES;
    for (const layer of set.layers) {
      total += LAYER_HEADER_BYTES;
      for (const f of layer.frames) {
        if (f.bgra.length !== f.w * f.h * 4) throw new Error(`frame pixel length ${f.bgra.length} != ${f.w}x${f.h}x4`);
        total += FRAME_HEADER_BYTES + f.bgra.length;
      }
    }
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    let o = 0;
    MAGIC.forEach((b) => (buf[o++] = b));
    dv.setUint16(o, VERSION, true);
    dv.setUint16(o + 2, 0, true);
    dv.setUint32(o + 4, set.sizePx, true);
    dv.setUint32(o + 8, set.layers.length, true);
    o += 12;
    for (const layer of set.layers) {
      const fire = layer.fireSpeedMs != null;
      buf[o] = fire ? 1 : 0;
      dv.setFloat32(o + 4, fire ? layer.fireSpeedMs : 0, true);
      dv.setUint32(o + 8, layer.frames.length, true);
      o += LAYER_HEADER_BYTES;
      for (const f of layer.frames) {
        dv.setInt32(o, f.x, true);
        dv.setInt32(o + 4, f.y, true);
        dv.setUint32(o + 8, f.w, true);
        dv.setUint32(o + 12, f.h, true);
        o += FRAME_HEADER_BYTES;
        buf.set(f.bgra, o);
        o += f.bgra.length;
      }
    }
    return buf;
  }

  return { VERSION, rgbaToBgraPremul, encodeSpriteSet };
});
