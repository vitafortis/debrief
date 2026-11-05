//! The meeting app's biggest window through ScreenCaptureKit (macOS 14+),
//! which captures it even behind other windows. It needs the Screen
//! Recording permission; macOS asks the first time.

use super::{is_call_title, Frame};
use anyhow::{anyhow, Context, Result};
use cidre::{arc, cv, sc};
use std::future::Future;
use std::sync::Arc;
use std::task::{Poll, Wake};
use std::time::{Duration, Instant};

/// Runs one of ScreenCaptureKit's completion-handler calls to the end, or gives up after 10 s.
pub(super) fn wait<F: Future>(f: F) -> Option<F::Output> {
    struct Unpark(std::thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Arc::new(Unpark(std::thread::current())).into();
    let mut cx = std::task::Context::from_waker(&waker);
    let mut f = std::pin::pin!(f);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return Some(v);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::park_timeout(Duration::from_millis(50));
    }
}

/// The app's biggest window that's showing (for a browser, one on a call's tab).
pub fn find(app_id: &str, browser: bool) -> Result<Option<arc::R<sc::Window>>> {
    let id = app_id.to_lowercase();
    let base = id.find(".helper").map(|i| id[..i].to_string()).unwrap_or(id);
    if base.is_empty() {
        return Ok(None);
    }
    let content = wait(sc::ShareableContent::current())
        .context("macOS didn't list the windows")?
        .map_err(|e| anyhow!("macOS refused to list the windows (allow Screen Recording for Debrief Recorder): {e:?}"))?;
    let mut best: Option<(f64, arc::R<sc::Window>)> = None;
    for w in content.windows().iter() {
        if !w.is_on_screen() || w.window_layer() != 0 {
            continue;
        }
        let Some(app) = w.owning_app() else { continue };
        if !app.bundle_id().to_string().to_lowercase().starts_with(&base) {
            continue;
        }
        let size = w.frame().size;
        if size.width < 400.0 || size.height < 300.0 {
            continue;
        }
        if browser && !w.title().is_some_and(|t| is_call_title(&t.to_string())) {
            continue;
        }
        let area = size.width * size.height;
        if best.as_ref().is_none_or(|(a, _)| area > *a) {
            best = Some((area, w.retained()));
        }
    }
    Ok(best.map(|(_, w)| w))
}

/// One still of the window.
pub fn capture(window: &sc::Window) -> Result<Option<Frame>> {
    // Twice the window's size in points: Retina pixels, so small text stays readable.
    let size = window.frame().size;
    let scale = (2.0f64).min(2880.0 / size.width);
    let filter = sc::ContentFilter::with_desktop_independent_window(window);
    let mut cfg = sc::StreamCfg::new();
    cfg.set_width((size.width * scale) as usize);
    cfg.set_height((size.height * scale) as usize);
    cfg.set_pixel_format(cv::PixelFormat::_32_BGRA);
    cfg.set_shows_cursor(false);
    let mut sample = wait(sc::ScreenshotManager::capture_sample_buf(&filter, &cfg))
        .context("macOS didn't capture the window")?
        .map_err(|e| anyhow!("macOS couldn't capture the window: {e:?}"))?;
    let buf = sample.image_buf_mut().context("the capture had no image")?;
    unsafe {
        if buf.lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY).result().is_err() {
            return Err(anyhow!("couldn't read the capture"));
        }
        let (width, height, stride) = (buf.width(), buf.height(), buf.bytes_per_row());
        let base = buf.base_address() as *const u8;
        let frame = (!base.is_null()).then(|| Frame { width, height, stride, bgra: std::slice::from_raw_parts(base, stride * height).to_vec() });
        let _ = buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY);
        Ok(frame)
    }
}
