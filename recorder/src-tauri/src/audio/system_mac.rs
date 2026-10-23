//! The Mac's own audio (the other side of the call) through a Core Audio
//! process tap, macOS 14.2+. The first time, macOS asks for permission to
//! record system audio; without it the tap is silent.
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
    pub fn start(tx: ChunkTx) -> Result<Self> {
        let output = ca::System::default_output_device().map_err(|e| anyhow!("no output device ({e:?})"))?;
        let output_uid = output.uid().map_err(|e| anyhow!("output device has no id ({e:?})"))?;

        // Everything the Mac plays, mixed to mono.
        let desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
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
