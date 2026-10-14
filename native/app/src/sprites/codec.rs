//! Sprite set binary format (written by `src/native/sprite-format.js`). See that file for the
//! layout. Decoding validates every limit so a damaged or foreign file can never panic or
//! allocate unbounded memory.

use std::fmt;

pub const MAGIC: &[u8; 4] = b"CZSP";
pub const FORMAT_VERSION: u16 = 1;
pub const MAX_SIZE_PX: u32 = 4096;
pub const MAX_LAYERS: usize = 64;
pub const MAX_FRAMES: usize = 33;
pub const MIN_SPEED_MS: f32 = 20.0;
pub const MAX_SPEED_MS: f32 = 1000.0;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
const HEADER_BYTES: usize = 16;
const LAYER_HEADER_BYTES: usize = 12;
const FRAME_HEADER_BYTES: usize = 16;

/// One pre-rendered image of a layer at one firing level, cropped to its visible pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// premultiplied BGRA, one u32 per pixel (little endian 0xAARRGGBB), row-major
    pub px: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpriteLayer {
    /// `Some(speed)` when the layer animates while firing
    pub fire_speed_ms: Option<f32>,
    pub frames: Vec<Frame>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpriteSet {
    pub size_px: u32,
    pub layers: Vec<SpriteLayer>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SpriteError {
    TooLarge(usize),
    Truncated,
    BadMagic,
    Version(u16),
    Size(u32),
    LayerCount(usize),
    FrameCount { layer: usize, count: usize },
    Speed { layer: usize },
    FrameBounds { layer: usize, frame: usize },
    TrailingBytes(usize),
}

impl fmt::Display for SpriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid sprite set: {self:?}")
    }
}

impl std::error::Error for SpriteError {}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], SpriteError> {
        let end = self.pos.checked_add(n).ok_or(SpriteError::Truncated)?;
        let s = self.buf.get(self.pos..end).ok_or(SpriteError::Truncated)?;
        self.pos = end;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, SpriteError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, SpriteError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, SpriteError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32, SpriteError> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn f32(&mut self) -> Result<f32, SpriteError> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}

