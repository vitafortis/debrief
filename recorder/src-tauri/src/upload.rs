//! Streams recordings to Debrief: while they're being made, and afterwards
//! for anything that couldn't get through (no network, server down). Every
//! step can be repeated, so being cut off anywhere just means trying again.

use crate::settings::Settings;
use crate::store::{self, Local};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

const CHUNK: u64 = 4 * 1024 * 1024;
/// While recording, wait for this much new audio (about 20 s) before sending.
const LIVE_MIN: u64 = 128 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    /// Has a server and an API key; without them nothing is sent.
    pub configured: bool,
    /// None until the first attempt.
    pub online: Option<bool>,
    pub server: Option<String>,
    pub waiting: usize,
    pub last_error: Option<String>,
}

pub struct Uploader {
    pub status: Arc<Mutex<Status>>,
    wake: crossbeam_channel::Sender<()>,
}

/// Debrief stopped waiting for the rest of this recording and transcribed what it had.
#[derive(Debug)]
struct Finished;

impl std::fmt::Display for Finished {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("Debrief already finished this recording")
    }
}

impl std::error::Error for Finished {}

fn configured(s: &Settings) -> bool {
    !s.api_key.trim().is_empty() && !s.servers().is_empty()
}

#[derive(Deserialize)]
struct Offset {
    offset: Option<u64>,
    error: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into()
}

/// What `GET /api/recorder/ping` says, for "Test connection".
pub fn ping(server: &str, key: &str, device: &str) -> Result<String> {
    let url = format!("{}/api/recorder/ping", server.trim().trim_end_matches('/'));
    let mut res = agent()
        .get(&url)
        .query("device", device)
        .header("Authorization", &format!("Bearer {}", key.trim()))
        .call()
        .map_err(|e| anyhow!("Couldn't reach {url}: {e}"))?;
    let status = res.status().as_u16();
    let body: serde_json::Value = res.body_mut().read_json().unwrap_or_default();
    match status {
        200 => Ok(format!(
            "Connected with key \"{}\". This computer is \"{}\"{}.",
            body["key"].as_str().unwrap_or("?"),
            body["device"].as_str().unwrap_or(device),
            body["context"].as_str().map(|c| format!(", tagged {c}")).unwrap_or_else(|| ", not tagged (set that in Debrief → Settings → Devices)".into())
        )),
        401 => Err(anyhow!("Debrief doesn't know that API key.")),
        404 => Err(anyhow!("That server doesn't look like Debrief (no /api/recorder).")),
        s => Err(anyhow!("{s}: {}", body["error"].as_str().unwrap_or("unexpected reply"))),
    }
}

struct Client<'a> {
    agent: ureq::Agent,
    server: &'a str,
    key: &'a str,
}

