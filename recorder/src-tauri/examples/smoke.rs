//! Records a few seconds (mic + system audio) and uploads it, without the UI:
//!   cargo run --example smoke -- <seconds> <server> <api key>
use debrief_recorder_lib::{audio, detect, settings::Settings, store, upload};
use std::sync::{Arc, Mutex, RwLock};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let secs: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(5);
    let root = std::env::temp_dir().join("debrief-smoke");
    std::fs::create_dir_all(&root)?;
    println!("Apps using the mic now: {:?}", detect::mic_users());
    let mut local = store::Local::new(Some("smoke test".into()), Some("Recorder smoke test".into()));
    local.save(&root)?;
    let system = std::env::var("SMOKE_SYSTEM").map(|v| v != "0").unwrap_or(true);
    if let Ok(src) = std::env::var("SMOKE_FILE") {
        // Upload an existing file instead of recording (no microphone permission needed).
        std::fs::copy(src, local.audio(&root))?;
        local.duration_secs = store::ogg_duration(&local.audio(&root));
        local.ended_at = Some(chrono::Utc::now());
        local.save(&root)?;
        return upload_and_wait(&args, &root);
    }
    eprintln!("Opening the microphone{}…", if system { " and system audio" } else { "" });
    let rec = audio::Recording::start(&local.audio(&root), "", system)?;
    println!("Recording {secs} s… warnings: {:?}", rec.warnings);
    std::thread::sleep(std::time::Duration::from_secs(secs));
    let f = rec.stop()?;
    local.duration_secs = Some(f.duration_secs);
    local.ended_at = Some(chrono::Utc::now());
    local.save(&root)?;
    println!("{:.2} s, system audio heard: {}, {} bytes, file {}", f.duration_secs, f.system_heard, std::fs::metadata(local.audio(&root))?.len(), local.audio(&root).display());
    upload_and_wait(&args, &root)
}

fn upload_and_wait(args: &[String], root: &std::path::Path) -> anyhow::Result<()> {
    let root = root.to_path_buf();
    if let (Some(server), Some(key)) = (args.get(2), args.get(3)) {
        println!("{}", upload::ping(server, key, "smoke-mac")?);
        let s = Settings { server_url: server.clone(), api_key: key.clone(), device_name: "smoke-mac".into(), ..Default::default() };
        let up = upload::Uploader::start(Arc::new(RwLock::new(s)), Arc::new(RwLock::new(root.clone())), Arc::new(Mutex::new(None)));
        up.nudge();
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let st = up.status.lock().unwrap().clone();
            if store::list(&root).iter().all(|l| l.done_at.is_some()) {
                println!("Uploaded: {st:?}");
                return Ok(());
            }
        }
        anyhow::bail!("upload didn't finish: {:?}", up.status.lock().unwrap());
    }
    Ok(())
}
