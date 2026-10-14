//! Renders sprite sets with `crosshair-core.js` in a hidden WebView2 (`native/sprite-render.html`)
//! that exists only while jobs are queued. Jobs time out after 10 s, are retried once, then fail
//! (the app shows the fallback crosshair).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::logger;

pub const WINDOW_LABEL: &str = "sprite-renderer";
const PAGE: &str = "native/sprite-render.html";
pub const JOB_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_ATTEMPTS: u32 = 2;
const WATCHDOG_EVERY: Duration = Duration::from_secs(1);
const KEY_HEADER: &str = "x-job-key";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Job {
    pub key: String,
    pub crosshair: Value,
    pub scale: f64,
}

#[derive(Debug, PartialEq)]
pub enum RenderEvent {
    Done { key: String, bytes: Vec<u8> },
    Failed { key: String, error: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum FailAction {
    Retry,
    GiveUp,
}

/// Job bookkeeping, free of any WebView (unit-tested).
#[derive(Default)]
pub struct Queue {
    pending: VecDeque<Job>,
    in_flight: HashMap<String, (Job, Instant)>,
    attempts: HashMap<String, u32>,
}

impl Queue {
    /// Queue a job unless the same key is already pending or running.
    pub fn push(&mut self, job: Job) -> bool {
        if self.in_flight.contains_key(&job.key) || self.pending.iter().any(|j| j.key == job.key) {
            return false;
        }
        self.pending.push_back(job);
        true
    }

    /// Hand all pending jobs to the page.
    pub fn take_all(&mut self, now: Instant) -> Vec<Job> {
        let jobs: Vec<Job> = self.pending.drain(..).collect();
        for j in &jobs {
            *self.attempts.entry(j.key.clone()).or_insert(0) += 1;
            self.in_flight.insert(j.key.clone(), (j.clone(), now));
        }
        jobs
    }

    pub fn complete(&mut self, key: &str) -> bool {
        self.attempts.remove(key);
        self.in_flight.remove(key).is_some()
    }

    pub fn fail(&mut self, key: &str) -> FailAction {
        let Some((job, _)) = self.in_flight.remove(key) else { return FailAction::GiveUp };
        if self.attempts.get(key).copied().unwrap_or(0) < MAX_ATTEMPTS {
            self.pending.push_back(job);
            FailAction::Retry
        } else {
            self.attempts.remove(key);
            FailAction::GiveUp
        }
    }

    pub fn expired(&self, now: Instant) -> Vec<String> {
        self.in_flight.iter().filter(|(_, (_, at))| now.duration_since(*at) >= JOB_TIMEOUT).map(|(k, _)| k.clone()).collect()
    }

    /// Give up on everything (renderer cannot start).
    pub fn drain_all(&mut self) -> Vec<String> {
        let mut keys: Vec<String> = self.pending.drain(..).map(|j| j.key).collect();
        keys.extend(self.in_flight.drain().map(|(k, _)| k));
        self.attempts.clear();
        keys
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    pub fn is_idle(&self) -> bool {
        self.pending.is_empty() && self.in_flight.is_empty()
    }
}

pub struct SpriteRenderer {
    app: AppHandle,
    queue: Mutex<Queue>,
    on_event: Box<dyn Fn(RenderEvent) + Send + Sync>,
    data_dir: PathBuf,
}

impl SpriteRenderer {
    pub fn new(app: AppHandle, data_dir: PathBuf, on_event: Box<dyn Fn(RenderEvent) + Send + Sync>) -> Arc<SpriteRenderer> {
        let r = Arc::new(SpriteRenderer { app, queue: Mutex::new(Queue::default()), on_event, data_dir });
        let weak = Arc::downgrade(&r);
        let spawned = std::thread::Builder::new().name("sprite-watchdog".into()).spawn(move || loop {
            std::thread::sleep(WATCHDOG_EVERY);
            match weak.upgrade() {
                Some(r) => r.check_timeouts(),
                None => return,
            }
        });
        if let Err(err) = spawned {
            logger::error("sprite watchdog failed to start", json!({"error": err.to_string()}));
        }
        r
    }

    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn request(&self, job: Job) {
        let key = job.key.clone();
        if self.queue().push(job) {
            logger::info("sprite render queued", json!({"key": &key[..12.min(key.len())]}));
            self.ensure_window();
        }
    }

    fn ensure_window(&self) {
        if let Some(w) = self.app.get_webview_window(WINDOW_LABEL) {
            // page is alive: make it pick up the new jobs (no-op while its loop runs)
            let _ = w.eval("window.czRunJobs && window.czRunJobs()");
            return;
        }
        let result = WebviewWindowBuilder::new(&self.app, WINDOW_LABEL, WebviewUrl::App(PAGE.into()))
            .title("Crosshair Z renderer")
            .visible(false)
            .skip_taskbar(true)
            .data_directory(self.data_dir.clone())
            .build();
        if let Err(err) = result {
            logger::error("sprite renderer could not start (WebView2 missing?)", json!({"error": err.to_string()}));
            let keys = self.queue().drain_all();
            for key in keys {
                (self.on_event)(RenderEvent::Failed { key, error: format!("renderer unavailable: {err}") });
            }
        }
    }

    fn destroy_window(&self) {
        if let Some(w) = self.app.get_webview_window(WINDOW_LABEL) {
            if let Err(err) = w.destroy() {
                logger::warn("sprite renderer destroy failed", json!({"error": err.to_string()}));
            }
        }
    }

    fn fail(&self, key: &str, error: &str) {
        let action = self.queue().fail(key);
        logger::warn("sprite render failed", json!({"key": &key[..12.min(key.len())], "error": error, "action": format!("{action:?}")}));
        if action == FailAction::GiveUp {
            (self.on_event)(RenderEvent::Failed { key: key.to_string(), error: error.to_string() });
        }
    }

    fn check_timeouts(&self) {
        let expired = self.queue().expired(Instant::now());
        if expired.is_empty() {
            return;
        }
        for key in &expired {
            self.fail(key, "timeout");
        }
        // a stuck page is replaced by a fresh one
        self.destroy_window();
        if self.queue().has_pending() {
            self.ensure_window();
        }
    }

    fn take_jobs(&self) -> Vec<Job> {
        self.queue().take_all(Instant::now())
    }

    fn deliver(&self, key: &str, bytes: Vec<u8>) {
        if self.queue().complete(key) {
            (self.on_event)(RenderEvent::Done { key: key.to_string(), bytes });
        }
    }

    fn idle(&self) {
        let idle = self.queue().is_idle();
        if idle {
            self.destroy_window();
            logger::info("sprite renderer idle, webview destroyed", None);
        } else if let Some(w) = self.app.get_webview_window(WINDOW_LABEL) {
            let _ = w.eval("window.czRunJobs && window.czRunJobs()");
        }
    }
}

// ---------- commands called by native/sprite-render.js (async: never block the main thread) ----------

#[tauri::command]
pub async fn sprite_jobs(renderer: State<'_, Arc<SpriteRenderer>>) -> Result<Vec<Job>, String> {
    Ok(renderer.take_jobs())
}

#[tauri::command]
pub async fn sprite_result(request: tauri::ipc::Request<'_>, renderer: State<'_, Arc<SpriteRenderer>>) -> Result<(), String> {
    let key = request.headers().get(KEY_HEADER).and_then(|v| v.to_str().ok()).ok_or("missing job key header")?.to_string();
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            renderer.deliver(&key, bytes.clone());
            Ok(())
        }
        tauri::ipc::InvokeBody::Json(_) => {
            renderer.fail(&key, "sprite payload was not sent as raw bytes");
            Err("expected raw body".into())
        }
    }
}

#[tauri::command]
pub async fn sprite_failed(key: String, error: String, renderer: State<'_, Arc<SpriteRenderer>>) -> Result<(), String> {
    renderer.fail(&key, &error);
    Ok(())
}

#[tauri::command]
pub async fn sprite_idle(renderer: State<'_, Arc<SpriteRenderer>>) -> Result<(), String> {
    renderer.idle();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job(k: &str) -> Job {
        Job { key: k.into(), crosshair: json!({"layers": []}), scale: 1.0 }
    }

    #[test]
    fn dedupes_pending_and_running() {
        let mut q = Queue::default();
        assert!(q.push(job("a")));
        assert!(!q.push(job("a")));
        let t = Instant::now();
        assert_eq!(q.take_all(t).len(), 1);
        assert!(!q.push(job("a")), "running");
        assert!(q.complete("a"));
        assert!(q.push(job("a")), "done → may render again");
    }

    #[test]
    fn retries_once_then_gives_up() {
        let mut q = Queue::default();
        q.push(job("a"));
        let t = Instant::now();
        q.take_all(t);
        assert_eq!(q.fail("a"), FailAction::Retry);
        assert!(q.has_pending());
        q.take_all(t);
        assert_eq!(q.fail("a"), FailAction::GiveUp);
        assert!(q.is_idle());
        assert_eq!(q.fail("unknown"), FailAction::GiveUp);
    }

    #[test]
    fn success_resets_attempts() {
        let mut q = Queue::default();
        q.push(job("a"));
        q.take_all(Instant::now());
        q.fail("a");
        q.take_all(Instant::now());
        q.complete("a");
        q.push(job("a"));
        q.take_all(Instant::now());
        assert_eq!(q.fail("a"), FailAction::Retry, "fresh attempt budget");
    }

    #[test]
    fn expiry_after_timeout() {
        let mut q = Queue::default();
        q.push(job("a"));
        let t0 = Instant::now();
        q.take_all(t0);
        assert!(q.expired(t0 + JOB_TIMEOUT - Duration::from_millis(1)).is_empty());
        assert_eq!(q.expired(t0 + JOB_TIMEOUT), vec!["a".to_string()]);
    }

    #[test]
    fn drain_all_reports_everything() {
        let mut q = Queue::default();
        q.push(job("a"));
        q.push(job("b"));
        q.take_all(Instant::now());
        q.push(job("c"));
        let mut keys = q.drain_all();
        keys.sort();
        assert_eq!(keys, vec!["a", "b", "c"]);
        assert!(q.is_idle());
    }
}
