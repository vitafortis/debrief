//! Shared screens. While a meeting app is being recorded, its window is
//! looked at every few seconds; a frame that holds still and differs from the
//! last one kept (a slide or a document someone is presenting, not a grid of
//! moving faces) is saved as a JPEG beside the audio. Debrief reads the text
//! from those and keeps the ones that have some.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

use anyhow::Result;
use crossbeam_channel::{bounded, Sender};
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const DIR: &str = "screens";
const EVERY: Duration = Duration::from_secs(3);
/// Frames are compared as 64×36 greyscale thumbnails, by mean difference (0–255).
const THUMB_W: usize = 64;
const THUMB_H: usize = 36;
const STILL: f32 = 2.5;
const CHANGED: f32 = 8.0;
const MAX_WIDTH: u32 = 1920;
const MAX_FRAMES: usize = 600;

/// One capture of a window: 32-bit BGRA rows, `stride` bytes apart.
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub bgra: Vec<u8>,
}

/// Browsers are only looked at while a call is the window's tab.
const BROWSERS: &[&str] = &["chrome", "edge", "firefox", "safari", "brave", "arc", "vivaldi", "opera", "browser"];
const CALL_TITLES: &[&str] = &["meet", "teams", "zoom", "webex", "whereby", "jitsi", "slack"];

pub fn is_browser(name: &str, id: &str) -> bool {
    let s = format!("{name} {id}").to_lowercase();
    BROWSERS.iter().any(|b| s.contains(b))
}

pub fn is_call_title(title: &str) -> bool {
    let t = title.to_lowercase();
    CALL_TITLES.iter().any(|c| t.contains(c))
}

/// The meeting window right now, if it's showing (not minimized, not a browser on another tab).
fn grab(name: &str, id: &str) -> Result<Option<Frame>> {
    let browser = is_browser(name, id);
    #[cfg(target_os = "macos")]
    return mac::grab(id, browser);
    #[cfg(windows)]
    return win::grab(id, browser);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = browser;
        Ok(None)
    }
}

fn thumb(f: &Frame) -> Vec<u8> {
    let mut out = Vec::with_capacity(THUMB_W * THUMB_H);
    for ty in 0..THUMB_H {
        for tx in 0..THUMB_W {
            // The average of a few pixels in each cell is plenty to compare by.
            let mut sum = 0u32;
            for (dy, dx) in [(1, 1), (1, 3), (3, 1), (3, 3)] {
                let y = ((ty * 4 + dy) * f.height / (THUMB_H * 4)).min(f.height - 1);
                let x = ((tx * 4 + dx) * f.width / (THUMB_W * 4)).min(f.width - 1);
                let p = &f.bgra[y * f.stride + x * 4..];
                sum += (p[0] as u32 * 29 + p[1] as u32 * 150 + p[2] as u32 * 77) >> 8;
            }
            out.push((sum / 4) as u8);
        }
    }
    out
}

fn diff(a: &[u8], b: &[u8]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs()).sum::<u32>() as f32 / a.len().max(1) as f32
}

