//! Recordings on this computer: <dir>/<id>/audio.opus with a state.json
//! saying how far the upload got. Nothing is deleted until Debrief has
//! every byte, and then only after `keep_local_days`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Local {
    pub id: Uuid,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_secs: Option<f64>,
    /// What was using the microphone, when that's what started it.
    pub app: Option<String>,
    pub title: Option<String>,
    /// Bytes Debrief has.
    #[serde(default)]
    pub uploaded: u64,
    #[serde(default)]
    pub server_started: bool,
    /// Debrief has all of it.
    #[serde(default)]
    pub done_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_error: Option<String>,
}

pub const AUDIO: &str = "audio.opus";

impl Local {
    pub fn new(app: Option<String>, title: Option<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            started_at: Utc::now(),
            ended_at: None,
            duration_secs: None,
            app,
            title,
            uploaded: 0,
            server_started: false,
            done_at: None,
            last_error: None,
        }
    }

    pub fn dir(&self, root: &Path) -> PathBuf {
        root.join(self.id.to_string())
    }

    pub fn audio(&self, root: &Path) -> PathBuf {
        self.dir(root).join(AUDIO)
    }

    pub fn save(&self, root: &Path) -> anyhow::Result<()> {
        let dir = self.dir(root);
        std::fs::create_dir_all(&dir)?;
        let tmp = dir.join("state.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, dir.join("state.json"))?;
        Ok(())
    }
}

pub fn list(root: &Path) -> Vec<Local> {
    let mut out: Vec<Local> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path().join("state.json")).ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect();
    out.sort_by_key(|l| l.started_at);
    out
}

/// Recordings the app was killed in the middle of: end them where the file ends.
pub fn recover(root: &Path, current: Option<Uuid>) {
    for mut l in list(root) {
        if l.ended_at.is_some() || Some(l.id) == current {
            continue;
        }
        let audio = l.audio(root);
        l.duration_secs = Some(ogg_duration(&audio).unwrap_or(0.0));
        l.ended_at = std::fs::metadata(&audio).and_then(|m| m.modified()).ok().map(DateTime::<Utc>::from).or(Some(Utc::now()));
        log::info!("Recovered an unfinished recording {} ({:.0} s)", l.id, l.duration_secs.unwrap_or(0.0));
        let _ = l.save(root);
    }
}

/// Deletes uploaded recordings older than `days` (0: as soon as they're uploaded).
pub fn clean(root: &Path, days: u32) {
    let cutoff = Utc::now() - chrono::Duration::days(days as i64);
    for l in list(root) {
        if let Some(done) = l.done_at {
            if done <= cutoff {
                log::info!("Removing uploaded recording {}", l.id);
                let _ = std::fs::remove_dir_all(l.dir(root));
            }
        }
    }
}

/// Seconds of audio in an Ogg Opus file, from its last page's granule position.
pub fn ogg_duration(path: &Path) -> Option<f64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let tail = len.min(256 * 1024);
    f.seek(SeekFrom::Start(len - tail)).ok()?;
    let mut buf = Vec::with_capacity(tail as usize);
    f.read_to_end(&mut buf).ok()?;
    let mut i = buf.len().checked_sub(27)?;
    loop {
        if &buf[i..i + 4] == b"OggS" {
            let g = u64::from_le_bytes(buf[i + 6..i + 14].try_into().ok()?);
            if g != u64::MAX {
                return Some(g as f64 / 48_000.0);
            }
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    }
}
