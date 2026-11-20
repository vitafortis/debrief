//! The setup checklist at the top of Settings: what the recorder still needs
//! (a server and key, the permissions), each with a button that fixes it or
//! opens the right page of the system's settings. Checked on every poll, so a
//! permission granted in System Settings shows up straight away.

use crate::State;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub key: &'static str,
    pub title: &'static str,
    pub detail: String,
    /// "ok", "todo", or "denied" (refused before: only System Settings can change it now).
    pub state: &'static str,
    /// Without it recordings don't work as they should; the rest are optional.
    pub required: bool,
    /// The button's label, if there's something to press.
    pub action: Option<&'static str>,
}

impl Step {
    fn ok(&self) -> bool {
        self.state == "ok"
    }
}

pub fn steps(app: &AppHandle) -> Vec<Step> {
    let st = app.state::<State>();
    let s = st.settings.read().unwrap().clone();
    let u = st.uploader.status.lock().unwrap().clone();
    let mut out = Vec::new();

    out.push(Step {
        key: "connect",
        title: "Connect to Debrief",
        detail: if !u.configured {
            "Add your server and an API key below. Make the key in Debrief → Settings → Devices & keys.".into()
        } else if u.online == Some(false) {
            format!("Can't reach Debrief: {}", u.last_error.unwrap_or_default())
        } else {
            "Recordings upload to your server.".into()
        },
        state: if u.configured && u.online != Some(false) { "ok" } else { "todo" },
        required: true,
        action: (!u.configured).then_some("Show me"),
    });

    let (state, detail) = microphone();
    out.push(Step {
        key: "microphone",
        title: "Microphone",
        detail,
        state,
        required: true,
        action: match state {
            "todo" => Some("Allow"),
            "denied" => Some("Open settings"),
            _ => None,
        },
    });

    #[cfg(target_os = "macos")]
    {
        let ok = cidre::cg::screen_capture_access::preflight();
        out.push(Step {
            key: "screen",
            title: "Screen & System Audio Recording",
            detail: if ok {
                "The other side of the call, and shared screens.".into()
            } else {
                "Needed for the other side of the call, not just your microphone. Turn on Debrief Recorder in the list, then quit and reopen it.".into()
            },
            state: if ok { "ok" } else { "todo" },
            required: true,
            action: (!ok).then_some("Allow"),
        });
        if s.follow_zoom_mute {
            let ok = cidre::ax::is_process_trusted();
            out.push(Step {
                key: "accessibility",
                title: "Accessibility",
                detail: if ok {
                    "Follows Zoom's mute, so what you say while muted isn't kept.".into()
                } else {
                    "Lets it follow Zoom's mute, so what you say while muted isn't kept. Optional: without it, everything you say is recorded.".into()
                },
                state: if ok { "ok" } else { "todo" },
                required: false,
                action: (!ok).then_some("Allow"),
            });
        }
    }

    let login = {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    };
    out.push(Step {
        key: "login",
        title: "Open at login",
        detail: if login { "It starts with your computer, so no call is missed.".into() } else { "Otherwise calls after a restart aren't noticed until you open it.".into() },
        state: if login { "ok" } else { "todo" },
        required: false,
        action: (!login).then_some("Turn on"),
    });
    out
}

/// Whether anything required is still missing.
pub fn incomplete(app: &AppHandle) -> bool {
    steps(app).iter().any(|s| s.required && !s.ok())
}

/// Presses a step's button.
pub fn fix(app: &AppHandle, key: &str) -> Result<(), String> {
    match key {
        "microphone" => fix_microphone(),
        #[cfg(target_os = "macos")]
        "screen" => {
            // The first request shows macOS's own prompt; after that it only answers, so open the list too.
            if !cidre::cg::screen_capture_access::request() {
                open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
            }
        }
        #[cfg(target_os = "macos")]
        "accessibility" => {
            if !cidre::ax::is_process_trusted_with_prompt(true) {
                open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
            }
        }
        "login" => {
            use tauri_plugin_autostart::ManagerExt;
            app.autolaunch().enable().map_err(|e| e.to_string())?;
            let st = app.state::<State>();
            let mut s = st.settings.write().unwrap();
            s.launch_at_login = true;
            s.save(&st.settings_path).map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    Ok(())
}

fn open(url: &str) {
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        log::warn!("Couldn't open {url}: {e}");
    }
}

#[cfg(target_os = "macos")]
fn microphone() -> (&'static str, String) {
    use cidre::av;
    match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::audio()) {
        Ok(av::AuthorizationStatus::Authorized) => ("ok", "Your side of the call.".into()),
        Ok(av::AuthorizationStatus::NotDetermined) => ("todo", "Your side of the call. macOS asks once.".into()),
        _ => ("denied", "Refused before, so your side would be silent. Turn on Debrief Recorder under Privacy & Security → Microphone.".into()),
    }
}

#[cfg(target_os = "macos")]
fn fix_microphone() {
    use cidre::av;
    let audio = av::MediaType::audio();
    if matches!(av::CaptureDevice::authorization_status_for_media_type(audio), Ok(av::AuthorizationStatus::NotDetermined)) {
        let mut answered = cidre::blocks::SendBlock::new1(|allowed: bool| log::info!("Microphone access {}", if allowed { "allowed" } else { "refused" }));
        if let Err(e) = av::CaptureDevice::request_access_for_media_type_ch(audio, &mut answered) {
            log::warn!("Couldn't ask for the microphone: {e:?}");
        }
    } else {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    }
}

/// Windows keeps "Let apps use the microphone" and "Let desktop apps use it" in the registry.
#[cfg(windows)]
fn microphone() -> (&'static str, String) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    let value = |path: &str| RegKey::predef(HKEY_CURRENT_USER).open_subkey(path).and_then(|k| k.get_value::<String, _>("Value")).ok();
    let denied = value(BASE).as_deref() == Some("Deny") || value(&format!(r"{BASE}\NonPackaged")).as_deref() == Some("Deny");
    if denied {
        ("denied", "Windows doesn't let desktop apps use the microphone, so your side would be silent. Turn on Microphone access and Let desktop apps access your microphone.".into())
    } else {
        ("ok", "Your side of the call.".into())
    }
}

#[cfg(windows)]
fn fix_microphone() {
    open("ms-settings:privacy-microphone");
}

#[cfg(not(any(target_os = "macos", windows)))]
fn microphone() -> (&'static str, String) {
    ("ok", "Your side of the call.".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn fix_microphone() {}