impl Client<'_> {
    fn url(&self, id: Uuid, tail: &str) -> String {
        format!("{}/api/recorder/recordings/{id}{tail}", self.server)
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.key)
    }

    fn start(&self, l: &Local, device: &str) -> Result<u64> {
        let body = serde_json::json!({
            "device": device,
            "startedAt": l.started_at.to_rfc3339(),
            "title": l.title,
            "app": l.app,
            "format": "opus",
        });
        let mut res = self.agent.put(&self.url(l.id, "")).header("Authorization", &self.auth()).send_json(&body)?;
        let status = res.status().as_u16();
        let o: Offset = res.body_mut().read_json().unwrap_or(Offset { offset: None, error: None });
        if status != 200 {
            return Err(anyhow!("{status}: {}", o.error.unwrap_or_default()));
        }
        Ok(o.offset.unwrap_or(0))
    }

    /// Sends bytes from `offset`; returns where the server's copy now ends.
    fn append(&self, l: &Local, file: &Path, offset: u64, upto: u64) -> Result<u64> {
        let len = (upto - offset).min(CHUNK);
        let mut f = std::fs::File::open(file)?;
        f.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; len as usize];
        f.read_exact(&mut buf)?;
        let mut res = self
            .agent
            .patch(&self.url(l.id, "/audio"))
            .header("Authorization", &self.auth())
            .header("Upload-Offset", &offset.to_string())
            .header("Content-Type", "application/octet-stream")
            .send(&buf[..])?;
        let status = res.status().as_u16();
        let o: Offset = res.body_mut().read_json().unwrap_or(Offset { offset: None, error: None });
        match (status, o.offset) {
            (200, Some(n)) => Ok(n),
            (409, _) if o.error.as_deref().is_some_and(|e| e.contains("finished")) => Err(Finished.into()),
            // Out of step (a lost reply, a retry): carry on from where the server is.
            (409, Some(n)) => Ok(n),
            _ => Err(anyhow!("{status}: {}", o.error.unwrap_or_default())),
        }
    }

    /// Sends one shared screen; whether Debrief took it, skipped it, or doesn't take them.
    fn screen(&self, l: &Local, ms: u64, file: &Path) -> Result<Sent> {
        let body = std::fs::read(file)?;
        let mut res = self
            .agent
            .put(&self.url(l.id, &format!("/screens/{ms}")))
            .header("Authorization", &self.auth())
            .header("Content-Type", "image/jpeg")
            .send(&body[..])?;
        let status = res.status().as_u16();
        let o: Offset = res.body_mut().read_json().unwrap_or(Offset { offset: None, error: None });
        match status {
            200 => Ok(Sent::Taken),
            // An older Debrief, or a recording it has finished with or deleted.
            404 | 405 | 409 => Ok(Sent::NotTaken),
            400 | 413 | 415 => {
                log::warn!("Debrief refused screen {ms} of {}: {}", l.id, o.error.unwrap_or_default());
                Ok(Sent::Skipped)
            }
            s => Err(anyhow!("{s}: {}", o.error.unwrap_or_default())),
        }
    }

    fn complete(&self, l: &Local, bytes: u64) -> Result<()> {
        let body = serde_json::json!({ "bytes": bytes, "durationSecs": l.duration_secs.unwrap_or(0.0), "title": l.title });
        let mut res = self.agent.post(&self.url(l.id, "/complete")).header("Authorization", &self.auth()).send_json(&body)?;
        let status = res.status().as_u16();
        let o: Offset = res.body_mut().read_json().unwrap_or(Offset { offset: None, error: None });
        if status != 200 {
            return Err(anyhow!("{status}: {}", o.error.unwrap_or_default()));
        }
        Ok(())
    }
}

enum Sent {
    Taken,
    Skipped,
    NotTaken,
}

/// Sends the shared screens saved since last time, in order.
fn push_screens(c: &Client, root: &Path, l: &mut Local) -> Result<()> {
    if l.screens_off {
        return Ok(());
    }
    for (ms, path) in crate::screens::list(&l.dir(root)).into_iter().skip(l.screens_sent) {
        match c.screen(l, ms, &path)? {
            Sent::Taken | Sent::Skipped => l.screens_sent += 1,
            Sent::NotTaken => l.screens_off = true,
        }
        l.save(root)?;
        if l.screens_off {
            break;
        }
    }
    Ok(())
}

/// Moves one recording as far along as it can go. Returns whether it's finished.
fn push_one(c: &Client, root: &Path, l: &mut Local, device: &str, live: bool) -> Result<bool> {
    let file = l.audio(root);
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    if live && size < l.uploaded + LIVE_MIN {
        return Ok(false);
    }
    if !l.server_started {
        l.uploaded = c.start(l, device)?;
        l.server_started = true;
        l.save(root)?;
    }
    while l.uploaded < size {
        let before = l.uploaded;
        l.uploaded = match c.append(l, &file, l.uploaded, size) {
            Ok(n) => n,
            // Nothing more will be taken, so stop trying: it's in Debrief as far as it got.
            Err(e) if e.is::<Finished>() => {
                l.done_at = Some(chrono::Utc::now());
                l.last_error = Some("Debrief stopped waiting for the rest and transcribed what it had.".into());
                l.save(root)?;
                log::warn!("Recording {} was finished by Debrief at {before} of {size} bytes", l.id);
                return Ok(true);
            }
            Err(e) => return Err(e),
        };
        l.save(root)?;
        if l.uploaded == before {
            return Err(anyhow!("the server didn't take any of the chunk"));
        }
    }
    // Before completing, so they're there when the transcriber reads the recording.
    push_screens(c, root, l)?;
    if l.ended_at.is_some() && !live {
        c.complete(l, size)?;
        l.done_at = Some(chrono::Utc::now());
        l.last_error = None;
        l.save(root)?;
        log::info!("Uploaded recording {} ({size} bytes)", l.id);
        return Ok(true);
    }
    Ok(false)
}

