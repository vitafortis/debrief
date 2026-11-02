//! Checking GitHub for a newer recorder. The app isn't signed, so it can't
//! update itself: it says there's an update and opens the download.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const REPO: &str = "vitafortis/debrief";
const TAG_PREFIX: &str = "recorder-v";
/// What a `pnpm tauri dev` build calls itself; release builds get theirs from the workflow.
pub const DEV_VERSION: &str = "0.1.0";

/// major.minor.patch, compared numerically.
pub type Version = [u64; 3];

/// The latest check, shared by the tray menu and Settings.
#[derive(Debug, Clone, Serialize)]
pub struct Updates {
    /// This app's version.
    pub current: String,
    pub state: &'static str, // "idle" | "checking" | "done" | "failed" | "dev"
    pub error: Option<String>,
    /// A newer release, once a check has found one.
    pub available: Option<Release>,
}

impl Updates {
    pub fn new(current: String) -> Self {
        let state = if current == DEV_VERSION { "dev" } else { "idle" };
        Self { current, state, error: None, available: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Release {
    pub version: String,
    pub tag: String,
    /// The installer for this platform, or the release page where there isn't one.
    pub download_url: String,
}

/// The fields we need from GitHub's list of releases.
#[derive(Debug, Deserialize)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
}

pub fn parse_version(s: &str) -> Option<Version> {
    let mut parts = s.trim().split('.').map(|p| p.parse::<u64>().ok());
    let v = [parts.next()??, parts.next()??, parts.next()??];
    parts.next().is_none().then_some(v)
}

/// The highest published recorder release. GitHub's "latest" flag isn't
/// trusted: two release runs finishing out of order can leave it on an older one.
pub fn newest(releases: &[GhRelease]) -> Option<(Version, &str)> {
    releases
        .iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| Some((parse_version(r.tag_name.strip_prefix(TAG_PREFIX)?)?, r.tag_name.as_str())))
        .max_by_key(|(v, _)| *v)
}

/// The installer the release workflow builds for this platform.
fn asset() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("Debrief-Recorder-macOS.dmg")
    } else if cfg!(windows) {
        Some("Debrief-Recorder-Windows.exe")
    } else {
        None
    }
}

fn release_for(tag: &str) -> Release {
    let download_url = match asset() {
        Some(a) => format!("https://github.com/{REPO}/releases/download/{tag}/{a}"),
        None => format!("https://github.com/{REPO}/releases/tag/{tag}"),
    };
    Release { version: tag.trim_start_matches(TAG_PREFIX).to_string(), tag: tag.to_string(), download_url }
}

/// Asks GitHub. Some(release) when it's newer than `current`.
pub fn check(current: &str) -> Result<Option<Release>> {
    let current_v = parse_version(current).ok_or_else(|| anyhow!("This version ({current}) isn't major.minor.patch"))?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=30");
    let releases: Vec<GhRelease> = agent
        .get(&url)
        .header("User-Agent", &format!("debrief-recorder/{current}"))
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| anyhow!("Couldn't reach GitHub: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| anyhow!("Unexpected reply from GitHub: {e}"))?;
    let (v, tag) = newest(&releases).ok_or_else(|| anyhow!("GitHub lists no recorder releases"))?;
    Ok((v > current_v).then(|| release_for(tag)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, draft: bool, prerelease: bool) -> GhRelease {
        GhRelease { tag_name: tag.into(), draft, prerelease }
    }

    #[test]
    fn versions_compare_as_numbers() {
        assert_eq!(parse_version("0.1.10"), Some([0, 1, 10]));
        assert!(parse_version("0.1.10").unwrap() > parse_version("0.1.9").unwrap());
        assert!(parse_version("1.0.0").unwrap() > parse_version("0.99.99").unwrap());
        assert_eq!(parse_version("0.1"), None);
        assert_eq!(parse_version("0.1.2.3"), None);
        assert_eq!(parse_version("0.1.x"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn newest_skips_drafts_prereleases_and_other_tags() {
        let list = vec![
            rel("recorder-v0.1.9", false, false),
            rel("recorder-v0.1.10", false, false),
            rel("recorder-v0.1.12", true, false),
            rel("recorder-v0.1.11", false, true),
            rel("v9.9.9", false, false),
            rel("recorder-vnext", false, false),
            rel("recorder-v0.1.2", false, false),
        ];
        assert_eq!(newest(&list), Some(([0, 1, 10], "recorder-v0.1.10")));
        assert_eq!(newest(&[rel("web-v1.0.0", false, false)]), None);
        assert_eq!(newest(&[]), None);
    }

    #[test]
    fn release_links_point_at_the_tag() {
        let r = release_for("recorder-v0.1.12");
        assert_eq!(r.version, "0.1.12");
        assert!(r.download_url.starts_with("https://github.com/vitafortis/debrief/releases/"));
        assert!(r.download_url.contains("recorder-v0.1.12"));
    }

    #[test]
    fn dev_builds_are_marked() {
        assert_eq!(Updates::new("0.1.0".into()).state, "dev");
        assert_eq!(Updates::new("0.1.10".into()).state, "idle");
    }
}
