//! Recording orchestration (Windows): launch CS2 in `-insecure` demo mode,
//! drive the demo player through the `-netconport` console and capture each
//! clip with ffmpeg. No injection or memory access of any kind.

use crate::config::{CaptureBackend, Settings};
use crate::montage;
use crate::plan::{self, ClipPlan, Netcon};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    #[error("recording needs Windows with CS2 installed (this platform can browse, analyze and build montages)")]
    Platform,
    #[error("CS2 folder not found; set it in Settings")]
    NoCs2,
    #[error("CS2 is already running; close it first so it can be relaunched in demo-only (-insecure) mode")]
    AlreadyRunning,
    #[error(
        "the demo must be inside the CS2 'game/csgo' folder (e.g. replays) so playdemo can open it"
    )]
    DemoOutsideGame,
    #[error("could not reach the CS2 console on port {0} within {1}s")]
    Console(u16, u64),
    #[error("{0} capture is not implemented yet; use the ffmpeg backend")]
    Backend(&'static str),
    #[error("{0}")]
    Other(String),
}

pub fn cs2_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq cs2.exe", "/NH"])
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("cs2.exe"))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn demo_rel(demo: &Path, game: &Path) -> Option<String> {
    let rel = demo.strip_prefix(game).ok()?;
    Some(
        rel.with_extension("")
            .display()
            .to_string()
            .replace('\\', "/"),
    )
}

pub struct Event {
    pub index: usize,
    pub fraction: f32,
    pub text: String,
}

/// Record every enabled clip of `plan` into `out_dir`. Blocks; run it on a thread.
pub fn record_plan(
    s: &Settings,
    plan: &ClipPlan,
    out_dir: &Path,
    cancel: &AtomicBool,
    mut on: impl FnMut(Event),
) -> Result<Vec<PathBuf>, RecordError> {
    if !cfg!(windows) {
        return Err(RecordError::Platform);
    }
    match s.capture {
        CaptureBackend::Ffmpeg => {}
        CaptureBackend::Obs => return Err(RecordError::Backend("OBS")),
        CaptureBackend::Hlae => return Err(RecordError::Backend("HLAE")),
    }
    let game = s.cs2_game_dir().ok_or(RecordError::NoCs2)?;
    let rel = demo_rel(&plan.demo, &game).ok_or(RecordError::DemoOutsideGame)?;
    if cs2_running() {
        return Err(RecordError::AlreadyRunning);
    }
    std::fs::create_dir_all(out_dir).map_err(|e| RecordError::Other(e.to_string()))?;
    let args = plan::cs2_launch_args(&s.steam_exe, s.resolution.0, s.resolution.1);
    plan::check_launch_safety(&args).map_err(|e| RecordError::Other(e.to_string()))?;
    on(Event {
        index: 0,
        fraction: 0.0,
        text: "Starting CS2 in demo mode…".into(),
    });
    std::process::Command::new(&args[0])
        .args(&args[1..])
        .spawn()
        .map_err(|e| RecordError::Other(format!("could not start Steam: {e}")))?;

    let start = Instant::now();
    let timeout = 180;
    let mut con = loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(RecordError::Other("cancelled".into()));
        }
        if let Ok(c) = Netcon::connect(plan::NETCON_PORT, Duration::from_secs(2)) {
            break c;
        }
        if start.elapsed().as_secs() > timeout {
            return Err(RecordError::Console(plan::NETCON_PORT, timeout));
        }
        std::thread::sleep(Duration::from_secs(2));
    };
    std::thread::sleep(Duration::from_secs(10)); // main menu settle

    let items: Vec<_> = plan.items.iter().filter(|i| i.enabled).collect();
    let mut out = Vec::new();
    for (i, it) in items.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        on(Event {
            index: i,
            fraction: i as f32 / items.len() as f32,
            text: format!("Seeking to {}", it.title),
        });
        for c in plan::clip_commands(&rel, it, i == 0, false) {
            con.send(&c).map_err(RecordError::Other)?;
            std::thread::sleep(Duration::from_millis(150));
        }
        std::thread::sleep(Duration::from_secs(if i == 0 { 25 } else { 4 })); // demo load / seek
        let secs = plan.seconds(it);
        let file = out_dir.join(format!("{:02}_{}.mp4", i + 1, sanitize(&it.title)));
        let cmd = montage::capture_cmd(&s.ffmpeg, &file, secs, s.fps, None);
        con.send("demo_resume").map_err(RecordError::Other)?;
        on(Event {
            index: i,
            fraction: i as f32 / items.len() as f32,
            text: format!("Recording {} ({secs:.0}s)", it.title),
        });
        let r = montage::run(&cmd);
        let _ = con.send("demo_pause");
        r.map_err(RecordError::Other)?;
        out.push(file);
    }
    let _ = con.send("disconnect");
    on(Event {
        index: items.len(),
        fraction: 1.0,
        text: format!(
            "Recorded {} clips. Close CS2 before playing online.",
            out.len()
        ),
    });
    Ok(out)
}

pub fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