/// Writes the frame as a JPEG no wider than MAX_WIDTH, by way of a temporary name.
fn save(f: &Frame, path: &Path) -> Result<()> {
    let mut rgb = image::RgbImage::new(f.width as u32, f.height as u32);
    for (y, row) in rgb.rows_mut().enumerate() {
        let src = &f.bgra[y * f.stride..y * f.stride + f.width * 4];
        for (px, s) in row.zip(src.chunks_exact(4)) {
            *px = image::Rgb([s[2], s[1], s[0]]);
        }
    }
    let img = if f.width as u32 > MAX_WIDTH {
        let h = (f.height as u64 * MAX_WIDTH as u64 / f.width as u64) as u32;
        image::imageops::resize(&rgb, MAX_WIDTH, h.max(1), image::imageops::FilterType::Triangle)
    } else {
        rgb
    };
    let tmp = path.with_extension("jpg.tmp");
    {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).encode_image(&img)?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// The saved frames of a recording, oldest first: <dir>/screens/<ms>.jpg.
pub fn list(recording_dir: &Path) -> Vec<(u64, PathBuf)> {
    let mut out: Vec<(u64, PathBuf)> = std::fs::read_dir(recording_dir.join(DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let ms = p.file_name()?.to_str()?.strip_suffix(".jpg")?.parse().ok()?;
            Some((ms, p))
        })
        .collect();
    out.sort();
    out
}

/// Looks at the meeting window until dropped.
pub struct Watcher {
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    /// `started` is when the audio began, so a frame's name is its time in the recording.
    pub fn start(recording_dir: PathBuf, name: String, id: String, started: Instant) -> Self {
        let (stop, stopped) = bounded::<()>(1);
        let thread = std::thread::Builder::new()
            .name("screens".into())
            .spawn(move || {
                let dir = recording_dir.join(DIR);
                let (mut prev, mut kept): (Option<Vec<u8>>, Option<Vec<u8>>) = (None, None);
                let mut saved = 0;
                let mut last_error = String::new();
                while let Err(crossbeam_channel::RecvTimeoutError::Timeout) = stopped.recv_timeout(EVERY) {
                    let frame = match grab(&name, &id) {
                        Ok(Some(f)) if f.width >= 64 && f.height >= 36 && f.bgra.len() >= f.stride * f.height => f,
                        Ok(_) => {
                            prev = None;
                            continue;
                        }
                        Err(e) => {
                            let msg = format!("{e:#}");
                            if msg != last_error {
                                log::warn!("Couldn't look at {name}'s window: {msg}");
                                last_error = msg;
                            }
                            prev = None;
                            continue;
                        }
                    };
                    let t = thumb(&frame);
                    let still = prev.as_ref().is_some_and(|p| diff(p, &t) < STILL);
                    let changed = kept.as_ref().is_none_or(|k| diff(k, &t) > CHANGED);
                    if still && changed && saved < MAX_FRAMES {
                        let ms = started.elapsed().as_millis() as u64;
                        let path = dir.join(format!("{ms:09}.jpg"));
                        match std::fs::create_dir_all(&dir).map_err(anyhow::Error::from).and_then(|_| save(&frame, &path)) {
                            Ok(()) => {
                                saved += 1;
                                kept = Some(t.clone());
                            }
                            Err(e) => log::warn!("Couldn't save a screen: {e:#}"),
                        }
                    }
                    prev = Some(t);
                }
                if saved > 0 {
                    log::info!("Kept {saved} screens of {name}");
                }
            })
            .expect("screens thread");
        Self { stop, thread: Some(thread) }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.stop.try_send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: usize, h: usize, v: u8) -> Frame {
        Frame { width: w, height: h, stride: w * 4, bgra: vec![v; w * h * 4] }
    }

    #[test]
    fn thumbnails_compare_by_brightness() {
        let (a, b) = (thumb(&solid(800, 450, 10)), thumb(&solid(1600, 900, 10)));
        assert_eq!(a.len(), THUMB_W * THUMB_H);
        assert!(diff(&a, &b) < 0.5);
        assert!(diff(&a, &thumb(&solid(800, 450, 200))) > CHANGED);
    }

    #[test]
    fn frames_are_saved_as_jpegs_and_listed_in_order() {
        let dir = std::env::temp_dir().join(format!("screens-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(DIR)).unwrap();
        save(&solid(2400, 1350, 128), &dir.join(DIR).join("000004000.jpg")).unwrap();
        save(&solid(640, 360, 50), &dir.join(DIR).join("000001500.jpg")).unwrap();
        let l = list(&dir);
        assert_eq!(l.iter().map(|(ms, _)| *ms).collect::<Vec<_>>(), vec![1500, 4000]);
        let big = image::open(&l[1].1).unwrap();
        assert_eq!((big.width(), big.height()), (MAX_WIDTH, 1080));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn browsers_wait_for_a_call_tab() {
        assert!(is_browser("Google Chrome", "com.google.Chrome"));
        assert!(!is_browser("Microsoft Teams", "com.microsoft.teams2"));
        assert!(is_call_title("Meet - abc-defg-hij - Google Chrome"));
        assert!(!is_call_title("Inbox - Gmail"));
    }
}
