//! Overlay controller: owns the current sprite set and firing animation on its own thread, composes
//! frames and hands them to a sink (the layered window). A frame is sent only when what is shown
//! changes (or on `refresh`); it ticks every 8 ms only while a visible layer moves.

pub mod compositor;
pub mod monitors;
pub mod window;

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::logger;
use crate::sprites::codec::SpriteSet;
use compositor::{compose, frame_index, FireAnimator};
use window::{WindowCmd, WindowHandle};

const TICK: Duration = Duration::from_millis(8);
const MAX_STEP_MS: f32 = 100.0;

/// Where finished frames go.
pub trait FrameSink: Send {
    fn show(&mut self, x: i32, y: i32, size: u32, pixels: Vec<u32>);
}

impl FrameSink for WindowHandle {
    fn show(&mut self, x: i32, y: i32, size: u32, pixels: Vec<u32>) {
        self.send(WindowCmd::Show { x, y, size, pixels });
    }
}

enum Msg {
    Sprites { set: Arc<SpriteSet>, x: i32, y: i32 },
    Visible(bool),
    Firing(bool),
    /// draw the current scene again (the window may have been moved by Windows)
    Refresh,
    Stop,
}

pub struct Overlay {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
}

struct Scene {
    set: Option<Arc<SpriteSet>>,
    x: i32,
    y: i32,
    visible: bool,
    anim: FireAnimator,
    /// the firing animation runs: the thread wakes every `TICK`
    moving: bool,
    last_step: Instant,
    buf: Vec<u32>,
    /// frame index per layer before the current tick's step (reused: ticks allocate nothing)
    frames: Vec<usize>,
}

impl Scene {
    fn new() -> Scene {
        Scene {
            set: None,
            x: 0,
            y: 0,
            visible: true,
            anim: FireAnimator::new(),
            moving: false,
            last_step: Instant::now(),
            buf: Vec::new(),
            frames: Vec::new(),
        }
    }

    /// New sprites or position. A new set starts at rest (rising while firing); the same set at
    /// the same place draws nothing.
    fn set_sprites(&mut self, set: Arc<SpriteSet>, x: i32, y: i32, sink: &mut dyn FrameSink) {
        let same = self.set.as_ref().is_some_and(|s| Arc::ptr_eq(s, &set));
        if same && (self.x, self.y) == (x, y) {
            return;
        }
        if !same {
            self.anim.reset();
            self.set = Some(set);
            self.moving = false;
            if self.anim.firing() && self.animates() {
                self.start_moving();
            }
        }
        self.x = x;
        self.y = y;
        self.render(sink);
    }

    fn set_visible(&mut self, visible: bool, sink: &mut dyn FrameSink) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        // no firing frames while hidden; shown again it starts at the current target
        self.snap();
        self.render(sink);
    }

    fn set_firing(&mut self, on: bool) {
        self.anim.set_firing(on);
        if self.animates() {
            self.start_moving();
        } else {
            self.snap(); // hidden or no fire layer: nothing to draw
        }
    }

    /// One animation step; draws only when a layer reaches another frame.
    fn tick(&mut self, sink: &mut dyn FrameSink) {
        let now = Instant::now();
        let dt = ((now - self.last_step).as_secs_f32() * 1000.0).min(MAX_STEP_MS);
        self.last_step = now;
        let Some(set) = self.set.clone() else {
            self.moving = false;
            return;
        };
        self.frames.clear();
        self.frames.extend((0..set.layers.len()).map(|i| shown_frame(&set, self.anim.levels(), i)));
        self.moving = self.anim.step(dt, &set);
        let levels = self.anim.levels();
        if self.frames.iter().enumerate().any(|(i, &before)| shown_frame(&set, levels, i) != before) {
            self.render(sink);
        }
    }

    /// Firing has something to animate on screen.
    fn animates(&self) -> bool {
        self.visible && self.set.as_ref().is_some_and(|s| s.has_firing())
    }

    fn start_moving(&mut self) {
        if !self.moving {
            self.moving = true;
            self.last_step = Instant::now();
        }
    }

    /// Jump every layer to its firing target without drawing the steps in between.
    fn snap(&mut self) {
        if let Some(set) = &self.set {
            self.anim.step(f32::INFINITY, set); // an infinite step reaches every target at once
        }
        self.moving = false;
    }

    fn render(&mut self, sink: &mut dyn FrameSink) {
        let Some(set) = self.set.clone() else { return };
        let n = (set.size_px * set.size_px) as usize;
        self.buf.resize(n, 0);
        if self.visible {
            compose(&set, self.anim.levels(), &mut self.buf);
        } else {
            // keep the window shown but empty: hiding raced with repaint/z-order in 1.x
            self.buf.fill(0);
        }
        sink.show(self.x, self.y, set.size_px, self.buf.clone());
    }
}