impl SpriteSet {
    pub fn decode(buf: &[u8]) -> Result<SpriteSet, SpriteError> {
        if buf.len() > MAX_BYTES {
            return Err(SpriteError::TooLarge(buf.len()));
        }
        let mut r = Reader { buf, pos: 0 };
        if r.take(4)? != MAGIC {
            return Err(SpriteError::BadMagic);
        }
        let version = r.u16()?;
        if version != FORMAT_VERSION {
            return Err(SpriteError::Version(version));
        }
        r.u16()?;
        let size_px = r.u32()?;
        if size_px == 0 || size_px > MAX_SIZE_PX {
            return Err(SpriteError::Size(size_px));
        }
        let layer_count = r.u32()? as usize;
        if layer_count > MAX_LAYERS {
            return Err(SpriteError::LayerCount(layer_count));
        }
        let mut layers = Vec::with_capacity(layer_count);
        for li in 0..layer_count {
            let fire = r.u8()? != 0;
            r.take(3)?;
            let speed = r.f32()?;
            let count = r.u32()? as usize;
            if count == 0 || count > MAX_FRAMES || (fire && count < 2) {
                return Err(SpriteError::FrameCount { layer: li, count });
            }
            if fire && !(MIN_SPEED_MS..=MAX_SPEED_MS).contains(&speed) {
                return Err(SpriteError::Speed { layer: li });
            }
            let mut frames = Vec::with_capacity(count);
            for fi in 0..count {
                let (x, y, w, h) = (r.i32()?, r.i32()?, r.u32()?, r.u32()?);
                let inside = x >= 0 && y >= 0 && (x as u64 + w as u64) <= size_px as u64 && (y as u64 + h as u64) <= size_px as u64;
                if !inside {
                    return Err(SpriteError::FrameBounds { layer: li, frame: fi });
                }
                let bytes = r.take(w as usize * h as usize * 4)?;
                let px = bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                frames.push(Frame { x, y, w, h, px });
            }
            layers.push(SpriteLayer { fire_speed_ms: fire.then_some(speed), frames });
        }
        if r.pos != buf.len() {
            return Err(SpriteError::TrailingBytes(buf.len() - r.pos));
        }
        Ok(SpriteSet { size_px, layers })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_BYTES + self.layers.iter().map(|l| LAYER_HEADER_BYTES + l.frames.iter().map(|f| FRAME_HEADER_BYTES + f.px.len() * 4).sum::<usize>()).sum::<usize>());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&self.size_px.to_le_bytes());
        out.extend_from_slice(&(self.layers.len() as u32).to_le_bytes());
        for l in &self.layers {
            out.push(u8::from(l.fire_speed_ms.is_some()));
            out.extend_from_slice(&[0, 0, 0]);
            out.extend_from_slice(&l.fire_speed_ms.unwrap_or(0.0).to_le_bytes());
            out.extend_from_slice(&(l.frames.len() as u32).to_le_bytes());
            for f in &l.frames {
                out.extend_from_slice(&f.x.to_le_bytes());
                out.extend_from_slice(&f.y.to_le_bytes());
                out.extend_from_slice(&f.w.to_le_bytes());
                out.extend_from_slice(&f.h.to_le_bytes());
                for p in &f.px {
                    out.extend_from_slice(&p.to_le_bytes());
                }
            }
        }
        out
    }

    /// Small built-in crosshair used when rendering is impossible (e.g. WebView2 missing):
    /// white 4×4 dot with a 1 px dark outline, centered in a 32 px canvas.
    pub fn fallback() -> SpriteSet {
        const SIZE: u32 = 32;
        const DOT: u32 = 6; // 4 px dot + 1 px outline each side
        const WHITE: u32 = 0xFFFF_FFFF;
        const OUTLINE: u32 = 0xC000_0000; // black at 75 % (premultiplied)
        let px = (0..DOT * DOT)
            .map(|i| {
                let (x, y) = (i % DOT, i / DOT);
                if x == 0 || y == 0 || x == DOT - 1 || y == DOT - 1 {
                    OUTLINE
                } else {
                    WHITE
                }
            })
            .collect();
        let at = ((SIZE - DOT) / 2) as i32;
        SpriteSet { size_px: SIZE, layers: vec![SpriteLayer { fire_speed_ms: None, frames: vec![Frame { x: at, y: at, w: DOT, h: DOT, px }] }] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same vector is asserted in test/sprite-format.test.js.
    const SHARED_VECTOR_HEX: &str = concat!(
        "435a53500100000004000000020000000000000000000000010000000100000001000000010000000100000001020304",
        "010000000000f0420200000000000000000000000000000000000000020000000200000001000000010000000a141e28"
    );

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn shared() -> SpriteSet {
        SpriteSet {
            size_px: 4,
            layers: vec![
                SpriteLayer { fire_speed_ms: None, frames: vec![Frame { x: 1, y: 1, w: 1, h: 1, px: vec![0x0403_0201] }] },
                SpriteLayer {
                    fire_speed_ms: Some(120.0),
                    frames: vec![Frame { x: 0, y: 0, w: 0, h: 0, px: vec![] }, Frame { x: 2, y: 2, w: 1, h: 1, px: vec![0x281e_140a] }],
                },
            ],
        }
    }

    #[test]
    fn decodes_shared_vector() {
        assert_eq!(SpriteSet::decode(&hex(SHARED_VECTOR_HEX)).unwrap(), shared());
    }

    #[test]
    fn encodes_shared_vector() {
        assert_eq!(shared().encode(), hex(SHARED_VECTOR_HEX));
    }

    #[test]
    fn every_truncation_is_an_error() {
        let full = hex(SHARED_VECTOR_HEX);
        for n in 0..full.len() {
            assert!(SpriteSet::decode(&full[..n]).is_err(), "prefix {n}");
        }
    }

    #[test]
    fn trailing_bytes_rejected() {
        let mut b = hex(SHARED_VECTOR_HEX);
        b.push(0);
        assert_eq!(SpriteSet::decode(&b), Err(SpriteError::TrailingBytes(1)));
    }

    #[test]
    fn header_limits() {
        let good = shared();
        let mut b = good.encode();
        b[0] = b'X';
        assert_eq!(SpriteSet::decode(&b), Err(SpriteError::BadMagic));

        let mut b = good.encode();
        b[4] = 2;
        assert_eq!(SpriteSet::decode(&b), Err(SpriteError::Version(2)));

        for size in [0u32, MAX_SIZE_PX + 1] {
            let mut s = good.clone();
            s.size_px = size;
            assert_eq!(SpriteSet::decode(&s.encode()), Err(SpriteError::Size(size)));
        }

        let mut s = good.clone();
        s.layers = vec![good.layers[0].clone(); MAX_LAYERS + 1];
        assert_eq!(SpriteSet::decode(&s.encode()), Err(SpriteError::LayerCount(MAX_LAYERS + 1)));
    }

    #[test]
    fn layer_limits() {
        let good = shared();
        let mut s = good.clone();
        s.layers[1].frames.truncate(1);
        assert_eq!(SpriteSet::decode(&s.encode()), Err(SpriteError::FrameCount { layer: 1, count: 1 }), "firing layer needs ≥ 2 frames");

        let mut s = good.clone();
        s.layers[0].frames = vec![];
        assert_eq!(SpriteSet::decode(&s.encode()), Err(SpriteError::FrameCount { layer: 0, count: 0 }));

        let mut s = good.clone();
        s.layers[1].frames = vec![s.layers[1].frames[0].clone(); MAX_FRAMES + 1];
        assert!(matches!(SpriteSet::decode(&s.encode()), Err(SpriteError::FrameCount { layer: 1, .. })));

        for speed in [19.0, 1001.0, f32::NAN] {
            let mut s = good.clone();
            s.layers[1].fire_speed_ms = Some(speed);
            assert_eq!(SpriteSet::decode(&s.encode()), Err(SpriteError::Speed { layer: 1 }));
        }
    }

    #[test]
    fn frame_must_fit_canvas() {
        for (x, y, w, h) in [(-1, 0, 1, 1), (0, -1, 1, 1), (4, 0, 1, 1), (3, 3, 2, 1), (0, 0, 5, 0)] {
            let mut s = shared();
            s.layers[0].frames[0] = Frame { x, y, w, h, px: vec![0; (w * h) as usize] };
            assert_eq!(SpriteSet::decode(&s.encode()), Err(SpriteError::FrameBounds { layer: 0, frame: 0 }), "{x},{y},{w},{h}");
        }
    }

    #[test]
    fn huge_input_rejected_before_parsing() {
        assert_eq!(SpriteSet::decode(&vec![0u8; MAX_BYTES + 1]), Err(SpriteError::TooLarge(MAX_BYTES + 1)));
    }

    #[test]
    fn fallback_is_valid_and_centered() {
        let f = SpriteSet::fallback();
        let back = SpriteSet::decode(&f.encode()).unwrap();
        assert_eq!(back, f);
        let fr = &f.layers[0].frames[0];
        assert_eq!((fr.x * 2 + fr.w as i32) as u32, f.size_px);
    }
}
