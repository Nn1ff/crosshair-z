//! File logger, port of `src/main/logger.js`: one line per entry
//! `<ISO-UTC> <LEVEL> <msg>[ <json ctx>]`, single-file rotation to `.1` above 1 MiB.
//! Never panics: when the log file cannot be written, file output pauses for a minute and is
//! then retried (both reported on stderr).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

const MAX_LOG_BYTES: u64 = 1024 * 1024;
const LOG_NAME: &str = "crosshair-z.log";
/// How long file output pauses after a failed write before it is tried again.
#[cfg(not(test))]
const FILE_RETRY_AFTER: Duration = Duration::from_secs(60);
#[cfg(test)]
const FILE_RETRY_AFTER: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// A log sink bound to one file.
pub struct Logger {
    file: PathBuf,
    /// Set while file output is paused after a failure; the file is skipped until then.
    disabled_until: Mutex<Option<Instant>>,
}

impl Logger {
    /// Create the log dir if needed. Failure only pauses file output.
    pub fn new(dir: &Path) -> Logger {
        let disabled_until = match fs::create_dir_all(dir) {
            Ok(()) => None,
            Err(err) => {
                echo(&format!("[logger] cannot create log dir {}: {err}", dir.display()));
                Some(Instant::now() + FILE_RETRY_AFTER)
            }
        };
        Logger { file: dir.join(LOG_NAME), disabled_until: Mutex::new(disabled_until) }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn write(&self, level: Level, msg: &str, ctx: Option<&Value>) {
        let now = SystemTime::now();
        let line = format_line(now, level, msg, ctx);
        echo(&line);
        let mut disabled_until = self.disabled_until.lock().unwrap_or_else(PoisonError::into_inner);
        let resuming = match *disabled_until {
            Some(until) if Instant::now() < until => return,
            Some(_) => true,
            None => false,
        };
        // One write per entry, newline included: appends of several writers never tear a line.
        let mut entry = String::with_capacity(line.len() + 1);
        if resuming {
            entry.push_str(&format_line(now, Level::Info, "file logging resumed", None));
            entry.push('\n');
        }
        entry.push_str(&line);
        entry.push('\n');
        match self.append(&entry, resuming) {
            Ok(()) => {
                if resuming {
                    echo("[logger] file logging resumed");
                }
                *disabled_until = None;
            }
            Err(err) => {
                *disabled_until = Some(Instant::now() + FILE_RETRY_AFTER);
                echo(&format!("[logger] write failed, file logging paused for {FILE_RETRY_AFTER:?}: {err}"));
            }
        }
    }

    fn append(&self, entry: &str, resuming: bool) -> std::io::Result<()> {
        if resuming {
            // the dir may have been missing or removed when output paused
            if let Some(dir) = self.file.parent() {
                fs::create_dir_all(dir)?;
            }
        }
        self.rotate_if_needed();
        OpenOptions::new().create(true).append(true).open(&self.file)?.write_all(entry.as_bytes())
    }

    fn rotate_if_needed(&self) {
        match fs::metadata(&self.file) {
            Ok(meta) if meta.len() > MAX_LOG_BYTES => {
                let backup = self.file.with_extension("log.1");
                if let Err(err) = fs::rename(&self.file, &backup) {
                    echo(&format!("[logger] rotate failed: {err}"));
                }
            }
            _ => {}
        }
    }
}

/// Console copy of a log line (only seen in dev runs). The app ignores a closed stderr (no EPIPE
/// loop, no panic); test builds print through `eprintln!` so the harness captures the output.
fn echo(line: &str) {
    if cfg!(test) {
        eprintln!("{line}");
    } else {
        let _ = writeln!(std::io::stderr(), "{line}");
    }
}

/// `2026-10-14T12:34:56.789Z INFO msg {"k":1}`
pub fn format_line(now: SystemTime, level: Level, msg: &str, ctx: Option<&Value>) -> String {
    match ctx {
        Some(ctx) => format!("{} {} {} {}", iso_utc(now), level.as_str(), msg, ctx),
        None => format!("{} {} {}", iso_utc(now), level.as_str(), msg),
    }
}

/// ISO-8601 UTC with milliseconds, like JS `Date#toISOString`.
pub fn iso_utc(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, day) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's days → (year, month, day) for the proleptic Gregorian calendar.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------- process-wide logger ----------

static GLOBAL: OnceLock<Logger> = OnceLock::new();

/// Install the process logger (first call wins).
pub fn init(dir: &Path) {
    let _ = GLOBAL.set(Logger::new(dir));
}

/// Path of the active log file, if initialized.
pub fn log_file() -> Option<PathBuf> {
    GLOBAL.get().map(|l| l.file().to_path_buf())
}

fn emit(level: Level, msg: &str, ctx: Option<Value>) {
    match GLOBAL.get() {
        Some(l) => l.write(level, msg, ctx.as_ref()),
        None => echo(&format_line(SystemTime::now(), level, msg, ctx.as_ref())),
    }
}

pub fn debug(msg: &str, ctx: impl Into<Option<Value>>) {
    emit(Level::Debug, msg, ctx.into());
}

pub fn info(msg: &str, ctx: impl Into<Option<Value>>) {
    emit(Level::Info, msg, ctx.into());
}

pub fn warn(msg: &str, ctx: impl Into<Option<Value>>) {
    emit(Level::Warn, msg, ctx.into());
}

pub fn error(msg: &str, ctx: impl Into<Option<Value>>) {
    emit(Level::Error, msg, ctx.into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cz-logger-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn iso_epoch() {
        assert_eq!(iso_utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn iso_known_instant() {
        // 2026-10-14T12:34:56.789Z = 1791981296.789
        let t = UNIX_EPOCH + Duration::from_millis(1_791_981_296_789);
        assert_eq!(iso_utc(t), "2026-10-14T12:34:56.789Z");
    }

    #[test]
    fn iso_leap_day() {
        // 2024-02-29T00:00:00Z = 1709164800
        let t = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(iso_utc(t), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn line_format_with_and_without_ctx() {
        assert_eq!(format_line(UNIX_EPOCH, Level::Info, "boot", None), "1970-01-01T00:00:00.000Z INFO boot");
        assert_eq!(
            format_line(UNIX_EPOCH, Level::Error, "x failed", Some(&json!({"k": 1}))),
            "1970-01-01T00:00:00.000Z ERROR x failed {\"k\":1}"
        );
    }

    #[test]
    fn writes_and_rotates() {
        let dir = temp_dir("rotate");
        let log = Logger::new(&dir);
        log.write(Level::Info, "first", None);
        let text = fs::read_to_string(log.file()).unwrap();
        assert!(text.ends_with("INFO first\n"), "{text}");

        fs::write(log.file(), vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        log.write(Level::Warn, "after rotate", None);
        let backup = dir.join("crosshair-z.log.1");
        assert_eq!(fs::metadata(&backup).unwrap().len(), MAX_LOG_BYTES + 1);
        let fresh = fs::read_to_string(log.file()).unwrap();
        assert!(fresh.ends_with("WARN after rotate\n") && fresh.lines().count() == 1, "{fresh}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_dir_disables_file_output_without_panic() {
        let dir = temp_dir("bad");
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        fs::write(&dir, b"a file, not a dir").unwrap();
        let log = Logger::new(&dir);
        log.write(Level::Error, "still fine", None);
        let _ = fs::remove_file(&dir);
    }

    /// `^\d{4}-\d\d-\d\dT`
    fn starts_with_iso_date(line: &str) -> bool {
        let b = line.as_bytes();
        b.len() > 10 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && b[5..7].iter().all(u8::is_ascii_digit) && b[7] == b'-' && b[8..10].iter().all(u8::is_ascii_digit) && b[10] == b'T'
    }

    #[test]
    fn entries_are_single_writes() {
        const PER_THREAD: usize = 500;
        let dir = temp_dir("single");
        let loggers = [Logger::new(&dir), Logger::new(&dir)];
        std::thread::scope(|s| {
            for (t, log) in loggers.iter().enumerate() {
                s.spawn(move || {
                    for i in 0..PER_THREAD {
                        log.write(Level::Info, &format!("thread {t} line {i}"), None);
                    }
                });
            }
        });
        let text = fs::read_to_string(loggers[0].file()).unwrap();
        assert!(text.ends_with('\n'));
        for line in text.lines() {
            assert!(starts_with_iso_date(line), "torn entry: {line:?}");
        }
        // a write that failed under contention would pause file output and drop entries
        assert_eq!(text.lines().count(), loggers.len() * PER_THREAD, "every entry written");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_logging_resumes_after_pause() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("pause");
        let log = Logger::new(&dir);
        let held = OpenOptions::new().append(true).create(true).share_mode(0).open(log.file()).unwrap();
        log.write(Level::Info, "dropped while held", None);
        drop(held);
        std::thread::sleep(Duration::from_millis(80)); // test builds pause file output for 50 ms
        log.write(Level::Info, "after pause", None);
        let text = fs::read_to_string(log.file()).unwrap();
        assert!(text.contains("INFO file logging resumed"), "{text}");
        assert!(text.ends_with("INFO after pause\n"), "{text}");
        assert!(!text.contains("dropped while held"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }
}
