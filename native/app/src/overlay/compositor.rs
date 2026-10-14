//! Firing animation + layer compositing for pre-rendered sprites.
//! `FireAnimator` is a port of `FireAnimator` in `crosshair-core.js`; `compose` blends the frame
//! of each layer's current level with premultiplied source-over, matching canvas layer order.

use super::super::sprites::codec::SpriteSet;

/// Per-layer firing level animator: rises toward 1 while firing, falls to 0 after.
#[derive(Clone, Debug, Default)]
pub struct FireAnimator {
    levels: Vec<f32>,
    firing: bool,
}

impl FireAnimator {
    pub fn new() -> FireAnimator {
        FireAnimator::default()
    }

    pub fn set_firing(&mut self, on: bool) {
        self.firing = on;
    }

    pub fn firing(&self) -> bool {
        self.firing
    }

    pub fn levels(&self) -> &[f32] {
        &self.levels
    }

    /// Forget levels (new sprite set): the new crosshair starts at rest.
    pub fn reset(&mut self) {
        self.levels.clear();
    }

    /// Advance by `dt_ms`. Returns true while any layer is still moving.
    pub fn step(&mut self, dt_ms: f32, set: &SpriteSet) -> bool {
        self.levels.resize(set.layers.len(), 0.0);
        let mut moving = false;
        for (level, layer) in self.levels.iter_mut().zip(&set.layers) {
            let Some(speed) = layer.fire_speed_ms else {
                *level = 0.0;
                continue;
            };
            let target = if self.firing { 1.0 } else { 0.0 };
            if *level == target {
                continue;
            }
            let delta = dt_ms / speed;
            *level = if target > *level { (*level + delta).min(1.0) } else { (*level - delta).max(0.0) };
            if *level != target {
                moving = true;
            }
        }
        moving
    }
}

/// Frame to show for `level` (0..1) in a layer with `n` frames.
pub fn frame_index(level: f32, n: usize) -> usize {
    if n <= 1 {
        return 0;
    }
    let i = (level.clamp(0.0, 1.0) * (n - 1) as f32).round() as usize;
    i.min(n - 1)
}

/// x / 255 rounded to nearest, exact for 0..=65025.
#[inline]
fn div255(x: u32) -> u32 {
    let t = x + 128;
    (t + (t >> 8)) >> 8
}

/// Premultiplied source-over of one BGRA pixel.
#[inline]
pub fn src_over(src: u32, dst: u32) -> u32 {
    let sa = src >> 24;
    if sa == 255 || dst == 0 {
        return src;
    }
    if sa == 0 && src == 0 {
        return dst;
    }
    let inv = 255 - sa;
    let mut out = 0u32;
    for shift in [0u32, 8, 16, 24] {
        let s = (src >> shift) & 0xFF;
        let d = (dst >> shift) & 0xFF;
        let c = (s + div255(d * inv)).min(255);
        out |= c << shift;
    }
    out
}

/// Draw all layers at their levels into `out` (`size_px²` pixels, cleared first).
pub fn compose(set: &SpriteSet, levels: &[f32], out: &mut [u32]) {
    let size = set.size_px as usize;
    debug_assert_eq!(out.len(), size * size);
    out.fill(0);
    for (i, layer) in set.layers.iter().enumerate() {
        let level = levels.get(i).copied().unwrap_or(0.0);
        let Some(frame) = layer.frames.get(frame_index(level, layer.frames.len())) else { continue };
        let (fw, fx, fy) = (frame.w as usize, frame.x as usize, frame.y as usize);
        for row in 0..frame.h as usize {
            let src = &frame.px[row * fw..(row + 1) * fw];
            let start = (fy + row) * size + fx;
            for (d, s) in out[start..start + fw].iter_mut().zip(src) {
                *d = src_over(*s, *d);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sprites::codec::{Frame, SpriteLayer};

    fn set_with(fire: Option<f32>, frames: usize) -> SpriteSet {
        let frames = (0..frames).map(|i| Frame { x: 0, y: 0, w: 1, h: 1, px: vec![0xFF00_0000 | i as u32] }).collect();
        SpriteSet { size_px: 2, layers: vec![SpriteLayer { fire_speed_ms: fire, frames }] }
    }

    #[test]
    fn animator_rises_and_falls_at_speed() {
        let set = set_with(Some(100.0), 33);
        let mut a = FireAnimator::new();
        assert!(!a.step(16.0, &set), "at rest nothing moves");
        a.set_firing(true);
        assert!(a.step(50.0, &set));
        assert!((a.levels()[0] - 0.5).abs() < 1e-6);
        assert!(!a.step(60.0, &set), "reaches 1 and stops");
        assert_eq!(a.levels()[0], 1.0);
        a.set_firing(false);
        assert!(a.step(25.0, &set));
        assert!((a.levels()[0] - 0.75).abs() < 1e-6);
        assert!(!a.step(1000.0, &set));
        assert_eq!(a.levels()[0], 0.0);
    }

    #[test]
    fn non_firing_layer_stays_at_zero() {
        let set = set_with(None, 1);
        let mut a = FireAnimator::new();
        a.set_firing(true);
        assert!(!a.step(16.0, &set));
        assert_eq!(a.levels(), &[0.0]);
    }

    #[test]
    fn frame_index_rounds() {
        assert_eq!(frame_index(0.0, 1), 0);
        assert_eq!(frame_index(1.0, 1), 0);
        assert_eq!(frame_index(0.5, 33), 16);
        assert_eq!(frame_index(1.0, 33), 32);
        assert_eq!(frame_index(0.49, 3), 1);
        assert_eq!(frame_index(2.0, 33), 32);
        assert_eq!(frame_index(-1.0, 33), 0);
    }

    #[test]
    fn div255_exact() {
        for x in 0..=65025u32 {
            assert_eq!(div255(x), (x as f64 / 255.0).round() as u32, "{x}");
        }
    }

    #[test]
    fn src_over_cases() {
        let red = 0xFFFF_0000;
        let half_blue = 0x8000_0080; // 50 % blue premultiplied
        assert_eq!(src_over(red, 0), red);
        assert_eq!(src_over(0, red), red);
        assert_eq!(src_over(red, half_blue), red);
        // 50 % blue over opaque red → a=255, r=round(255*127/255)=127, b=128
        assert_eq!(src_over(half_blue, red), 0xFF7F_0080);
    }

    #[test]
    fn compose_places_frames_by_level() {
        let set = SpriteSet {
            size_px: 3,
            layers: vec![
                SpriteLayer { fire_speed_ms: None, frames: vec![Frame { x: 0, y: 0, w: 3, h: 1, px: vec![0xFF00_00FF; 3] }] },
                SpriteLayer {
                    fire_speed_ms: Some(100.0),
                    frames: vec![
                        Frame { x: 1, y: 1, w: 1, h: 1, px: vec![0xFFFF_0000] },
                        Frame { x: 2, y: 2, w: 1, h: 1, px: vec![0xFF00_FF00] },
                    ],
                },
            ],
        };
        let mut out = vec![0u32; 9];
        compose(&set, &[0.0, 0.0], &mut out);
        assert_eq!(out, vec![0xFF00_00FF, 0xFF00_00FF, 0xFF00_00FF, 0, 0xFFFF_0000, 0, 0, 0, 0]);
        compose(&set, &[0.0, 1.0], &mut out);
        assert_eq!(out, vec![0xFF00_00FF, 0xFF00_00FF, 0xFF00_00FF, 0, 0, 0, 0, 0, 0xFF00_FF00]);
    }
}
