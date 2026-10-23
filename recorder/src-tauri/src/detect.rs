//! Which apps are using the microphone right now: how a meeting is noticed.
//!
//! macOS asks Core Audio which processes are running audio input (14.2+);
//! Windows reads the privacy "microphone in use" records in the registry.

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MicUser {
    /// What to show and match rules on: "zoom.us", "Microsoft Teams", "Discord".
    pub name: String,
    /// macOS bundle id or the Windows exe path; also matched by rules.
    pub id: String,
}

/// "Google Chrome Helper (Renderer)" -> "Google Chrome".
fn clean(name: &str) -> String {
    let n = name.split(" Helper").next().unwrap_or(name);
    let n = n.trim_end_matches(".exe");
    n.trim().to_string()
}

#[cfg(target_os = "macos")]
pub fn mic_users() -> Vec<MicUser> {
    use cidre::{core_audio as ca, ns};
    let me = std::process::id() as i32;
    let mut out: Vec<MicUser> = Vec::new();
    let Ok(procs) = ca::System::processes() else { return out };
    for p in procs {
        if !p.is_running_input().unwrap_or(false) {
            continue;
        }
        let Ok(pid) = p.pid() else { continue };
        if pid == me {
            continue;
        }
        let bundle = p.bundle_id().map(|b| b.to_string()).unwrap_or_default();
        let name = ns::RunningApp::with_pid(pid)
            .and_then(|a| a.localized_name().map(|n| n.to_string()))
            .unwrap_or_else(|| bundle.rsplit('.').next().unwrap_or("Unknown app").to_string());
        let user = MicUser { name: clean(&name), id: bundle };
        if !out.iter().any(|u| u.name == user.name) {
            out.push(user);
        }
    }
    out
}

#[cfg(windows)]
pub fn mic_users() -> Vec<MicUser> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    let me = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_lowercase().replace('\\', "#"))
        .unwrap_or_default();
    let mut out: Vec<MicUser> = Vec::new();
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(BASE) else { return out };
    // A key whose LastUsedTimeStop is 0 is an app holding the microphone now.
    let in_use = |k: &RegKey| k.get_value::<u64, _>("LastUsedTimeStop").map(|v| v == 0).unwrap_or(false)
        && k.get_value::<u64, _>("LastUsedTimeStart").map(|v| v > 0).unwrap_or(false);
    let mut push = |name: String, id: String| {
        if !name.is_empty() && !out.iter().any(|u: &MicUser| u.name == name) {
            out.push(MicUser { name, id });
        }
    };
    // Desktop apps: NonPackaged\C:#Users#…#Zoom.exe
    if let Ok(np) = root.open_subkey("NonPackaged") {
        for key in np.enum_keys().flatten() {
            if key.to_lowercase() == me {
                continue;
            }
            if let Ok(k) = np.open_subkey(&key) {
                if in_use(&k) {
                    let exe = key.rsplit('#').next().unwrap_or(&key).to_string();
                    push(friendly_windows_name(&exe), key.replace('#', "\\"));
                }
            }
        }
    }
    // Store apps (the new Teams): MSTeams_8wekyb3d8bbwe
    for key in root.enum_keys().flatten() {
        if key == "NonPackaged" {
            continue;
        }
        if let Ok(k) = root.open_subkey(&key) {
            if in_use(&k) {
                let family = key.split('_').next().unwrap_or(&key).to_string();
                push(friendly_windows_name(&family), key);
            }
        }
    }
    out
}

#[cfg(windows)]
fn friendly_windows_name(exe: &str) -> String {
    let base = exe.trim_end_matches(".exe").trim_end_matches(".EXE");
    match base.to_lowercase().as_str() {
        "zoom" => "Zoom".into(),
        "ms-teams" | "msteams" | "teams" => "Microsoft Teams".into(),
        "discord" => "Discord".into(),
        "slack" => "Slack".into(),
        "chrome" => "Google Chrome".into(),
        "msedge" | "msedgewebview2" => "Microsoft Edge".into(),
        "firefox" => "Firefox".into(),
        "webex" | "ciscocollabhost" | "atmgr" => "Webex".into(),
        _ => clean(base),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn mic_users() -> Vec<MicUser> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    #[test]
    fn helper_suffixes_are_dropped() {
        assert_eq!(super::clean("Google Chrome Helper (Renderer)"), "Google Chrome");
        assert_eq!(super::clean("zoom.us"), "zoom.us");
        assert_eq!(super::clean("Discord.exe"), "Discord");
    }
}
