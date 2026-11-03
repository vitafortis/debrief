//! One app's audio on Windows (10 version 2004 and later): a WASAPI process
//! loopback of the meeting app and everything it started, so the browser's or
//! the app's helper processes are included and nothing else is.

use super::{Chunk, ChunkTx, Source};
use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use windows::core::{implement, Interface, Ref, HRESULT, PWSTR};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::Storage::Packaging::Appx::GetPackageFamilyName;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, StructuredStorage::PROPVARIANT, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{CreateEventW, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION};

const RATE: u32 = 48_000;

pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub exe: String,
}

/// Every running process: its id, its parent's, and its exe name in lower case.
pub fn processes() -> Vec<Proc> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            out.push(Proc { pid: e.th32ProcessID, parent: e.th32ParentProcessID, exe: String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase() });
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// A Store app's package family ("MSTeams_8wekyb3d8bbwe"), if the process is one.
fn package_family(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut len = 0u32;
        let _ = GetPackageFamilyName(h, &mut len, None);
        let mut buf = vec![0u16; len.max(1) as usize];
        let r = GetPackageFamilyName(h, &mut len, Some(PWSTR(buf.as_mut_ptr())));
        let _ = CloseHandle(h);
        if r.is_err() || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]))
    }
}

/// The processes of the app `id` names: an exe path ("C:\…\Zoom.exe") or a
/// Store package family, as the microphone records give them.
pub fn app_pids(id: &str, procs: &[Proc]) -> Vec<u32> {
    if id.contains('\\') || id.to_lowercase().ends_with(".exe") {
        let exe = id.rsplit('\\').next().unwrap_or(id).to_lowercase();
        procs.iter().filter(|p| p.exe == exe).map(|p| p.pid).collect()
    } else {
        let family = id.to_lowercase();
        procs.iter().filter(|p| package_family(p.pid).is_some_and(|f| f.to_lowercase() == family)).map(|p| p.pid).collect()
    }
}

/// The app's top process: the one most of its processes descend from.
pub fn root_pid(pids: &[u32], procs: &[Proc]) -> Option<u32> {
    let parent: HashMap<u32, u32> = procs.iter().map(|p| (p.pid, p.parent)).collect();
    let mut counts: HashMap<u32, usize> = HashMap::new();
    for &pid in pids {
        let mut top = pid;
        let mut steps = 0;
        while let Some(&up) = parent.get(&top) {
            if up == 0 || up == top || !pids.contains(&up) || steps > 64 {
                break;
            }
            top = up;
            steps += 1;
        }
        *counts.entry(top).or_default() += 1;
    }
    counts.into_iter().max_by_key(|&(pid, n)| (n, std::cmp::Reverse(pid))).map(|(pid, _)| pid)
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Done(crossbeam_channel::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

/// PROPVARIANT holding a VT_BLOB, laid out by hand: the activation parameters.
#[repr(C)]
struct BlobVariant {
    vt: u16,
    reserved: [u16; 3],
    blob: BLOB,
}

unsafe fn activate(pid: u32) -> Result<IAudioClient> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId: pid, ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE },
        },
    };
    let var = BlobVariant {
        vt: windows::Win32::System::Variant::VT_BLOB.0,
        reserved: [0; 3],
        blob: BLOB { cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &params as *const _ as *mut u8 },
    };
    let (tx, rx) = crossbeam_channel::bounded(1);
    let handler: IActivateAudioInterfaceCompletionHandler = Done(tx).into();
    let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&var as *const BlobVariant as *const PROPVARIANT), &handler)?;
    rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| anyhow!("Windows didn't answer"))?;
    let mut hr = HRESULT(0);
    let mut unk = None;
    op.GetActivateResult(&mut hr, &mut unk)?;
    hr.ok()?;
    Ok(unk.context("no audio client")?.cast()?)
}

/// Captures the process tree under `pid` until dropped.
pub struct AppLoopback {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl AppLoopback {
    pub fn start(pid: u32, tx: ChunkTx) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<()>>(1);
        let s = stop.clone();
        let thread = std::thread::Builder::new().name("app-audio".into()).spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if let Err(e) = run(pid, &tx, &s, &ready_tx) {
                log::warn!("App audio: {e:#}");
                let _ = ready_tx.try_send(Err(e));
            }
            CoUninitialize();
        })?;
        match ready_rx.recv_timeout(std::time::Duration::from_secs(8)) {
            Ok(Ok(())) => Ok(Self { stop, thread: Some(thread) }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                stop.store(true, Ordering::Relaxed);
                Err(anyhow!("the app's audio didn't start"))
            }
        }
    }
}

impl Drop for AppLoopback {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

unsafe fn run(pid: u32, tx: &ChunkTx, stop: &AtomicBool, ready: &crossbeam_channel::Sender<Result<()>>) -> Result<()> {
    let client = activate(pid)?;
    // Process loopback can't report its own format: ask for 16-bit stereo at 48 kHz.
    let fmt = WAVEFORMATEX { wFormatTag: WAVE_FORMAT_PCM as u16, nChannels: 2, nSamplesPerSec: RATE, nAvgBytesPerSec: RATE * 4, nBlockAlign: 4, wBitsPerSample: 16, cbSize: 0 };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        2_000_000, // 200 ms, in 100 ns units
        0,
        &fmt,
        None,
    )?;
    let event = CreateEventW(None, false, false, None)?;
    client.SetEventHandle(event)?;
    let capture: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    let _ = ready.try_send(Ok(()));
    while !stop.load(Ordering::Relaxed) {
        if WaitForSingleObject(event, 100) != WAIT_OBJECT_0 {
            continue;
        }
        loop {
            let n = capture.GetNextPacketSize()?;
            if n == 0 {
                break;
            }
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let samples: Vec<f32> = if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                vec![0.0; frames as usize]
            } else {
                let pcm = std::slice::from_raw_parts(data as *const i16, frames as usize * 2);
                pcm.chunks_exact(2).map(|f| (f[0] as f32 + f[1] as f32) / 65536.0).collect()
            };
            capture.ReleaseBuffer(frames)?;
            let _ = tx.try_send(Chunk { source: Source::System, rate: RATE, samples });
        }
    }
    let _ = client.Stop();
    let _ = CloseHandle(event);
    Ok(())
}
