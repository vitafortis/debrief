//! Recording: the microphone and the computer's own audio, mixed into a
//! stereo Ogg Opus file (left: you, right: the call) that only ever grows,
//! so it can be uploaded while it's being written.

mod ogg_opus;
#[cfg(target_os = "macos")]
pub mod system_mac;
#[cfg(windows)]
pub mod system_win;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, Sender};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub use ogg_opus::OggOpusWriter;

pub const RATE: u32 = 48_000;
const FRAME: usize = 960; // 20 ms at 48 kHz
const LATENCY: usize = RATE as usize / 5; // how far behind real time the mix runs, for late buffers
// A source whose clock runs a little fast builds up a queue: past DRIFT, one
// sample in each frame is skipped (0.1%, inaudible) until it's back down.
const DRIFT: usize = LATENCY * 2;
// Past this a source has stalled and then caught up all at once: drop the oldest.
const MAX_BACKLOG: usize = RATE as usize * 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Mic = 0,
    System = 1,
}

/// Mono samples from one source at its own rate.
pub struct Chunk {
    pub source: Source,
    pub rate: u32,
    pub samples: Vec<f32>,
}

pub type ChunkTx = Sender<Chunk>;

/// Peak levels since the last read, for the meters (0–1000).
#[derive(Default)]
pub struct Levels {
    pub mic: AtomicU32,
    pub system: AtomicU32,
    /// Whether the computer's audio ever had anything in it.
    pub system_heard: AtomicBool,
    /// Whether the microphone ever had anything in it.
    pub mic_heard: AtomicBool,
}

/// The other side of the call: nothing, everything the computer plays, or
/// just the meeting app (by the name and id the microphone check found).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallAudio {
    Off,
    Everything,
    App { name: String, id: String },
}

pub struct Recording {
    stop: Sender<()>,
    capture: Option<JoinHandle<()>>,
    mixer: Option<JoinHandle<Result<f64>>>,
    pub levels: Arc<Levels>,
    pub warnings: Vec<String>,
}

pub struct Finished {
    pub duration_secs: f64,
    pub system_heard: bool,
    pub mic_heard: bool,
}

