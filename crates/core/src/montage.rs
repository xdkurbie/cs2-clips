//! ffmpeg command builders: screen capture, thumbnails and montages.
//! Builders return argument vectors (testable); [`run`] executes them.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq)]
pub struct MontageOptions {
    pub transition: String,
    pub transition_s: f32,
    pub music: Option<PathBuf>,
    pub music_volume: f32,
    pub duck: bool,
    /// 1.0 = normal speed, 0.5 = half speed.
    pub slowmo: f32,
    pub clips_have_audio: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub crf: u8,
    /// Optional title text drawn over the first seconds (needs ffmpeg with drawtext).
    pub intro_text: Option<String>,
}

impl Default for MontageOptions {
    fn default() -> Self {
        Self {
            transition: "fade".into(),
            transition_s: 0.5,
            music: None,
            music_volume: 0.6,
            duck: true,
            slowmo: 1.0,
            clips_have_audio: true,
            width: 1920,
            height: 1080,
            fps: 60,
            crf: 20,
            intro_text: None,
        }
    }
}

pub const TRANSITIONS: &[&str] = &[
    "fade",
    "fadeblack",
    "wipeleft",
    "slideleft",
    "circleopen",
    "dissolve",
    "pixelize",
    "zoomin",
];

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum MontageError {
    #[error("need at least one clip, with one duration per clip")]
    NoClips,
    #[error("slow-motion factor must be between 0.25 and 1.0")]
    Slowmo,
    #[error("unknown transition {0:?}")]
    Transition(String),
}

fn esc_text(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\'")
        .replace('%', "\\%")
}

