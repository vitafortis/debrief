//! Debrief Recorder: a tray app that notices when a meeting app takes the
//! microphone, records the call (asking first, or not, per app), and
//! streams it to Debrief.

pub mod audio;
pub mod detect;
mod icons;
pub mod settings;
pub mod store;
pub mod upload;

use settings::{Action, Settings};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

struct Active {
    rec: audio::Recording,
    local: store::Local,
    started: Instant,
    /// The app whose microphone use started it; it stops when that app lets go.
    trigger: Option<String>,
    last_seen: Instant,
}

/// A question the popup is showing.
#[derive(Clone, serde::Serialize)]
struct Prompt {
    kind: &'static str, // "start" | "stopped" | "error"
    app: String,
    message: String,
}

struct State {
    settings: Arc<RwLock<Settings>>,
    settings_path: PathBuf,
    recordings: Arc<RwLock<PathBuf>>,
    default_recordings: PathBuf,
    active: Mutex<Option<Active>>,
    current_id: Arc<Mutex<Option<Uuid>>>,
    uploader: upload::Uploader,
    prompt: Mutex<Option<Prompt>>,
    /// Apps answered "Not now" for, until they let go of the microphone.
    snoozed: Mutex<HashSet<String>>,
    tray: Mutex<Option<TrayMenu>>,
}

struct TrayMenu {
    icon: TrayIcon,
    status: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
    uploads: MenuItem<tauri::Wry>,
}

type S<'a> = tauri::State<'a, State>;

fn fmt_elapsed(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

// --- Recording ---------------------------------------------------------------

fn start_recording(app: &AppHandle, trigger: Option<String>, title: Option<String>) -> anyhow::Result<()> {
    let st = app.state::<State>();
    let mut active = st.active.lock().unwrap();
    if active.is_some() {
        return Ok(());
    }
    let s = st.settings.read().unwrap().clone();
    let root = st.recordings.read().unwrap().clone();
    let local = store::Local::new(trigger.clone(), title.filter(|t| !t.trim().is_empty()));
    std::fs::create_dir_all(local.dir(&root))?;
    local.save(&root)?;
    let rec = match audio::Recording::start(&local.audio(&root), &s.microphone, s.capture_system_audio) {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(local.dir(&root));
            return Err(e);
        }
    };
    for w in &rec.warnings {
        log::warn!("{w}");
    }
    log::info!("Recording {} ({})", local.id, trigger.as_deref().unwrap_or("by hand"));
    *st.current_id.lock().unwrap() = Some(local.id);
    *active = Some(Active { rec, local, started: Instant::now(), trigger, last_seen: Instant::now() });
    drop(active);
    refresh_tray(app);
    Ok(())
}

fn stop_recording(app: &AppHandle, why: &str) {
    let st = app.state::<State>();
    let Some(a) = st.active.lock().unwrap().take() else { return };
    let root = st.recordings.read().unwrap().clone();
    let mut local = a.local;
    let silent_system = st.settings.read().unwrap().capture_system_audio;
    match a.rec.stop() {
        Ok(f) => {
            local.duration_secs = Some(f.duration_secs);
            if silent_system && !f.system_heard && f.duration_secs > 60.0 {
                show_prompt(
                    app,
                    Prompt {
                        kind: "error",
                        app: String::new(),
                        message: "Only your microphone had sound. If the call was on speakers or headphones, allow Debrief Recorder to record system audio (macOS: System Settings → Privacy & Security → Screen & System Audio Recording).".into(),
                    },
                );
            }
        }
        Err(e) => {
            log::error!("Stopping: {e:#}");
            local.duration_secs = store::ogg_duration(&local.audio(&root));
        }
    }
    local.ended_at = Some(chrono::Utc::now());
    let _ = local.save(&root);
    *st.current_id.lock().unwrap() = None;
    log::info!("Stopped {} after {} ({why})", local.id, fmt_elapsed(a.started.elapsed()));
    st.uploader.nudge();
    refresh_tray(app);
}

// --- Watching for meetings ---------------------------------------------------