impl Recording {
    /// Starts recording into `file`. The microphone is required; the computer's audio is best-effort.
    pub fn start(file: &Path, microphone: &str, call: CallAudio) -> Result<Self> {
        let (tx, rx) = bounded::<Chunk>(512);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let (ready_tx, ready_rx) = bounded::<Result<Vec<String>>>(1);
        let levels = Arc::new(Levels::default());

        // Streams aren't Send on every platform: they live on their own thread until stopped.
        let mic_name = microphone.to_string();
        let capture = std::thread::Builder::new().name("capture".into()).spawn(move || {
            let mut warnings = Vec::new();
            let mut mic = match Mic::open(&mic_name, tx.clone()) {
                Ok(m) => m,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let mut system = match call {
                CallAudio::Off => None,
                call => match open_system(&call, tx.clone()) {
                    Ok((s, warning)) => {
                        warnings.extend(warning);
                        Some(s)
                    }
                    Err(e) => {
                        log::warn!("No system audio: {e:#}");
                        warnings.push(format!("Only the microphone is being recorded: {e}"));
                        None
                    }
                },
            };
            let _ = ready_tx.send(Ok(warnings));
            // Keep both going: a microphone that stops (a Bluetooth headset
            // switching modes, a device unplugged) is opened again, and an
            // app's new audio processes are added to the tap.
            let mut last_try = Instant::now();
            loop {
                match stop_rx.recv_timeout(Duration::from_secs(1)) {
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    _ => break,
                }
                if let Some(why) = mic.trouble() {
                    if last_try.elapsed() >= Duration::from_secs(3) {
                        last_try = Instant::now();
                        log::warn!("Opening the microphone again: {why}");
                        match Mic::open(&mic_name, tx.clone()) {
                            Ok(m) => mic = m,
                            Err(e) => log::warn!("Couldn't open the microphone again: {e:#}"),
                        }
                    }
                }
                if let Some(s) = system.as_mut() {
                    s.refresh(&tx);
                }
            }
            drop(system);
            drop(mic);
        })?;

        let warnings = ready_rx.recv().map_err(|_| anyhow!("The recorder stopped while starting"))??;

        let writer = OggOpusWriter::create(file)?;
        let lv = levels.clone();
        let mixer = std::thread::Builder::new().name("mixer".into()).spawn(move || mix(rx, writer, lv))?;

        Ok(Self { stop: stop_tx, capture: Some(capture), mixer: Some(mixer), levels, warnings })
    }

    pub fn stop(mut self) -> Result<Finished> {
        let _ = self.stop.send(());
        if let Some(c) = self.capture.take() {
            let _ = c.join();
        }
        let secs = self
            .mixer
            .take()
            .ok_or_else(|| anyhow!("already stopped"))?
            .join()
            .map_err(|_| anyhow!("The mixer crashed"))??;
        Ok(Finished {
            duration_secs: secs,
            system_heard: self.levels.system_heard.load(Ordering::Relaxed),
            mic_heard: self.levels.mic_heard.load(Ordering::Relaxed),
        })
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

/// Linear resampling to 48 kHz; plenty for speech going to Whisper.
struct Resampler {
    rate: u32,
    step: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    fn new(rate: u32) -> Self {
        Self { rate, step: rate as f64 / RATE as f64, pos: 0.0, prev: 0.0 }
    }

    fn push(&mut self, input: &[f32], out: &mut VecDeque<f32>) {
        let n = input.len();
        if n == 0 {
            return;
        }
        // Positions count from `prev` (index 0), then input[0] at 1, …
        while self.pos < n as f64 {
            let i = self.pos.floor() as usize;
            let f = (self.pos - i as f64) as f32;
            let a = if i == 0 { self.prev } else { input[i - 1] };
            let b = input[i];
            out.push_back(a + (b - a) * f);
            self.pos += self.step;
        }
        self.pos -= n as f64;
        self.prev = input[n - 1];
    }
}

/// Runs a little behind the clock, taking 20 ms from each source per frame
/// (silence where one has nothing), so a source that stalls or never
/// starts doesn't hold up the other.
fn mix(rx: Receiver<Chunk>, mut writer: OggOpusWriter, levels: Arc<Levels>) -> Result<f64> {
    let mut queues = [VecDeque::<f32>::with_capacity(RATE as usize), VecDeque::<f32>::with_capacity(RATE as usize)];
    let mut resamplers: [Option<Resampler>; 2] = [None, None];
    let started = Instant::now();
    let mut frames: u64 = 0;
    let mut pcm = vec![0f32; FRAME * 2];
    let mut open = true;

    let mut take = |c: Chunk, queues: &mut [VecDeque<f32>; 2]| {
        let i = c.source as usize;
        let r = resamplers[i].get_or_insert_with(|| Resampler::new(c.rate));
        if r.rate != c.rate {
            *r = Resampler::new(c.rate);
        }
        let peak = c.samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        let meter = if c.source == Source::Mic { &levels.mic } else { &levels.system };
        meter.fetch_max((peak.min(1.0) * 1000.0) as u32, Ordering::Relaxed);
        if peak > 0.0005 {
            let heard = if c.source == Source::Mic { &levels.mic_heard } else { &levels.system_heard };
            heard.store(true, Ordering::Relaxed);
        }
        r.push(&c.samples, &mut queues[i]);
        let q = &mut queues[i];
        if q.len() > MAX_BACKLOG {
            let extra = q.len() - LATENCY;
            q.drain(..extra);
        }
    };

    loop {
        // Wait a little for audio, then take everything that's queued.
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(c) => {
                take(c, &mut queues);
                loop {
                    match rx.try_recv() {
                        Ok(c) => take(c, &mut queues),
                        Err(crossbeam_channel::TryRecvError::Empty) => break,
                        Err(crossbeam_channel::TryRecvError::Disconnected) => {
                            open = false;
                            break;
                        }
                    }
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => open = false,
        }

        let due = if open {
            (started.elapsed().as_secs_f64() * RATE as f64) as u64
        } else {
            // Stopped: flush what's left.
            frames * FRAME as u64 + queues.iter().map(|q| q.len()).max().unwrap_or(0) as u64 + LATENCY as u64
        };
        while (frames + 1) * FRAME as u64 + LATENCY as u64 <= due {
            for (ch, q) in queues.iter_mut().enumerate() {
                if q.len() > DRIFT {
                    q.pop_front();
                }
                for k in 0..FRAME {
                    pcm[k * 2 + ch] = q.pop_front().unwrap_or(0.0).clamp(-1.0, 1.0);
                }
            }
            writer.write_frame(&pcm)?;
            frames += 1;
        }
        if !open {
            break;
        }
    }
    writer.finish()?;
    Ok(frames as f64 * FRAME as f64 / RATE as f64)
}

fn to_mono_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect()
}

/// Milliseconds since the recorder started, for comparing across threads.
fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// How a stream is doing, from its own callbacks.
#[derive(Default)]
struct Health {
    /// When audio last arrived, and when it last had anything but digital silence (now_ms).
    last_data: AtomicU64,
    last_sound: AtomicU64,
    failed: AtomicBool,
}

/// An input stream (or, on Windows, a loopback of an output device) feeding the mixer.
fn cpal_stream(device: &cpal::Device, config: cpal::SupportedStreamConfig, source: Source, tx: ChunkTx, health: Option<Arc<Health>>) -> Result<cpal::Stream> {
    let channels = config.channels() as usize;
    let rate = config.sample_rate();
    let cfg: cpal::StreamConfig = config.config();
    let h = health.clone();
    let err = move |e| {
        log::warn!("{source:?} stream error: {e}");
        if let Some(h) = &h {
            h.failed.store(true, Ordering::Relaxed);
        }
    };
    macro_rules! build {
        ($t:ty, $conv:expr) => {{
            let tx = tx.clone();
            let health = health.clone();
            device.build_input_stream::<$t, _, _>(
                cfg.clone(),
                move |data: &[$t], _| {
                    let f: Vec<f32> = data.iter().map($conv).collect();
                    if let Some(h) = &health {
                        let now = now_ms();
                        h.last_data.store(now, Ordering::Relaxed);
                        if f.iter().any(|&s| s != 0.0) {
                            h.last_sound.store(now, Ordering::Relaxed);
                        }
                    }
                    let _ = tx.try_send(Chunk { source, rate, samples: to_mono_f32(&f, channels) });
                },
                err,
                None,
            )?
        }};
    }
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build!(f32, |s: &f32| *s),
        cpal::SampleFormat::I16 => build!(i16, |s: &i16| *s as f32 / 32768.0),
        cpal::SampleFormat::I32 => build!(i32, |s: &i32| *s as f32 / 2147483648.0),
        cpal::SampleFormat::U16 => build!(u16, |s: &u16| (*s as f32 - 32768.0) / 32768.0),
        f => return Err(anyhow!("Unsupported sample format {f:?}")),
    };
    stream.play()?;
    Ok(stream)
}

pub fn input_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|ds| ds.filter_map(|d| d.description().ok().map(|x| x.name().to_string())).collect())
        .unwrap_or_default()
}