/// Frame layer `i` of `set` shows at `levels` (same choice as `compose`).
fn shown_frame(set: &SpriteSet, levels: &[f32], i: usize) -> usize {
    frame_index(levels.get(i).copied().unwrap_or(0.0), set.layers[i].frames.len())
}

impl Overlay {
    pub fn spawn(mut sink: Box<dyn FrameSink>) -> Overlay {
        let (tx, rx) = mpsc::channel::<Msg>();
        let thread = std::thread::Builder::new()
            .name("overlay-anim".into())
            .spawn(move || {
                let mut scene = Scene::new();
                loop {
                    let msg = if scene.moving {
                        match rx.recv_timeout(TICK) {
                            Ok(m) => Some(m),
                            Err(RecvTimeoutError::Timeout) => None,
                            Err(RecvTimeoutError::Disconnected) => Some(Msg::Stop),
                        }
                    } else {
                        Some(rx.recv().unwrap_or(Msg::Stop))
                    };
                    match msg {
                        Some(Msg::Stop) => return,
                        Some(Msg::Sprites { set, x, y }) => scene.set_sprites(set, x, y, sink.as_mut()),
                        Some(Msg::Visible(v)) => scene.set_visible(v, sink.as_mut()),
                        Some(Msg::Firing(on)) => scene.set_firing(on),
                        Some(Msg::Refresh) => scene.render(sink.as_mut()),
                        None => scene.tick(sink.as_mut()),
                    }
                }
            })
            .expect("spawn overlay animation thread");
        Overlay { tx, thread: Some(thread) }
    }

    fn send(&self, msg: Msg) {
        if self.tx.send(msg).is_err() {
            logger::error("overlay animation thread gone", None);
        }
    }

    pub fn set_sprites(&self, set: Arc<SpriteSet>, x: i32, y: i32) {
        self.send(Msg::Sprites { set, x, y });
    }

    pub fn set_visible(&self, visible: bool) {
        self.send(Msg::Visible(visible));
    }

    pub fn set_firing(&self, on: bool) {
        self.send(Msg::Firing(on));
    }

    /// Draw the current scene once more, even though nothing changed (e.g. after a display change
    /// Windows may have moved the window; the frame puts it back). Nothing shown yet: no frame.
    pub fn refresh(&self) {
        self.send(Msg::Refresh);
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sprites::codec::{Frame, SpriteLayer};
    use std::sync::Mutex;

    type Shown = (i32, i32, u32, Vec<u32>);

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<Shown>>>);

    impl FrameSink for Recorder {
        fn show(&mut self, x: i32, y: i32, size: u32, pixels: Vec<u32>) {
            self.0.lock().unwrap().push((x, y, size, pixels));
        }
    }

    impl Recorder {
        fn count(&self) -> usize {
            self.0.lock().unwrap().len()
        }
        fn last(&self) -> Shown {
            self.0.lock().unwrap().last().cloned().unwrap()
        }
    }

    fn firing_set() -> Arc<SpriteSet> {
        Arc::new(SpriteSet {
            size_px: 2,
            layers: vec![SpriteLayer {
                fire_speed_ms: Some(40.0),
                frames: vec![Frame { x: 0, y: 0, w: 1, h: 1, px: vec![0xFF00_0001] }, Frame { x: 1, y: 1, w: 1, h: 1, px: vec![0xFF00_0002] }],
            }],
        })
    }

    fn still_set() -> Arc<SpriteSet> {
        Arc::new(SpriteSet { size_px: 2, layers: vec![SpriteLayer { fire_speed_ms: None, frames: vec![Frame { x: 0, y: 0, w: 1, h: 1, px: vec![0xFF00_0003] }] }] })
    }

    fn wait_until(f: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(2);
        while !f() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn frame_per_change_and_hidden_is_empty() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        let set = firing_set();
        ov.set_sprites(set.clone(), 10, 20);
        wait_until(|| rec.count() == 1);
        let (x, y, size, px) = rec.last();
        assert_eq!((x, y, size), (10, 20, 2));
        assert_eq!(px, vec![0xFF00_0001, 0, 0, 0]);
        ov.set_visible(false);
        wait_until(|| rec.count() == 2);
        assert_eq!(rec.last().3, vec![0; 4]);
        ov.set_visible(false);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(rec.count(), 2, "no frame without a change");
    }

    #[test]
    fn relocating_cached_sprites_keeps_rise_and_decay_running() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        let mut set = (*firing_set()).clone();
        set.layers[0].fire_speed_ms = Some(200.0);
        let set = Arc::new(set);
        ov.set_sprites(set.clone(), 0, 0);
        wait_until(|| rec.count() == 1);