fn watch(app: AppHandle) {
    std::thread::Builder::new()
        .name("watch".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let st = app.state::<State>();
            let s = st.settings.read().unwrap().clone();
            let users = detect::mic_users();
            let names: HashSet<String> = users.iter().map(|u| u.name.clone()).collect();
            st.snoozed.lock().unwrap().retain(|n| names.contains(n));

            // Recording for an app: stop once it has let go of the microphone for a while.
            let mut stop = None;
            if let Some(a) = st.active.lock().unwrap().as_mut() {
                if let Some(t) = &a.trigger {
                    if names.contains(t) {
                        a.last_seen = Instant::now();
                    } else if a.last_seen.elapsed() >= Duration::from_secs(s.stop_after_secs.max(5)) {
                        stop = Some(t.clone());
                    }
                }
            }
            if let Some(t) = stop {
                stop_recording(&app, &format!("{t} let go of the microphone"));
                show_prompt(&app, Prompt { kind: "stopped", app: t.clone(), message: format!("{t} has finished with the microphone. The recording is going to Debrief.") });
                continue;
            }
            if st.active.lock().unwrap().is_some() {
                refresh_tray(&app);
                continue;
            }
            if !s.detect_meetings {
                continue;
            }
            for u in &users {
                if st.snoozed.lock().unwrap().contains(&u.name) {
                    continue;
                }
                match s.action_for(&u.name, &u.id) {
                    Action::Ignore => {}
                    Action::Record => {
                        if let Err(e) = start_recording(&app, Some(u.name.clone()), None) {
                            log::error!("Couldn't start recording: {e:#}");
                            st.snoozed.lock().unwrap().insert(u.name.clone());
                            show_prompt(&app, Prompt { kind: "error", app: u.name.clone(), message: format!("Couldn't start recording: {e}") });
                        }
                        break;
                    }
                    Action::Ask => {
                        let showing = st.prompt.lock().unwrap().as_ref().map(|p| p.kind == "start" && p.app == u.name).unwrap_or(false);
                        if !showing {
                            show_prompt(&app, Prompt { kind: "start", app: u.name.clone(), message: format!("{} is using your microphone.", u.name) });
                        }
                        break;
                    }
                }
            }
        })
        .expect("watch thread");
}

fn show_prompt(app: &AppHandle, p: Prompt) {
    let st = app.state::<State>();
    *st.prompt.lock().unwrap() = Some(p.clone());
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window("prompt") {
            let _ = w.emit("prompt", &p);
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let (w, h) = (380.0, 196.0);
        let mut b = WebviewWindowBuilder::new(&app2, "prompt", WebviewUrl::App("prompt.html".into()))
            .title("Debrief Recorder")
            .inner_size(w, h)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(true)
            .visible(false);
        #[cfg(target_os = "macos")]
        {
            b = b.transparent(true);
        }
        // Top right, out of the way of the call window's controls.
        if let Ok(Some(m)) = app2.primary_monitor() {
            let scale = m.scale_factor();
            let size = m.size().to_logical::<f64>(scale);
            let pos = m.position().to_logical::<f64>(scale);
            b = b.position(pos.x + size.width - w - 16.0, pos.y + 40.0);
        }
        match b.build() {
            Ok(w) => {
                let _ = w.show();
            }
            Err(e) => log::error!("Popup: {e}"),
        }
    });
}

// --- Tray --------------------------------------------------------------------