fn device_name(d: &cpal::Device) -> String {
    d.description().map(|x| x.name().to_string()).unwrap_or_default()
}

/// The microphone stream, and what's needed to tell when it has stopped working.
struct Mic {
    _stream: cpal::Stream,
    /// The device it opened, and whether it's following the system default.
    device: String,
    follow_default: bool,
    health: Arc<Health>,
    opened: u64,
}

impl Mic {
    /// The microphone by name, or the default when it's empty or not plugged in.
    fn open(name: &str, tx: ChunkTx) -> Result<Self> {
        let host = cpal::default_host();
        let chosen = if name.trim().is_empty() { None } else { host.input_devices()?.find(|d| device_name(d) == name) };
        let follow_default = chosen.is_none();
        let device = chosen.or_else(|| host.default_input_device()).context("No microphone found")?;
        let config = device.default_input_config().context("Couldn't open the microphone")?;
        let now = now_ms();
        let health = Arc::new(Health { last_data: AtomicU64::new(now), last_sound: AtomicU64::new(now), failed: AtomicBool::new(false) });
        let stream = cpal_stream(&device, config, Source::Mic, tx, Some(health.clone()))?;
        let device = device_name(&device);
        log::info!("Microphone: {device}");
        Ok(Self { _stream: stream, device, follow_default, health, opened: now })
    }

    /// Why it should be opened again, if it should.
    fn trouble(&self) -> Option<String> {
        let now = now_ms();
        if self.health.failed.load(Ordering::Relaxed) {
            return Some("the stream reported an error".into());
        }
        if now.saturating_sub(self.health.last_data.load(Ordering::Relaxed)) > 3_000 {
            return Some("no audio for 3 seconds".into());
        }
        // A real microphone always hears something; only zeros means it's been cut off.
        if now.saturating_sub(self.health.last_sound.load(Ordering::Relaxed)) > 20_000 && now.saturating_sub(self.opened) > 20_000 {
            return Some("only digital silence for 20 seconds".into());
        }
        if self.follow_default {
            let default = cpal::default_host().default_input_device().map(|d| device_name(&d)).unwrap_or_default();
            if !default.is_empty() && default != self.device {
                return Some(format!("the default microphone is now {default}"));
            }
        }
        None
    }
}

/// Something that keeps the computer's audio flowing until dropped.
pub enum SystemCapture {
    #[allow(dead_code)]
    Cpal(cpal::Stream),
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    Tap {
        tap: Option<system_mac::TapStream>,
        /// The app being tapped (its bundle id) and its processes; empty for everything.
        app: String,
        processes: Vec<u32>,
        checked: Instant,
    },
    #[cfg(windows)]
    #[allow(dead_code)]
    App(system_win::AppLoopback),
}

/// What "couldn't find the app's sound" says before falling back to everything.
fn fallback_warning(name: &str, why: &str) -> String {
    format!("Recording everything this computer plays, not just {name}: {why}")
}

