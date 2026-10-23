//! Recording: the microphone and the computer's own audio, mixed into a
//! stereo Ogg Opus file (left: you, right: the call) that only ever grows,
//! so it can be uploaded while it's being written.

mod ogg_opus;
#[cfg(target_os = "macos")]
mod system_mac;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, Sender};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub use ogg_opus::OggOpusWriter;

pub const RATE: u32 = 48_000;
const FRAME: usize = 960; // 20 ms at 48 kHz
const LATENCY: usize = RATE as usize / 5; // how far behind real time the mix runs, for late buffers
const MAX_BACKLOG: usize = RATE as usize / 2; // past this a source is drifting: drop its oldest audio

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
}

impl Recording {
    /// Starts recording into `file`. The microphone is required; the computer's audio is best-effort.
    pub fn start(file: &Path, microphone: &str, system_audio: bool) -> Result<Self> {
        let (tx, rx) = bounded::<Chunk>(512);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let (ready_tx, ready_rx) = bounded::<Result<Vec<String>>>(1);
        let levels = Arc::new(Levels::default());

        // Streams aren't Send on every platform: they live on their own thread until stopped.
        let mic_name = microphone.to_string();
        let capture = std::thread::Builder::new().name("capture".into()).spawn(move || {
            let mut warnings = Vec::new();
            let mic = match open_mic(&mic_name, tx.clone()) {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let system = if system_audio {
                match open_system(tx.clone()) {
                    Ok(s) => Some(s),
                    Err(e) => {
                        log::warn!("No system audio: {e:#}");
                        warnings.push(format!("Only the microphone is being recorded: {e}"));
                        None
                    }
                }
            } else {
                None
            };
            drop(tx);
            let _ = ready_tx.send(Ok(warnings));
            let _ = stop_rx.recv();
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
        Ok(Finished { duration_secs: secs, system_heard: self.levels.system_heard.load(Ordering::Relaxed) })
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
        if c.source == Source::System && peak > 0.0005 {
            levels.system_heard.store(true, Ordering::Relaxed);
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

/// An input stream (or, on Windows, a loopback of an output device) feeding the mixer.
fn cpal_stream(device: &cpal::Device, config: cpal::SupportedStreamConfig, source: Source, tx: ChunkTx) -> Result<cpal::Stream> {
    let channels = config.channels() as usize;
    let rate = config.sample_rate();
    let cfg: cpal::StreamConfig = config.config();
    let err = move |e| log::warn!("{source:?} stream error: {e}");
    macro_rules! build {
        ($t:ty, $conv:expr) => {{
            let tx = tx.clone();
            device.build_input_stream::<$t, _, _>(
                cfg.clone(),
                move |data: &[$t], _| {
                    let f: Vec<f32> = data.iter().map($conv).collect();
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

fn open_mic(name: &str, tx: ChunkTx) -> Result<cpal::Stream> {
    let host = cpal::default_host();
    let device = if name.trim().is_empty() {
        None
    } else {
        host.input_devices()?.find(|d| d.description().map(|x| x.name() == name).unwrap_or(false))
    }
    .or_else(|| host.default_input_device())
    .context("No microphone found")?;
    let config = device.default_input_config().context("Couldn't open the microphone")?;
    cpal_stream(&device, config, Source::Mic, tx)
}

/// Something that keeps the computer's audio flowing until dropped.
pub enum SystemCapture {
    #[allow(dead_code)]
    Cpal(cpal::Stream),
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    Tap(system_mac::TapStream),
}

#[cfg(target_os = "macos")]
fn open_system(tx: ChunkTx) -> Result<SystemCapture> {
    Ok(SystemCapture::Tap(system_mac::TapStream::start(tx)?))
}

#[cfg(windows)]
fn open_system(tx: ChunkTx) -> Result<SystemCapture> {
    // WASAPI records what an output device plays when it's opened as an input (loopback).
    let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
    let device = host.default_output_device().context("No speakers or headphones to record from")?;
    let config = device.default_output_config()?;
    Ok(SystemCapture::Cpal(cpal_stream(&device, config, Source::System, tx)?))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_system(_tx: ChunkTx) -> Result<SystemCapture> {
    Err(anyhow!("recording the computer's audio isn't supported here"))
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