        ov.set_firing(true);
        ov.set_sprites(set.clone(), 10, 20);
        wait_until(|| rec.last().3 == vec![0, 0, 0, 0xFF00_0002]);
        assert_eq!(rec.last().3, vec![0, 0, 0, 0xFF00_0002], "relocation must not freeze the rising animation");
        assert_eq!((rec.last().0, rec.last().1), (10, 20));

        ov.set_firing(false);
        ov.set_sprites(set, 30, 40);
        wait_until(|| rec.last().3 == vec![0xFF00_0001, 0, 0, 0]);
        assert_eq!(rec.last().3, vec![0xFF00_0001, 0, 0, 0], "relocation must not freeze the decaying animation");
        assert_eq!((rec.last().0, rec.last().1), (30, 40));
        std::thread::sleep(Duration::from_millis(250));
        let settled = rec.count();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(rec.count(), settled, "relocation must not keep idle animation ticking");
    }

    #[test]
    fn firing_animates_then_stops_ticking() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        ov.set_sprites(firing_set(), 0, 0);
        wait_until(|| rec.count() == 1);
        ov.set_firing(true);
        wait_until(|| rec.last().3 == vec![0, 0, 0, 0xFF00_0002]);
        assert_eq!(rec.last().3, vec![0, 0, 0, 0xFF00_0002], "reached full level");
        std::thread::sleep(Duration::from_millis(60));
        let settled = rec.count();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(rec.count(), settled, "idle at rest: no more ticks");
        ov.set_firing(false);
        wait_until(|| rec.last().3 == vec![0xFF00_0001, 0, 0, 0]);
        assert_eq!(rec.last().3, vec![0xFF00_0001, 0, 0, 0]);
    }

    #[test]
    fn unchanged_sprites_render_no_extra_frame() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        let set = firing_set();
        ov.set_sprites(set.clone(), 10, 20);
        ov.set_sprites(set.clone(), 10, 20);
        ov.set_visible(true);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(rec.count(), 1, "same sprites at the same place: one frame");
        ov.set_sprites(set, 11, 20);
        wait_until(|| rec.count() == 2);
        assert_eq!(rec.last().0, 11, "a new position still draws");
    }

    #[test]
    fn refresh_redraws_an_unchanged_scene_once() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        ov.refresh();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(rec.count(), 0, "nothing to show yet: no frame");
        let set = still_set();
        ov.set_sprites(set.clone(), 10, 20);
        wait_until(|| rec.count() == 1);
        ov.set_sprites(set, 10, 20); // what apply() sends after a display change with the same layout
        ov.refresh();
        wait_until(|| rec.count() == 2);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(rec.count(), 2, "exactly one extra frame");
        assert_eq!(rec.last(), (10, 20, 2, vec![0xFF00_0003, 0, 0, 0]), "the current scene, in place");
    }

    #[test]
    fn firing_without_fire_layer_renders_nothing() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        ov.set_sprites(still_set(), 0, 0);
        wait_until(|| rec.count() == 1);
        for _ in 0..5 {
            ov.set_firing(true);
            ov.set_firing(false);
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(rec.count(), 1, "nothing animates: no frames");
    }

    #[test]
    fn hidden_firing_snaps_and_shows_current_level() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        ov.set_sprites(firing_set(), 0, 0);
        wait_until(|| rec.count() == 1);
        ov.set_visible(false);
        ov.set_firing(true);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(rec.count(), 2, "hidden: the empty frame only, no animation frames");
        assert_eq!(rec.last().3, vec![0; 4]);
        ov.set_visible(true);
        wait_until(|| rec.count() == 3);
        assert_eq!(rec.last().3, vec![0, 0, 0, 0xFF00_0002], "shown again at the full level at once");
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(rec.count(), 3, "already at the target: no ticking");
    }

    #[test]
    fn ticks_render_only_on_frame_change() {
        let rec = Recorder::default();
        let ov = Overlay::spawn(Box::new(rec.clone()));
        let mut set = (*firing_set()).clone();
        set.layers[0].fire_speed_ms = Some(200.0);
        ov.set_sprites(Arc::new(set), 0, 0);
        wait_until(|| rec.count() == 1);
        ov.set_firing(true);
        wait_until(|| rec.last().3 == vec![0, 0, 0, 0xFF00_0002]);
        std::thread::sleep(Duration::from_millis(300)); // the 200 ms rise is over
        let rise = rec.count() - 1;
        assert!((1..=2).contains(&rise), "{rise} frames for a two-frame rise, not one per tick");
        assert_eq!(rec.last().3, vec![0, 0, 0, 0xFF00_0002]);
    }
}
