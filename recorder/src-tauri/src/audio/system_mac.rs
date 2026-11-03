//! The Mac's own audio (the other side of the call) through a Core Audio
//! process tap, macOS 14.2+: everything it plays, or just the meeting app's
//! processes. The first time, macOS asks for permission to record system
//! audio; without it the tap is silent.
//!
//! Adapted from Meetily's core_audio.rs (MIT, Copyright (c) 2024 Zackriya Solutions).

use super::{Chunk, ChunkTx, Source};
use anyhow::{anyhow, Result};
use cidre::{arc, av, cat, cf, core_audio as ca, ns, os};

struct Ctx {
    format: arc::R<av::AudioFormat>,
    tx: ChunkTx,
    rate: u32,
}

pub struct TapStream {
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
}

extern "C" fn io_proc(
    device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    ctx: Option<&mut Ctx>,
) -> os::Status {
    let Some(ctx) = ctx else { return os::Status::NO_ERR };
    let rate = device.nominal_sample_rate().map(|r| r as u32).unwrap_or(ctx.rate);
    let buf = &input.buffers[0];
    let n = buf.data_bytes_size as usize / std::mem::size_of::<f32>();
    if n > 0 && !buf.data.is_null() && ctx.format.common_format() == av::audio::CommonFormat::PcmF32 {
        let data = unsafe { std::slice::from_raw_parts(buf.data as *const f32, n) };
        let channels = (buf.number_channels as usize).max(1);
        let samples = super::to_mono_f32(data, channels);
        let _ = ctx.tx.try_send(Chunk { source: Source::System, rate, samples });
    }
    os::Status::NO_ERR
}

impl TapStream {
    /// Taps the given Core Audio process objects, or everything the Mac plays when there are none.
    pub fn start(tx: ChunkTx, processes: &[u32]) -> Result<Self> {
        let output = ca::System::default_output_device().map_err(|e| anyhow!("no output device ({e:?})"))?;
        let output_uid = output.uid().map_err(|e| anyhow!("output device has no id ({e:?})"))?;

        let desc = if processes.is_empty() {
            // Everything the Mac plays, mixed to mono.
            ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new())
        } else {
            let ids: Vec<arc::R<ns::Number>> = processes.iter().map(|&p| ns::Number::with_u32(p)).collect();
            ca::TapDesc::with_mono_mixdown_of_processes(&ns::Array::from_slice_retained(&ids))
        };
        let tap = desc
            .create_process_tap()
            .map_err(|e| anyhow!("macOS refused the audio tap ({e:?}); needs macOS 14.2 or later"))?;
        let asbd = tap.asbd().map_err(|e| anyhow!("tap format ({e:?})"))?;
        let format = av::AudioFormat::with_asbd(&asbd).ok_or_else(|| anyhow!("unsupported tap format"))?;

        let sub_tap = cf::DictionaryOf::with_keys_values(&[ca::sub_device_keys::uid()], &[tap.uid().map_err(|e| anyhow!("{e:?}"))?.as_type_ref()]);
        // Only the tap, not the output device too, or every sound is captured twice.
        let agg = cf::DictionaryOf::with_keys_values(
            &[
                ca::aggregate_device_keys::is_private(),
                ca::aggregate_device_keys::is_stacked(),
                ca::aggregate_device_keys::tap_auto_start(),
                ca::aggregate_device_keys::name(),
                ca::aggregate_device_keys::main_sub_device(),
                ca::aggregate_device_keys::uid(),
                ca::aggregate_device_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                cf::str!(c"debrief-recorder-tap").as_type_ref(),
                &output_uid,
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        let mut ctx = Box::new(Ctx { format, tx, rate: asbd.sample_rate as u32 });
        let device = ca::AggregateDevice::with_desc(&agg).map_err(|e| anyhow!("aggregate device ({e:?})"))?;
        let proc_id = device.create_io_proc_id(io_proc, Some(&mut *ctx)).map_err(|e| anyhow!("io proc ({e:?})"))?;
        let started = ca::device_start(device, Some(proc_id)).map_err(|e| anyhow!("starting the tap ({e:?})"))?;
        Ok(Self { _device: started, _ctx: ctx, _tap: tap })
    }
}

/// Where an app's sound actually comes from, by bundle id: the app and its
/// helpers ("com.google.Chrome" covers "com.google.Chrome.helper"), and for
/// Apple's apps the system process that plays their calls.
pub fn sound_bundles(app_id: &str) -> Vec<String> {
    let id = app_id.to_lowercase();
    let base = id.find(".helper").map(|i| id[..i].to_string()).unwrap_or(id);
    if base.is_empty() {
        return Vec::new();
    }
    let mut out = vec![base.clone()];
    match base.as_str() {
        "com.apple.facetime" => out.push("com.apple.avconferenced".into()),
        "com.apple.safari" => out.push("com.apple.webkit.gpu".into()),
        _ => {}
    }
    out
}

/// The Core Audio process objects playing (or able to play) the app's sound.
pub fn app_processes(app_id: &str) -> Vec<u32> {
    let bundles = sound_bundles(app_id);
    if bundles.is_empty() {
        return Vec::new();
    }
    let me = std::process::id() as i32;
    let mut out: Vec<u32> = ca::System::processes()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.pid().is_ok_and(|pid| pid != me))
        .filter(|p| p.bundle_id().is_ok_and(|b| {
            let b = b.to_string().to_lowercase();
            bundles.iter().any(|x| b.starts_with(x.as_str()))
        }))
        .map(|p| p.0 .0)
        .collect();
    out.sort_unstable();
    out
}
