//! Video of the meeting window (macOS 15+): ScreenCaptureKit records it to
//! an MP4 at a few frames a second, so typing, scrolling and the pointer
//! moving are kept, not just the slides that hold still. A new file starts
//! whenever it's a different window: <dir>/video/<ms>.mp4, named by when in
//! the recording it starts.

use super::mac::wait;
use super::VIDEO_DIR;
use anyhow::{anyhow, Result};
use cidre::sc::{RecordingOutputDelegate, RecordingOutputDelegateImpl};
use cidre::{arc, cg, cm, define_obj_type, ns, objc, sc};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const FPS: i32 = 5;
const MAX_WIDTH: f64 = 1920.0;

/// Recordings that have finished writing (or failed), counted so a stop can wait for its file.
static ENDED: AtomicU64 = AtomicU64::new(0);

define_obj_type!(Ended + RecordingOutputDelegateImpl, (), DEBRIEF_RECORDING_DELEGATE);

impl RecordingOutputDelegate for Ended {}

#[objc::add_methods]
impl RecordingOutputDelegateImpl for Ended {
    extern "C" fn impl_recording_output_did_fail_with_err(&mut self, _cmd: Option<&objc::Sel>, _output: &mut sc::RecordingOutput, error: &ns::Error) {
        log::warn!("The window video stopped: {error:?}");
        ENDED.fetch_add(1, Ordering::SeqCst);
    }

    extern "C" fn impl_recording_output_did_finish_recording(&mut self, _cmd: Option<&objc::Sel>, _output: &mut sc::RecordingOutput) {
        ENDED.fetch_add(1, Ordering::SeqCst);
    }
}

struct Segment {
    window: cg::WindowId,
    stream: arc::R<sc::Stream>,
    _output: arc::R<sc::RecordingOutput>,
    _delegate: arc::R<Ended>,
    writing: PathBuf,
    done: PathBuf,
}

pub struct Video {
    dir: PathBuf,
    current: Option<Segment>,
    failed: Option<cg::WindowId>,
}

impl Video {
    /// None before macOS 15, which can't record a window to a file.
    pub fn new(recording_dir: &Path) -> Option<Self> {
        cidre::api::version!(macos = 15.0).then(|| Self { dir: recording_dir.join(VIDEO_DIR), current: None, failed: None })
    }

    /// Keeps recording `window`: carries on if it's the one being recorded, else starts a new file `ms` into the recording.
    pub fn follow(&mut self, window: Option<&sc::Window>, ms: u64) {
        let id = window.map(|w| w.id());
        if self.current.as_ref().map(|s| s.window) == id {
            return;
        }
        self.stop();
        let Some(window) = window else { return };
        // A window that wouldn't record isn't tried again every few seconds.
        if self.failed == id {
            return;
        }
        match self.start(window, ms) {
            Ok(s) => self.current = Some(s),
            Err(e) => {
                log::warn!("Couldn't record the meeting window: {e:#}");
                self.failed = id;
            }
        }
    }

    fn start(&self, window: &sc::Window, ms: u64) -> Result<Segment> {
        std::fs::create_dir_all(&self.dir)?;
        let done = self.dir.join(format!("{ms:09}.mp4"));
        let writing = self.dir.join(format!("{ms:09}.recording.mp4"));
        let _ = std::fs::remove_file(&writing);

        // Retina pixels, but no wider than 1920: enough to read, small enough to keep.
        let size = window.frame().size;
        let scale = 2.0f64.min(MAX_WIDTH / size.width.max(1.0));
        let filter = sc::ContentFilter::with_desktop_independent_window(window);
        let mut cfg = sc::StreamCfg::new();
        // H.264 wants even sizes.
        cfg.set_width(((size.width * scale) as usize) & !1);
        cfg.set_height(((size.height * scale) as usize) & !1);
        cfg.set_minimum_frame_interval(cm::Time::new(1, FPS));
        cfg.set_shows_cursor(true);
        cfg.set_queue_depth(6);

        let mut out_cfg = sc::RecordingOutputCfg::new();
        let path = writing.to_str().ok_or_else(|| anyhow!("the recordings folder's path isn't UTF-8"))?;
        out_cfg.set_output_url(&ns::Url::with_fs_path_str(path, false));
        let delegate = Ended::new();
        let output = sc::RecordingOutput::with_cfg(&out_cfg, delegate.as_ref());
        let mut stream = sc::Stream::new(&filter, &cfg);
        stream.add_recording_output(&output).map_err(|e| anyhow!("{e:?}"))?;
        wait(stream.start()).ok_or_else(|| anyhow!("macOS didn't start the capture"))?.map_err(|e| anyhow!("macOS couldn't start the capture: {e:?}"))?;
        log::info!("Recording the meeting window to {}", done.display());
        Ok(Segment { window: window.id(), stream, _output: output, _delegate: delegate, writing, done })
    }

    /// Finishes the file being written, if any.
    pub fn stop(&mut self) {
        let Some(s) = self.current.take() else { return };
        let before = ENDED.load(Ordering::SeqCst);
        // A window that closed has stopped its stream already; that's fine.
        let _ = wait(s.stream.stop());
        let deadline = Instant::now() + Duration::from_secs(10);
        while ENDED.load(Ordering::SeqCst) == before && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        match std::fs::metadata(&s.writing) {
            Ok(m) if m.len() > 0 => {
                if let Err(e) = std::fs::rename(&s.writing, &s.done) {
                    log::warn!("Couldn't keep the window video: {e}");
                }
            }
            _ => {
                let _ = std::fs::remove_file(&s.writing);
            }
        }
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        self.stop();
    }
}