pub fn build_montage_cmd(
    ffmpeg: &str,
    clips: &[PathBuf],
    durations: &[f32],
    out: &Path,
    o: &MontageOptions,
) -> Result<Vec<String>, MontageError> {
    if clips.is_empty() || clips.len() != durations.len() {
        return Err(MontageError::NoClips);
    }
    if !(0.25..=1.0).contains(&o.slowmo) {
        return Err(MontageError::Slowmo);
    }
    if !TRANSITIONS.contains(&o.transition.as_str()) {
        return Err(MontageError::Transition(o.transition.clone()));
    }
    let mut cmd: Vec<String> = vec![ffmpeg.into(), "-y".into(), "-hide_banner".into()];
    for c in clips {
        cmd.extend(["-i".into(), c.display().to_string()]);
    }
    let n = clips.len();
    if let Some(m) = &o.music {
        cmd.extend([
            "-stream_loop".into(),
            "-1".into(),
            "-i".into(),
            m.display().to_string(),
        ]);
    }
    let pts = 1.0 / o.slowmo;
    let durs: Vec<f32> = durations.iter().map(|d| d * pts).collect();
    let td = o
        .transition_s
        .min(durs.iter().cloned().fold(f32::MAX, f32::min) / 2.0)
        .max(0.0);
    let (w, h, fps) = (o.width, o.height, o.fps);
    let mut f: Vec<String> = Vec::new();
    for (i, d) in durs.iter().enumerate() {
        f.push(format!(
            "[{i}:v]setpts={pts}*PTS,fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=AVTB[v{i}]"
        ));
        if o.clips_have_audio {
            f.push(format!(
                "[{i}:a]atempo={},aresample=48000,aformat=channel_layouts=stereo[a{i}]",
                o.slowmo.max(0.5)
            ));
            if o.slowmo < 0.5 {
                let last = f.pop().unwrap();
                f.push(last.replace(&format!("[a{i}]"), &format!("[a{i}p]")));
                f.push(format!("[a{i}p]atempo={}[a{i}]", (o.slowmo / 0.5).max(0.5)));
            }
        } else {
            f.push(format!("anullsrc=r=48000:cl=stereo,atrim=0:{d:.3}[a{i}]"));
        }
    }
    let (mut vl, mut al, mut off) = ("v0".to_string(), "a0".to_string(), 0.0f32);
    for i in 1..n {
        off += durs[i - 1] - td;
        f.push(format!(
            "[{vl}][v{i}]xfade=transition={}:duration={td}:offset={off:.3}[vx{i}]",
            o.transition
        ));
        f.push(format!("[{al}][a{i}]acrossfade=d={td}[ax{i}]"));
        vl = format!("vx{i}");
        al = format!("ax{i}");
    }
    let total = durs.iter().sum::<f32>() - td * (n as f32 - 1.0);
    if let Some(t) = &o.intro_text {
        f.push(format!(
            "[{vl}]drawtext=text='{}':fontcolor=white:fontsize=72:x=(w-tw)/2:y=h*0.8:enable='lt(t,3)':alpha='if(lt(t,2.5),1,(3-t)*2)'[vt]",
            esc_text(t)
        ));
        vl = "vt".into();
    }
    if o.music.is_some() {
        f.push(format!(
            "[{n}:a]volume={},atrim=0:{total:.3},afade=t=out:st={:.3}:d=2,aformat=channel_layouts=stereo[m]",
            o.music_volume, (total - 2.0).max(0.0)
        ));
        if o.duck && o.clips_have_audio {
            f.push(format!("[{al}]asplit=2[g1][g2]"));
            f.push(
                "[m][g1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[md]".into(),
            );
            f.push("[g2][md]amix=inputs=2:duration=first:dropout_transition=0[aout]".into());
        } else {
            f.push(format!("[{al}][m]amix=inputs=2:duration=first[aout]"));
        }
        al = "aout".into();
    }
    cmd.extend([
        "-filter_complex".into(),
        f.join(";"),
        "-map".into(),
        format!("[{vl}]"),
        "-map".into(),
        format!("[{al}]"),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "medium".into(),
        "-crf".into(),
        o.crf.to_string(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        out.display().to_string(),
    ]);
    Ok(cmd)
}

/// Windows window capture of the CS2 window via gdigrab (+ optional system audio device).
pub fn capture_cmd(
    ffmpeg: &str,
    out: &Path,
    seconds: f32,
    fps: u32,
    audio_device: Option<&str>,
) -> Vec<String> {
    let mut v: Vec<String> = vec![ffmpeg.into(), "-y".into(), "-hide_banner".into()];
    if cfg!(target_os = "macos") {
        v.extend(["-f", "avfoundation", "-framerate"].map(String::from));
        v.extend([fps.to_string(), "-i".into(), "1:none".into()]);
    } else {
        v.extend(["-f", "gdigrab", "-framerate"].map(String::from));
        v.extend([
            fps.to_string(),
            "-i".into(),
            "title=Counter-Strike 2".into(),
        ]);
    }
    if let Some(a) = audio_device {
        v.extend([
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            format!("audio={a}"),
        ]);
    }
    v.extend([
        "-t".into(),
        format!("{seconds:.2}"),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "18".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ]);
    if audio_device.is_some() {
        v.extend(["-c:a".into(), "aac".into()]);
    }
    v.push(out.display().to_string());
    v
}

pub fn thumbnail_cmd(ffmpeg: &str, clip: &Path, out: &Path, at_s: f32) -> Vec<String> {
    vec![
        ffmpeg.into(),
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{at_s:.2}"),
        "-i".into(),
        clip.display().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=480:-2".into(),
        out.display().to_string(),
    ]
}

pub fn probe_duration(ffprobe: &str, file: &Path) -> Option<f32> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(file)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

pub fn has_audio(ffprobe: &str, f: &Path) -> bool {
    Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(f)
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

pub fn ffprobe_for(ffmpeg: &str) -> String {
    if ffmpeg == "ffmpeg" {
        return "ffprobe".into();
    }
    let p = Path::new(ffmpeg);
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    p.with_file_name(name).display().to_string()
}

pub fn ffmpeg_available(ffmpeg: &str) -> bool {
    Command::new(ffmpeg)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run a built command; returns stderr tail on failure.
pub fn run(cmd: &[String]) -> Result<(), String> {
    let mut c = Command::new(&cmd[0]);
    c.args(&cmd[1..])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = c
        .output()
        .map_err(|e| format!("could not start {}: {e}", cmd[0]))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(6).collect();
        Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

/// Run ffmpeg with `-progress pipe:1` and report 0..=1 based on `total_s`.
pub fn run_with_progress(
    cmd: &[String],
    total_s: f32,
    mut progress: impl FnMut(f32),
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    let mut c = Command::new(&cmd[0]);
    c.args(["-progress", "pipe:1", "-nostats"])
        .args(&cmd[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", cmd[0]))?;
    let stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut tail: Vec<String> = Vec::new();
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            tail.push(l);
            if tail.len() > 8 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });
    for line in BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map_while(Result::ok)
    {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill();
            return Err("cancelled".into());
        }
        if let Some(v) = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
        {
            if let Ok(us) = v.trim().parse::<f64>() {
                progress(((us / 1e6) as f32 / total_s.max(0.1)).clamp(0.0, 1.0));
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let tail = err_thread.join().unwrap_or_default();
    if status.success() {
        progress(1.0);
        Ok(())
    } else {
        Err(tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn montage_offsets_and_maps() {
        let clips = vec![
            PathBuf::from("a.mp4"),
            PathBuf::from("b.mp4"),
            PathBuf::from("c.mp4"),
        ];
        let o = MontageOptions {
            music: Some("m.mp3".into()),
            ..Default::default()
        };
        let c = build_montage_cmd("ffmpeg", &clips, &[5.0, 4.0, 3.0], Path::new("out.mp4"), &o)
            .unwrap();
        let fc = &c[c.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(fc.contains("offset=4.500"));
        assert!(fc.contains("offset=8.000"));
        assert!(fc.contains("[3:a]volume=0.6"));
        assert!(c.contains(&"[aout]".to_string()));
    }

    #[test]
    fn montage_validates() {
        let o = MontageOptions::default();
        assert_eq!(
            build_montage_cmd("ffmpeg", &[], &[], Path::new("o"), &o),
            Err(MontageError::NoClips)
        );
        let bad = MontageOptions {
            slowmo: 2.0,
            ..Default::default()
        };
        assert_eq!(
            build_montage_cmd("ffmpeg", &["a".into()], &[1.0], Path::new("o"), &bad),
            Err(MontageError::Slowmo)
        );
    }

    /// Runs a real ffmpeg montage if ffmpeg is installed (skipped otherwise).
    #[test]
    fn montage_runs_with_real_ffmpeg() {
        if !ffmpeg_available("ffmpeg") {
            eprintln!("ffmpeg not found, skipping");
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let mut clips = vec![];
        for (i, col) in ["red", "blue"].iter().enumerate() {
            let p = d.path().join(format!("c{i}.mp4"));
            run(&[
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={col}:s=320x180:d=2:r=30"),
                "-f",
                "lavfi",
                "-i",
                "sine=f=440:d=2",
                "-shortest",
                "-pix_fmt",
                "yuv420p",
            ]
            .iter()
            .map(|s| s.to_string())
            .chain([p.display().to_string()])
            .collect::<Vec<_>>())
            .unwrap();
            clips.push(p);
        }
        let out = d.path().join("m.mp4");
        let o = MontageOptions {
            width: 320,
            height: 180,
            fps: 30,
            slowmo: 0.5,
            ..Default::default()
        };
        run(&build_montage_cmd("ffmpeg", &clips, &[2.0, 2.0], &out, &o).unwrap()).unwrap();
        let dur = probe_duration("ffprobe", &out).unwrap();
        assert!((dur - 7.5).abs() < 0.3, "duration {dur}");
    }
}
