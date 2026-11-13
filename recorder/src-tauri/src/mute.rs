//! Whether you're muted in Zoom, so what you say while muted stays out of the
//! recording: the microphone keeps hearing you when Zoom doesn't send it. Read
//! from Zoom's own controls, on a Mac through Accessibility (its Meeting menu
//! and the meeting window's Mute button) and on Windows through UI Automation.
//! When it can't tell (no permission, no meeting window, a label it doesn't
//! know), you're taken as unmuted, so a failed check never loses your side.

use crate::audio::Levels;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Whether an app is Zoom, by the name and id the microphone check found.
pub fn is_zoom(name: &str, id: &str) -> bool {
    name.to_lowercase().contains("zoom") || id.to_lowercase().contains("zoom")
}

/// What a mute control's label says about you: "Unmute my audio (Alt+A)" means
/// muted. Only your own audio's labels: "Mute all" and the like are a host's.
pub fn label_state(label: &str) -> Option<bool> {
    let l = label.split('(').next().unwrap_or("").trim().to_lowercase();
    let l = l.trim_end_matches(['.', '…']);
    match l {
        "unmute" | "unmute audio" | "unmute my audio" | "unmute microphone" => Some(true),
        "mute" | "mute audio" | "mute my audio" | "mute microphone" => Some(false),
        _ => None,
    }
}

/// Polls Zoom while a recording runs, and sets `levels.mic_muted` to match.
pub struct Watch {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watch {
    pub fn start(levels: Arc<Levels>) -> Self {
        #[cfg(target_os = "macos")]
        ask_for_access();
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        let thread = std::thread::Builder::new()
            .name("zoom-mute".into())
            .spawn(move || {
                let mut was = false;
                while !s.load(Ordering::Relaxed) {
                    let muted = zoom_muted() == Some(true);
                    if muted != was {
                        log::info!("{}", if muted { "Muted in Zoom: leaving out the microphone" } else { "Unmuted in Zoom: recording the microphone" });
                        was = muted;
                    }
                    levels.mic_muted.store(muted, Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(500));
                }
                levels.mic_muted.store(false, Ordering::Relaxed);
            })
            .ok();
        Self { stop, thread }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Asks once per run for the Accessibility permission reading Zoom needs:
/// macOS shows its own prompt, pointing at System Settings.
#[cfg(target_os = "macos")]
fn ask_for_access() {
    static ASKED: AtomicBool = AtomicBool::new(false);
    if !ASKED.swap(true, Ordering::Relaxed) && !cidre::ax::is_process_trusted_with_prompt(true) {
        log::warn!("Following Zoom's mute needs Accessibility: System Settings → Privacy & Security → Accessibility → Debrief Recorder");
    }
}

#[cfg(target_os = "macos")]
fn zoom_muted() -> Option<bool> {
    use cidre::{ax, cf, ns};

    fn text(el: &ax::UiElement, attr: &ax::Attr) -> Option<String> {
        el.attr_value(attr).ok()?.try_as_string().map(|s| s.to_string())
    }
    fn children(el: &ax::UiElement) -> Vec<cidre::arc::R<ax::UiElement>> {
        el.children().map(|c| (0..c.len()).map(|i| c[i].retained()).collect()).unwrap_or_default()
    }
    /// The first mute button in a window, looking no deeper than Zoom's controls sit.
    fn find(el: &ax::UiElement, depth: u32, budget: &mut u32) -> Option<bool> {
        if *budget == 0 || depth > 14 {
            return None;
        }
        *budget -= 1;
        if el.role().map(|r| r.to_string() == "AXButton" || r.to_string() == "AXMenuItem").unwrap_or(false) {
            if let Some(s) = [ax::attr::title(), ax::attr::desc()].into_iter().find_map(|a| text(el, a).and_then(|t| label_state(&t))) {
                return Some(s);
            }
        }
        children(el).iter().find_map(|c| find(c, depth + 1, budget))
    }

    if !ax::is_process_trusted() {
        return None;
    }
    let apps = ns::RunningApp::with_bundle_id(cf::str!(c"us.zoom.xos").as_ns());
    for i in 0..apps.len() {
        let app = ax::UiElement::with_app_pid(apps[i].pid());
        let _ = app.set_messaging_timeout(Duration::from_millis(300));
        // The Meeting menu says Mute audio or Unmute audio during a meeting.
        if let Ok(bar) = app.attr_value(ax::attr::menu_bar()) {
            if bar.get_type_id() == ax::UiElement::type_id() {
                let bar: &ax::UiElement = unsafe { std::mem::transmute(&*bar) };
                for item in children(bar) {
                    if text(&item, ax::attr::title()).as_deref() == Some("Meeting") {
                        let mut budget = 200;
                        if let Some(s) = find(&item, 0, &mut budget) {
                            return Some(s);
                        }
                    }
                }
            }
        }
        // Else the meeting window's own Mute button.
        if let Ok(wins) = app.attr_value(ax::attr::windows()) {
            if wins.get_type_id() == cf::Array::type_id() {
                let wins: &cf::ArrayOf<ax::UiElement> = unsafe { std::mem::transmute(&*wins) };
                for w in 0..wins.len() {
                    let mut budget = 3000;
                    if let Some(s) = find(&wins[w], 0, &mut budget) {
                        return Some(s);
                    }
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn zoom_muted() -> Option<bool> {
    use crate::audio::system_win::processes;
    use windows::core::{BOOL, VARIANT};
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_ButtonControlTypeId, UIA_ControlTypePropertyId};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};

    unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
        let v = &mut *(out.0 as *mut Vec<HWND>);
        v.push(hwnd);
        BOOL(1)
    }

    let pids: Vec<u32> = processes().into_iter().filter(|p| p.exe == "zoom.exe").map(|p| p.pid).collect();
    if pids.is_empty() {
        return None;
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let buttons = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_ButtonControlTypeId.0)).ok()?;
        let mut all: Vec<HWND> = Vec::new();
        EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize)).ok()?;
        for hwnd in all {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if !pids.contains(&pid) || !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
            let Ok(win) = uia.ElementFromHandle(hwnd) else { continue };
            let Ok(found) = win.FindAll(TreeScope_Descendants, &buttons) else { continue };
            for i in 0..found.Length().unwrap_or(0) {
                if let Some(s) = found.GetElement(i).ok().and_then(|e| e.CurrentName().ok()).and_then(|n| label_state(&n.to_string())) {
                    return Some(s);
                }
            }
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", windows)))]
fn zoom_muted() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_your_own_mute_labels_count() {
        assert_eq!(label_state("Unmute my audio (Alt+A)"), Some(true));
        assert_eq!(label_state("Mute my audio (Alt+A)"), Some(false));
        assert_eq!(label_state("Unmute Audio"), Some(true));
        assert_eq!(label_state("Mute audio"), Some(false));
        assert_eq!(label_state(" Unmute "), Some(true));
        assert_eq!(label_state("Mute All"), None);
        assert_eq!(label_state("Ask All to Unmute"), None);
        assert_eq!(label_state("Mute participants upon entry"), None);
        assert_eq!(label_state("Stop video"), None);
    }

    #[test]
    fn zoom_is_found_by_name_or_id() {
        assert!(is_zoom("zoom.us", "us.zoom.xos"));
        assert!(is_zoom("Zoom", r"C:\Users\a\AppData\Roaming\Zoom\bin\Zoom.exe"));
        assert!(!is_zoom("Microsoft Teams", "MSTeams_8wekyb3d8bbwe"));
    }
}
