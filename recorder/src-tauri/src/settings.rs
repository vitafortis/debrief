//! Everything the Settings window edits, kept as JSON in the app's config folder.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// Start recording straight away.
    Record,
    /// Pop up and ask.
    Ask,
    /// Leave it alone.
    Ignore,
}

/// What to do when an app starts using the microphone. `app` matches the
/// app's name or bundle id, ignoring case ("zoom" matches "zoom.us").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRule {
    pub app: String,
    pub action: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Debrief, e.g. https://debrief.armgrp.dev
    pub server_url: String,
    /// Tried when the main one can't be reached, e.g. http://debrief.lan:3000 at home.
    pub fallback_url: String,
    pub api_key: String,
    /// How this computer shows up in Debrief. Tagging by device is set there.
    pub device_name: String,

    /// Watch for apps using the microphone.
    pub detect_meetings: bool,
    /// For apps without a rule.
    pub default_action: Action,
    pub rules: Vec<AppRule>,
    /// Stop once the meeting app has let go of the microphone for this long.
    pub stop_after_secs: u64,

    /// Microphone by name; empty for the system default.
    pub microphone: String,
    /// Also record what the computer plays (the other side of the call).
    pub capture_system_audio: bool,

    /// Where recordings are written before (and after) upload.
    pub recordings_dir: String,
    /// Days to keep a recording here once Debrief has all of it. 0 deletes it straight away.
    pub keep_local_days: u32,

    pub launch_at_login: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            fallback_url: String::new(),
            api_key: String::new(),
            device_name: default_device_name(),
            detect_meetings: true,
            default_action: Action::Ask,
            rules: vec![
                AppRule { app: "zoom".into(), action: Action::Ask },
                AppRule { app: "Microsoft Teams".into(), action: Action::Ask },
                AppRule { app: "Webex".into(), action: Action::Ask },
                AppRule { app: "Slack".into(), action: Action::Ask },
                AppRule { app: "FaceTime".into(), action: Action::Ask },
                AppRule { app: "Discord".into(), action: Action::Ignore },
            ],
            stop_after_secs: 45,
            microphone: String::new(),
            capture_system_audio: true,
            recordings_dir: String::new(),
            keep_local_days: 14,
            launch_at_login: true,
        }
    }
}

pub fn default_device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .map(|h| h.trim_end_matches(".local").to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "recorder".into())
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        // The API key is in here: owner-only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// The rule for an app, by name or bundle id; the default when none matches.
    pub fn action_for(&self, name: &str, bundle: &str) -> Action {
        let (n, b) = (name.to_lowercase(), bundle.to_lowercase());
        self.rules
            .iter()
            .find(|r| {
                let a = r.app.trim().to_lowercase();
                !a.is_empty() && (n.contains(&a) || b.contains(&a))
            })
            .map(|r| r.action)
            .unwrap_or(self.default_action)
    }

    /// Sets (or adds) the rule for an app, from the popup's "Always" / "Never".
    pub fn set_rule(&mut self, app: &str, action: Action) {
        let key = app.to_lowercase();
        if let Some(r) = self.rules.iter_mut().find(|r| {
            let a = r.app.trim().to_lowercase();
            !a.is_empty() && key.contains(&a)
        }) {
            r.action = action;
        } else {
            self.rules.push(AppRule { app: app.to_string(), action });
        }
    }

    pub fn recordings_path(&self, fallback: &Path) -> PathBuf {
        if self.recordings_dir.trim().is_empty() {
            fallback.to_path_buf()
        } else {
            PathBuf::from(self.recordings_dir.trim())
        }
    }

    pub fn servers(&self) -> Vec<String> {
        [&self.server_url, &self.fallback_url]
            .into_iter()
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_match_name_or_bundle_and_fall_back_to_the_default() {
        let mut s = Settings::default();
        assert_eq!(s.action_for("zoom.us", "us.zoom.xos"), Action::Ask);
        assert_eq!(s.action_for("Discord", "com.hnc.Discord"), Action::Ignore);
        assert_eq!(s.action_for("Google Chrome", "com.google.Chrome"), Action::Ask);
        s.default_action = Action::Record;
        assert_eq!(s.action_for("Google Chrome", "com.google.Chrome"), Action::Record);
        assert_eq!(s.action_for("Discord", ""), Action::Ignore);
        s.set_rule("Google Chrome", Action::Ignore);
        assert_eq!(s.action_for("Google Chrome", ""), Action::Ignore);
        s.set_rule("zoom.us", Action::Record);
        assert_eq!(s.action_for("zoom.us", ""), Action::Record);
        assert_eq!(s.rules.iter().filter(|r| r.app.to_lowercase().contains("zoom")).count(), 1);
    }
}
