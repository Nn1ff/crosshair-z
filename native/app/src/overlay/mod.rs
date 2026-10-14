//! Overlay controller: owns the current sprite set and firing animation on its own thread, composes
//! frames and hands them to a sink (the layered window). Ticks every 8 ms only while a layer moves.

pub mod compositor;
pub mod monitors;
pub mod window;

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::logger;
use crate::sprites::codec::SpriteSet;
use compositor::{compose, FireAnimator};
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
    buf: Vec<u32>,
}

impl Scene {
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

impl Overlay {
    pub fn spawn(mut sink: Box<dyn FrameSink>) -> Overlay {
        let (tx, rx) = mpsc::channel::<Msg>();
        let thread = std::thread::Builder::new()
            .name("overlay-anim".into())
            .spawn(move || {
                let mut scene = Scene { set: None, x: 0, y: 0, visible: true, anim: FireAnimator::new(), buf: Vec::new() };
                let mut moving = false;
                let mut last = Instant::now();
                loop {
                    let msg = if moving {
                        match rx.recv_timeout(TICK) {
                            Ok(m) => Some(m),
                            Err(RecvTimeoutError::Timeout) => None,
                            Err(RecvTimeoutError::Disconnected) => Some(Msg::Stop),
                        }
                    } else {
                        Some(rx.recv().unwrap_or(Msg::Stop))
                    };
                    let tick = msg.is_none();
                    match msg {
                        Some(Msg::Stop) => return,
                        Some(Msg::Sprites { set, x, y }) => {
                            let same = scene.set.as_ref().is_some_and(|s| Arc::ptr_eq(s, &set));
                            if !same {
                                scene.anim.reset();
                            }
                            scene.set = Some(set);
                            scene.x = x;
                            scene.y = y;
                            scene.render(sink.as_mut());
                            moving = scene.anim.firing() && !same;
                            last = Instant::now();
                        }
                        Some(Msg::Visible(v)) => {
                            if scene.visible != v {
                                scene.visible = v;
                                scene.render(sink.as_mut());
                            }
                        }
                        Some(Msg::Firing(on)) => {
                            scene.anim.set_firing(on);
                            if !moving {
                                moving = true;
                                last = Instant::now();
                            }
                        }
                        None => {}
                    }
                    if moving && tick {
                        let now = Instant::now();
                        let dt = (now - last).as_secs_f32() * 1000.0;
                        last = now;
                        moving = match scene.set.clone() {
                            Some(set) => scene.anim.step(dt.min(MAX_STEP_MS), &set),
                            None => false,
                        };
                        scene.render(sink.as_mut());
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

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<(i32, i32, u32, Vec<u32>)>>>);

    impl FrameSink for Recorder {
        fn show(&mut self, x: i32, y: i32, size: u32, pixels: Vec<u32>) {
            self.0.lock().unwrap().push((x, y, size, pixels));
        }
    }

    impl Recorder {
        fn count(&self) -> usize {
            self.0.lock().unwrap().len()
        }
        fn last(&self) -> (i32, i32, u32, Vec<u32>) {
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
}
