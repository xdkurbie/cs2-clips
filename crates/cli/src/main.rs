//! `cs2clips` command line interface.

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use cs2clips_core::config::{secrets, Settings};
use cs2clips_core::{demo, detect_highlights, download, montage, plan, sharecode, steam, Rules};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "cs2clips",
    version,
    about = "Find, plan and render CS2 highlights from demos"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Parse a demo and list highlights.
    Scan {
        demo: PathBuf,
        /// SteamID64 or player name (default: from settings).
        #[arg(short, long)]
        player: Option<String>,
        /// Rules file (YAML/JSON).
        #[arg(short, long)]
        rules: Option<PathBuf>,
        /// Show every player's highlights.
        #[arg(long)]
        all: bool,
        /// Print JSON instead of a table.
        #[arg(long)]
        json: bool,
        /// Write a clip plan (JSON) to this path.
        #[arg(long)]
        plan: Option<PathBuf>,
    },
    /// Print a match summary (map, score, players, kills).
    Info { demo: PathBuf },
    /// Decode or encode a share code.
    Sharecode {
        code: Option<String>,
        #[arg(long, requires_all = ["outcome", "token"])]
        match_id: Option<u64>,
        #[arg(long)]
        outcome: Option<u64>,
        #[arg(long)]
        token: Option<u16>,
    },
    /// List new matches since the last known share code (Steam Web API).
    Matches {
        #[arg(long)]
        since: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Download (and decompress) a demo URL into the demo folder.
    Download {
        url: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Write a CS2 .cfg that jumps to a highlight (for manual recording).
    Cfg {
        plan: PathBuf,
        #[arg(long, default_value_t = 0)]
        index: usize,
    },
    /// Build a montage from recorded clips with ffmpeg.
    Montage {
        #[arg(required = true)]
        clips: Vec<PathBuf>,
        #[arg(short, long, default_value = "montage.mp4")]
        out: PathBuf,
        #[arg(long)]
        music: Option<PathBuf>,
        #[arg(long, default_value = "fade")]
        transition: String,
        #[arg(long, default_value_t = 1.0)]
        slowmo: f32,
        #[arg(long)]
        title: Option<String>,
        /// Print the ffmpeg command instead of running it.
        #[arg(long)]
        dry_run: bool,
    },
    /// Store Steam credentials in the OS credential store.
    Login {
        #[arg(long)]
        steamid: String,
        #[arg(long)]
        api_key: String,
        #[arg(long)]
        auth_code: String,
        #[arg(long)]
        last_code: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let mut settings = Settings::load();
    match cli.cmd {
        Cmd::Scan {
            demo,
            player,
            rules,
            all,
            json,
            plan: plan_out,
        } => {
            let rules = match rules.or_else(|| {
                (!settings.rules_file.is_empty()).then(|| settings.rules_file.clone().into())
            }) {
                Some(p) => Rules::load(&p).with_context(|| format!("rules {}", p.display()))?,
                None => Rules::default(),
            };
            eprintln!("Parsing {} ...", demo.display());
            let m = demo::parse_demo(&demo, None)?;
            let who = if all {
                None
            } else {
                player
                    .or_else(|| non_empty(&settings.player_steamid))
                    .or_else(|| non_empty(&settings.player_name))
            };
            let hs = detect_highlights(&m, &rules, who.as_deref());
            if json {
                println!("{}", serde_json::to_string_pretty(&hs)?);
            } else {
                let (t, ct) = m.score();
                println!(
                    "{}  T {t} : {ct} CT   {} rounds, {} kills, tickrate {}",
                    m.map,
                    m.rounds.len(),
                    m.kills.len(),
                    m.tickrate
                );
                println!(
                    " rnd score  {:<20} {:<36}    len  tags",
                    "player", "highlight"
                );
                for h in &hs {
                    println!(
                        "{:>4} {:>5}  {:<20} {:<36} {:>5.1}s  {}",
                        h.round,
                        h.score,
                        trunc(&h.name, 20),
                        trunc(&h.title(), 36),
                        h.duration_s(m.tickrate),
                        h.chips().join(", ")
                    );
                }
                if hs.is_empty() {
                    println!(
                        "(no highlights{} — try --all or a lower selectivity)",
                        who.map(|w| format!(" for {w}")).unwrap_or_default()
                    );
                }
            }
            if let Some(p) = plan_out {
                std::fs::write(
                    &p,
                    serde_json::to_string_pretty(&plan::ClipPlan::new(&demo, m.tickrate, &hs))?,
                )?;
                eprintln!("Plan written to {}", p.display());
            }
        }
        Cmd::Info { demo } => {
            let m = demo::parse_demo(&demo, None)?;
            let (t, ct) = m.score();
            println!(
                "map {}  score T {t} : {ct} CT  rounds {}  kills {}  ticks {}",
                m.map,
                m.rounds.len(),
                m.kills.len(),
                m.total_ticks
            );
            for (sid, name) in m.players() {
                let k = m
                    .kills
                    .iter()
                    .filter(|k| k.attacker_steamid == sid && k.victim_team != k.attacker_team)
                    .count();
                let d = m.kills.iter().filter(|k| k.victim_steamid == sid).count();
                println!("  {name:<24} {sid:>17}  {k:>3} K / {d:>3} D");
            }
        }
        Cmd::Sharecode {
            code,
            match_id,
            outcome,
            token,
        } => {
            if let Some(c) = code {
                let sc = sharecode::decode(&c)?;
                println!(
                    "match_id   {}\noutcome_id {}\ntoken      {}",
                    sc.match_id, sc.outcome_id, sc.token
                );
            } else if let (Some(m), Some(o), Some(t)) = (match_id, outcome, token) {
                println!(
                    "{}",
                    sharecode::ShareCode {
                        match_id: m,
                        outcome_id: o,
                        token: t
                    }
                );
            } else {
                bail!("give a share code, or --match-id/--outcome/--token");
            }
        }
        Cmd::Matches { since, limit } => {
            let c = steam::Credentials {
                api_key: secrets::get(secrets::API_KEY).unwrap_or_default(),
                steamid64: settings.player_steamid.clone(),
                auth_code: secrets::get(secrets::AUTH_CODE).unwrap_or_default(),
            };
            let last = since.unwrap_or_else(|| settings.last_sharecode.clone());
            let codes = steam::walk(&steam::UreqHttp::default(), &c, &last, limit)?;
            if codes.is_empty() {
                println!("No new matches since {last}");
            }
            for sc in &codes {
                println!("{sc}  match {}", sc.match_id);
            }
            if let Some(l) = codes.last() {
                settings.last_sharecode = l.to_string();
                settings.save()?;
            }
            println!("\nNote: Steam does not publish demo URLs for share codes. Get the replay link from CS2 (Watch → Your Matches) and use `cs2clips download <url>`.");
        }
        Cmd::Download { url, name, out } => {
            let dir = out.unwrap_or_else(|| settings.demo_dirs().into_iter().next().unwrap());
            let name = name.unwrap_or_else(|| {
                url.rsplit('/')
                    .next()
                    .unwrap_or("match")
                    .split('.')
                    .next()
                    .unwrap_or("match")
                    .to_string()
            });
            let mut last = 0;
            let p = download::download_demo(&url, &dir, &name, |n, total| {
                if n - last > 4 << 20 {
                    last = n;
                    match total {
                        Some(t) => eprint!("\r{:.0}%  ", n as f64 * 100.0 / t as f64),
                        None => eprint!("\r{} MB  ", n >> 20),
                    }
                }
            })?;
            eprintln!();
            println!("{}", p.display());
        }
        Cmd::Cfg { plan: p, index } => {
            let plan: plan::ClipPlan = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
            let it = plan.items.get(index).context("no such clip index")?;
            let game = settings
                .cs2_game_dir()
                .context("CS2 folder not found; set cs2_dir in settings")?;
            let rel = demo_rel(&plan.demo, &game);
            let cfg = game.join("cfg").join("cs2clips.cfg");
            std::fs::write(&cfg, plan::make_cfg(&rel, it))?;
            println!(
                "Wrote {}. In CS2 (launched with -insecure) type: exec cs2clips",
                cfg.display()
            );
        }
        Cmd::Montage {
            clips,
            out,
            music,
            transition,
            slowmo,
            title,
            dry_run,
        } => {
            let probe = montage::ffprobe_for(&settings.ffmpeg);
            let durs: Vec<f32> = clips
                .iter()
                .map(|c| {
                    montage::probe_duration(&probe, c)
                        .with_context(|| format!("ffprobe failed on {}", c.display()))
                })
                .collect::<Result<_>>()?;
            let clips_have_audio = clips.iter().all(|c| montage::has_audio(&probe, c));
            let o = montage::MontageOptions {
                clips_have_audio,
                music,
                transition,
                slowmo,
                intro_text: title,
                ..Default::default()
            };
            let cmd = montage::build_montage_cmd(&settings.ffmpeg, &clips, &durs, &out, &o)?;
            if dry_run {
                println!(
                    "{}",
                    cmd.iter()
                        .map(|a| if a.contains(' ') || a.contains(';') {
                            format!("\"{a}\"")
                        } else {
                            a.clone()
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                );
            } else {
                montage::run(&cmd).map_err(anyhow::Error::msg)?;
                println!("{}", out.display());
            }
        }
        Cmd::Login {
            steamid,
            api_key,
            auth_code,
            last_code,
        } => {
            sharecode::decode(&last_code)?;
            secrets::set(secrets::API_KEY, &api_key).map_err(anyhow::Error::msg)?;
            secrets::set(secrets::AUTH_CODE, &auth_code).map_err(anyhow::Error::msg)?;
            settings.player_steamid = steamid;
            settings.last_sharecode = last_code;
            settings.save()?;
            println!("Saved. Secrets are in the OS credential store.");
        }
    }
    Ok(())
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.into()
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}

/// `playdemo` path relative to `game/csgo`, without extension.
fn demo_rel(demo: &std::path::Path, game: &std::path::Path) -> String {
    let p = demo
        .strip_prefix(game)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| demo.to_path_buf());
    p.with_extension("")
        .display()
        .to_string()
        .replace('\\', "/")
}