#[cfg(target_os = "macos")]
fn open_system(call: &CallAudio, tx: ChunkTx) -> Result<(SystemCapture, Option<String>)> {
    let (app, processes, warning) = match call {
        CallAudio::App { name, id } => {
            let p = system_mac::app_processes(id);
            if p.is_empty() {
                (String::new(), p, Some(fallback_warning(name, "its sound couldn't be found")))
            } else {
                log::info!("Recording {name}'s sound ({} processes)", p.len());
                (id.clone(), p, None)
            }
        }
        _ => (String::new(), Vec::new(), None),
    };
    let tap = system_mac::TapStream::start(tx, &processes)?;
    Ok((SystemCapture::Tap { tap: Some(tap), app, processes, checked: Instant::now() }, warning))
}

#[cfg(windows)]
fn open_system(call: &CallAudio, tx: ChunkTx) -> Result<(SystemCapture, Option<String>)> {
    let mut warning = None;
    if let CallAudio::App { name, id } = call {
        let procs = system_win::processes();
        let pids = system_win::app_pids(id, &procs);
        match system_win::root_pid(&pids, &procs) {
            Some(pid) => match system_win::AppLoopback::start(pid, tx.clone()) {
                Ok(l) => {
                    log::info!("Recording {name}'s sound (process {pid} and its children)");
                    return Ok((SystemCapture::App(l), None));
                }
                Err(e) => warning = Some(fallback_warning(name, &format!("{e:#}"))),
            },
            None => warning = Some(fallback_warning(name, "it isn't running")),
        }
    }
    // WASAPI records what an output device plays when it's opened as an input (loopback).
    let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
    let device = host.default_output_device().context("No speakers or headphones to record from")?;
    let config = device.default_output_config()?;
    Ok((SystemCapture::Cpal(cpal_stream(&device, config, Source::System, tx, None)?), warning))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_system(_call: &CallAudio, _tx: ChunkTx) -> Result<(SystemCapture, Option<String>)> {
    Err(anyhow!("recording the computer's audio isn't supported here"))
}

impl SystemCapture {
    /// Every few seconds: when the app has started more audio processes (a
    /// browser often does once the call connects), tap those too.
    #[allow(unused_variables)]
    fn refresh(&mut self, tx: &ChunkTx) {
        #[cfg(target_os = "macos")]
        if let SystemCapture::Tap { tap, app, processes, checked } = self {
            if app.is_empty() || checked.elapsed() < Duration::from_secs(5) {
                return;
            }
            *checked = Instant::now();
            let now = system_mac::app_processes(app);
            if now.is_empty() || now == *processes {
                return;
            }
            log::info!("{app} now plays from {} processes; tapping them", now.len());
            // The old tap goes first, or both would feed the mix at once.
            *tap = None;
            match system_mac::TapStream::start(tx.clone(), &now) {
                Ok(t) => {
                    *tap = Some(t);
                    *processes = now;
                }
                Err(e) => log::warn!("Couldn't tap {app} again: {e:#}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_keeps_the_length_in_proportion() {
        for rate in [16_000u32, 44_100, 48_000, 96_000] {
            let mut r = Resampler::new(rate);
            let mut out = VecDeque::new();
            for _ in 0..10 {
                r.push(&vec![0.5; rate as usize / 10], &mut out);
            }
            let n = out.len() as i64;
            assert!((n - RATE as i64).abs() <= 2, "{rate}: {n}");
            // The first few ramp up from silence; after that a constant stays constant.
            assert!(out.iter().skip(4).all(|s| (s - 0.5).abs() < 1e-6));
        }
    }

    #[test]
    fn a_file_is_written_with_silence_where_a_source_is_missing() {
        let dir = std::env::temp_dir().join(format!("rec-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("audio.opus");
        let (tx, rx) = bounded(64);
        let writer = OggOpusWriter::create(&file).unwrap();
        let levels = Arc::new(Levels::default());
        let h = std::thread::spawn({
            let l = levels.clone();
            move || mix(rx, writer, l)
        });
        // Half a second of a tone on the mic, nothing from the system.
        let tone: Vec<f32> = (0..24_000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        tx.send(Chunk { source: Source::Mic, rate: 48_000, samples: tone }).unwrap();
        drop(tx);
        let secs = h.join().unwrap().unwrap();
        assert!(secs >= 0.5 && secs < 0.8, "{secs}");
        let bytes = std::fs::read(&file).unwrap();
        assert_eq!(&bytes[..4], b"OggS");
        assert!(bytes.windows(8).any(|w| w == b"OpusHead"));
        assert!(!levels.system_heard.load(Ordering::Relaxed));
        assert!((crate::store::ogg_duration(&file).unwrap() - secs).abs() < 0.05);
        // DEBRIEF_KEEP_TEST_AUDIO=path keeps the file, to check it decodes.
        if let Ok(keep) = std::env::var("DEBRIEF_KEEP_TEST_AUDIO") {
            std::fs::copy(&file, keep).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