impl Uploader {
    pub fn start(settings: Arc<RwLock<Settings>>, root: Arc<RwLock<PathBuf>>, current: Arc<Mutex<Option<Uuid>>>) -> Self {
        let status = Arc::new(Mutex::new(Status { configured: configured(&settings.read().unwrap()), ..Status::default() }));
        let (wake, woken) = crossbeam_channel::bounded::<()>(1);
        let st = status.clone();
        std::thread::Builder::new()
            .name("upload".into())
            .spawn(move || {
                let mut backoff = Duration::from_secs(5);
                let mut last_clean = Instant::now() - Duration::from_secs(3600);
                loop {
                    let s = settings.read().unwrap().clone();
                    let dir = root.read().unwrap().clone();
                    let live_id = *current.lock().unwrap();
                    let pending: Vec<Local> = store::list(&dir).into_iter().filter(|l| l.done_at.is_none()).collect();
                    let mut failed = false;
                    let ready = configured(&s);
                    st.lock().unwrap().configured = ready;
                    if !pending.is_empty() && ready {
                        let mut last_err = None;
                        let mut used = None;
                        for server in s.servers() {
                            let c = Client { agent: agent(), server: &server, key: s.api_key.trim() };
                            let (mut unreachable, mut stuck) = (None, None);
                            for mut l in pending.clone() {
                                let live = Some(l.id) == live_id;
                                if let Err(e) = push_one(&c, &dir, &mut l, &s.device_name, live) {
                                    log::warn!("Upload of {} to {server} failed: {e:#}", l.id);
                                    let msg = format!("{e}");
                                    l.last_error = Some(msg.clone());
                                    let _ = l.save(&dir);
                                    // No connection at all: try the next server with everything.
                                    if e.downcast_ref::<ureq::Error>().is_some() {
                                        unreachable = Some(msg);
                                        break;
                                    }
                                    // Something about this one recording: the others still go.
                                    stuck = Some(msg);
                                }
                            }
                            if unreachable.is_some() {
                                last_err = unreachable;
                                continue;
                            }
                            used = Some(server.clone());
                            last_err = stuck;
                            break;
                        }
                        failed = last_err.is_some();
                        let mut st = st.lock().unwrap();
                        st.online = Some(used.is_some());
                        st.server = used;
                        st.last_error = last_err;
                    }
                    {
                        let left = store::list(&dir).iter().filter(|l| l.done_at.is_none() && Some(l.id) != live_id).count();
                        st.lock().unwrap().waiting = left;
                    }
                    if last_clean.elapsed() > Duration::from_secs(3600) {
                        store::clean(&dir, s.keep_local_days);
                        last_clean = Instant::now();
                    }
                    let wait = if failed {
                        backoff = (backoff * 2).min(Duration::from_secs(300));
                        backoff
                    } else {
                        backoff = Duration::from_secs(5);
                        Duration::from_secs(if live_id.is_some() { 10 } else { 30 })
                    };
                    let _ = woken.recv_timeout(wait);
                    if s.keep_local_days == 0 {
                        store::clean(&dir, 0);
                    }
                }
            })
            .expect("upload thread");
        Self { status, wake }
    }

    /// Try now (a recording just ended, settings changed).
    pub fn nudge(&self) {
        let _ = self.wake.try_send(());
    }
}