fn refresh_tray(app: &AppHandle) {
    let st = app.state::<State>();
    let (recording, label) = match st.active.lock().unwrap().as_ref() {
        Some(a) => (true, format!("● Recording{} · {}", a.trigger.as_ref().map(|t| format!(" {t}")).unwrap_or_default(), fmt_elapsed(a.started.elapsed()))),
        None => (false, "Not recording".to_string()),
    };
    let u = st.uploader.status.lock().unwrap().clone();
    let uploads = match (u.online, u.waiting) {
        (Some(false), n) => format!("Can't reach Debrief{}", if n > 0 { format!(" · {n} waiting") } else { String::new() }),
        (_, 0) => "Everything is in Debrief".into(),
        (_, 1) => "Uploading 1 recording…".into(),
        (_, n) => format!("Uploading {n} recordings…"),
    };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let st = app2.state::<State>();
        let tray = st.tray.lock().unwrap();
        if let Some(t) = tray.as_ref() {
            let _ = t.status.set_text(&label);
            let _ = t.toggle.set_text(if recording { "Stop recording" } else { "Start recording" });
            let _ = t.uploads.set_text(&uploads);
            let _ = t.icon.set_icon(Some(icons::tray(recording)));
            let _ = t.icon.set_tooltip(Some(&label));
        }
        drop(tray);
    });
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    match WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Debrief Recorder")
        .inner_size(560.0, 720.0)
        .min_inner_size(440.0, 480.0)
        .skip_taskbar(true)
        .build()
    {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => log::error!("Settings window: {e}"),
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Not recording", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Start recording", true, None::<&str>)?;
    let uploads = MenuItem::with_id(app, "uploads", "Everything is in Debrief", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Debrief", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Show recordings folder", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Debrief Recorder", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&status, &toggle, &sep()?, &uploads, &open, &folder, &sep()?, &settings, &quit])?;
    let icon = TrayIconBuilder::with_id("main")
        .icon(icons::tray(false))
        .tooltip("Debrief Recorder")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "toggle" => {
                if app.state::<State>().active.lock().unwrap().is_some() {
                    stop_recording(app, "stopped from the menu");
                } else if let Err(err) = start_recording(app, None, None) {
                    show_prompt(app, Prompt { kind: "error", app: String::new(), message: format!("Couldn't start recording: {err}") });
                }
            }
            "open" => {
                let url = app.state::<State>().settings.read().unwrap().server_url.clone();
                if !url.is_empty() {
                    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
                }
            }
            "folder" => {
                let dir = app.state::<State>().recordings.read().unwrap().clone();
                let _ = std::fs::create_dir_all(&dir);
                let _ = tauri_plugin_opener::open_path(dir, None::<&str>);
            }
            "settings" => open_settings(app),
            "quit" => {
                stop_recording(app, "quitting");
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    *app.state::<State>().tray.lock().unwrap() = Some(TrayMenu { icon, status, toggle, uploads });
    Ok(())
}

// --- Commands for the windows --------------------------------------------------

#[tauri::command]
fn get_settings(st: S) -> Settings {
    st.settings.read().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, st: S, settings: Settings) -> Result<(), String> {
    let mut s = settings;
    s.server_url = s.server_url.trim().trim_end_matches('/').to_string();
    s.fallback_url = s.fallback_url.trim().trim_end_matches('/').to_string();
    s.api_key = s.api_key.trim().to_string();
    if s.device_name.trim().is_empty() {
        s.device_name = settings::default_device_name();
    }
    s.rules.retain(|r| !r.app.trim().is_empty());
    s.save(&st.settings_path).map_err(|e| e.to_string())?;
    *st.recordings.write().unwrap() = s.recordings_path(&st.default_recordings);
    {
        use tauri_plugin_autostart::ManagerExt;
        let al = app.autolaunch();
        let _ = if s.launch_at_login { al.enable() } else { al.disable() };
    }
    *st.settings.write().unwrap() = s;
    st.uploader.nudge();
    Ok(())
}

#[tauri::command]
async fn test_connection(server_url: String, api_key: String, device_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || upload::ping(&server_url, &api_key, &device_name).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn microphones() -> Vec<String> {
    audio::input_devices()
}

#[derive(serde::Serialize)]
struct StatusView {
    recording: bool,
    app: Option<String>,
    elapsed: Option<String>,
    mic_level: u32,
    system_level: u32,
    upload: upload::Status,
    recordings_dir: String,
    recent: Vec<RecentView>,
    mic_users: Vec<String>,
}

#[derive(serde::Serialize)]
struct RecentView {
    started_at: String,
    app: Option<String>,
    minutes: Option<f64>,
    state: String,
}

#[tauri::command]
fn status(st: S) -> StatusView {
    let root = st.recordings.read().unwrap().clone();
    let active = st.active.lock().unwrap();
    let (mic, sys) = active
        .as_ref()
        .map(|a| {
            (
                a.rec.levels.mic.swap(0, std::sync::atomic::Ordering::Relaxed),
                a.rec.levels.system.swap(0, std::sync::atomic::Ordering::Relaxed),
            )
        })
        .unwrap_or((0, 0));
    let live = active.as_ref().map(|a| a.local.id);
    let mut recent: Vec<RecentView> = store::list(&root)
        .into_iter()
        .rev()
        .take(8)
        .map(|l| RecentView {
            started_at: l.started_at.to_rfc3339(),
            app: l.app.clone(),
            minutes: l.duration_secs.map(|d| (d / 60.0 * 10.0).round() / 10.0),
            state: if Some(l.id) == live {
                "recording".into()
            } else if l.done_at.is_some() {
                "uploaded".into()
            } else if let Some(e) = &l.last_error {
                format!("waiting: {e}")
            } else {
                "waiting".into()
            },
        })
        .collect();
    recent.truncate(8);
    StatusView {
        recording: active.is_some(),
        app: active.as_ref().and_then(|a| a.trigger.clone()),
        elapsed: active.as_ref().map(|a| fmt_elapsed(a.started.elapsed())),
        mic_level: mic,
        system_level: sys,
        upload: st.uploader.status.lock().unwrap().clone(),
        recordings_dir: root.to_string_lossy().into_owned(),
        recent,
        mic_users: detect::mic_users().into_iter().map(|u| u.name).collect(),
    }
}

#[tauri::command]
fn toggle_recording(app: AppHandle) -> Result<(), String> {
    if app.state::<State>().active.lock().unwrap().is_some() {
        stop_recording(&app, "stopped from Settings");
        Ok(())
    } else {
        start_recording(&app, None, None).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn current_prompt(st: S) -> Option<Prompt> {
    st.prompt.lock().unwrap().clone()
}

/// The popup's answer: "record", "always", "not_now", "never", or "close".
#[tauri::command]
fn answer_prompt(app: AppHandle, answer: String, title: Option<String>) -> Result<(), String> {
    let st = app.state::<State>();
    let p = st.prompt.lock().unwrap().take();
    if let Some(w) = app.get_webview_window("prompt") {
        let _ = w.hide();
    }
    let Some(p) = p else { return Ok(()) };
    if p.kind != "start" {
        return Ok(());
    }
    let remember = |action: Action| {
        let mut s = st.settings.write().unwrap();
        s.set_rule(&p.app, action);
        let _ = s.save(&st.settings_path);
    };
    match answer.as_str() {
        "record" | "always" => {
            if answer == "always" {
                remember(Action::Record);
            }
            start_recording(&app, Some(p.app.clone()), title).map_err(|e| e.to_string())?;
        }
        "never" => {
            remember(Action::Ignore);
            st.snoozed.lock().unwrap().insert(p.app);
        }
        _ => {
            st.snoozed.lock().unwrap().insert(p.app);
        }
    }
    Ok(())
}

#[tauri::command]
fn open_folder(st: S) {
    let dir = st.recordings.read().unwrap().clone();
    let _ = std::fs::create_dir_all(&dir);
    let _ = tauri_plugin_opener::open_path(dir, None::<&str>);
}

// --- Start-up ------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_settings(app)))
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join("settings.json");
            let first_run = !settings_path.exists();
            let s = Settings::load(&settings_path);
            let default_recordings = app.path().app_data_dir()?.join("recordings");
            let recordings = s.recordings_path(&default_recordings);
            std::fs::create_dir_all(&recordings)?;
            store::recover(&recordings, None);

            let settings = Arc::new(RwLock::new(s.clone()));
            let recordings = Arc::new(RwLock::new(recordings));
            let current_id = Arc::new(Mutex::new(None));
            let uploader = upload::Uploader::start(settings.clone(), recordings.clone(), current_id.clone());
            app.manage(State {
                settings,
                settings_path: settings_path.clone(),
                recordings,
                default_recordings,
                active: Mutex::new(None),
                current_id,
                uploader,
                prompt: Mutex::new(None),
                snoozed: Mutex::new(HashSet::new()),
                tray: Mutex::new(None),
            });
            if first_run {
                let _ = s.save(&settings_path);
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }
            build_tray(app.handle())?;
            watch(app.handle().clone());
            if s.server_url.is_empty() || s.api_key.is_empty() {
                open_settings(app.handle());
            }
            // Keep the menu's upload line current.
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                refresh_tray(&h);
            });
            Ok(())
        })
        .on_window_event(|w, e| match e {
            // Closing a window hides it; the app lives in the tray.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = w.hide();
                if w.label() == "prompt" {
                    let _ = answer_prompt(w.app_handle().clone(), "close".into(), None);
                }
            }
            // Settings tucks back into the tray when you click elsewhere, like a menu bar app.
            tauri::WindowEvent::Focused(false) if w.label() == "settings" => {
                let _ = w.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            test_connection,
            microphones,
            status,
            toggle_recording,
            current_prompt,
            answer_prompt,
            open_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|_app, e| {
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = e {
                api.prevent_exit();
            }
        });
}
