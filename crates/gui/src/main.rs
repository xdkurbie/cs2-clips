#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]
//! CS2 Clips desktop app.

mod theme;

use cs2clips_core::config::{secrets, CaptureBackend, Settings};
use cs2clips_core::model::{pretty_map, MatchData, Team};
use cs2clips_core::rules::Selectivity;
use cs2clips_core::{
    demo, detect_highlights, download, montage, plan, record, sharecode, steam, Highlight,
    HighlightKind, Rules,
};
use eframe::egui::{self, Color32, CornerRadius, RichText, Sense, Stroke, Vec2};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::SystemTime;
use theme::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Page {
    Matches,
    Highlights,
    Clips,
    Montage,
    Settings,
}

impl Page {
    const ALL: [Page; 5] = [
        Page::Matches,
        Page::Highlights,
        Page::Clips,
        Page::Montage,
        Page::Settings,
    ];
    fn label(self) -> &'static str {
        match self {
            Page::Matches => "Matches",
            Page::Highlights => "Highlights",
            Page::Clips => "Clips",
            Page::Montage => "Montage",
            Page::Settings => "Settings",
        }
    }
    fn icon(self) -> &'static str {
        match self {
            Page::Matches => "☰",
            Page::Highlights => "★",
            Page::Clips => "▶",
            Page::Montage => "🎞",
            Page::Settings => "⚙",
        }
    }
}

struct DemoEntry {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

struct Job {
    id: u64,
    title: String,
    progress: Option<f32>,
    status: String,
    done: bool,
    error: bool,
    cancel: Arc<AtomicBool>,
}

enum Msg {
    Progress {
        id: u64,
        frac: Option<f32>,
        text: String,
    },
    Finished {
        id: u64,
        result: Result<String, String>,
    },
    Parsed {
        path: PathBuf,
        data: Box<MatchData>,
    },
    Codes(Vec<sharecode::ShareCode>),
    Downloaded(PathBuf),
    Thumb(PathBuf, Option<egui::ColorImage>),
    ClipsReady(Vec<PathBuf>),
}

struct App {
    page: Page,
    settings: Settings,
    rules: Rules,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    jobs: Vec<Job>,
    next_job: u64,
    demos: Vec<DemoEntry>,
    current: Option<(PathBuf, MatchData)>,
    highlights: Vec<Highlight>,
    selected: HashSet<String>,
    player_filter: String,
    all_players: bool,
    new_codes: Vec<sharecode::ShareCode>,
    demo_url: String,
    clips: Vec<PathBuf>,
    thumbs: HashMap<PathBuf, egui::TextureHandle>,
    thumbs_pending: HashSet<PathBuf>,
    montage_list: Vec<PathBuf>,
    montage_opts: montage::MontageOptions,
    montage_name: String,
    api_key_in: String,
    auth_code_in: String,
    toast: Option<(String, bool, f64)>,
    ffmpeg_ok: Option<bool>,
    pinned_page: bool,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, open: Option<PathBuf>, page: Option<Page>) -> Self {
        theme::apply(&cc.egui_ctx);
        let settings = Settings::load();
        let rules = if settings.rules_file.is_empty() {
            Rules::default()
        } else {
            Rules::load(Path::new(&settings.rules_file)).unwrap_or_default()
        };
        let (tx, rx) = channel();
        let mut app = Self {
            page: page.unwrap_or(Page::Matches),
            player_filter: if settings.player_steamid.is_empty() {
                settings.player_name.clone()
            } else {
                settings.player_steamid.clone()
            },
            montage_opts: montage::MontageOptions {
                transition: settings.transition.clone(),
                slowmo: settings.slowmo,
                ..Default::default()
            },
            api_key_in: secrets::get(secrets::API_KEY).unwrap_or_default(),
            auth_code_in: secrets::get(secrets::AUTH_CODE).unwrap_or_default(),
            settings,
            rules,
            tx,
            rx,
            jobs: vec![],
            next_job: 1,
            demos: vec![],
            current: None,
            highlights: vec![],
            selected: HashSet::new(),
            all_players: false,
            new_codes: vec![],
            demo_url: String::new(),
            clips: vec![],
            thumbs: HashMap::new(),
            thumbs_pending: HashSet::new(),
            montage_list: vec![],
            montage_name: "montage".into(),
            toast: None,
            ffmpeg_ok: None,
            pinned_page: page.is_some(),
        };
        if app.player_filter.is_empty() {
            app.all_players = true;
        }
        app.rescan_demos();
        app.rescan_clips();
        let ff = app.settings.ffmpeg.clone();
        app.ffmpeg_ok = Some(montage::ffmpeg_available(&ff));
        if let Some(p) = open {
            app.analyze(&cc.egui_ctx, p);
        }
        app
    }

    fn job(
        &mut self,
        ctx: &egui::Context,
        title: &str,
        f: impl FnOnce(u64, Sender<Msg>, Arc<AtomicBool>) -> Result<String, String> + Send + 'static,
    ) {
        let id = self.next_job;
        self.next_job += 1;
        let cancel = Arc::new(AtomicBool::new(false));
        self.jobs.push(Job {
            id,
            title: title.into(),
            progress: None,
            status: "Starting…".into(),
            done: false,
            error: false,
            cancel: cancel.clone(),
        });
        let tx = self.tx.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let r = f(id, tx.clone(), cancel);
            let _ = tx.send(Msg::Finished { id, result: r });
            ctx.request_repaint();
        });
    }

    fn notify(&mut self, ctx: &egui::Context, text: impl Into<String>, ok: bool) {
        self.toast = Some((text.into(), ok, ctx.input(|i| i.time) + 4.0));
    }

    fn rescan_demos(&mut self) {
        let mut v = Vec::new();
        for d in self.settings.demo_dirs() {
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) == Some("dem") {
                        if let Ok(m) = e.metadata() {
                            v.push(DemoEntry {
                                path: p,
                                size: m.len(),
                                modified: m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                            });
                        }
                    }
                }
            }
        }
        if let Some((p, _)) = &self.current {
            if !v.iter().any(|d| &d.path == p) {
                if let Ok(m) = std::fs::metadata(p) {
                    v.push(DemoEntry {
                        path: p.clone(),
                        size: m.len(),
                        modified: m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    });
                }
            }
        }
        v.sort_by_key(|d| std::cmp::Reverse(d.modified));
        self.demos = v;
    }

    fn clips_dir(&self) -> PathBuf {
        self.settings.output_dir().join("clips")
    }

    fn rescan_clips(&mut self) {
        let mut v: Vec<PathBuf> = std::fs::read_dir(self.clips_dir())
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        matches!(
                            p.extension().and_then(|x| x.to_str()),
                            Some("mp4" | "mkv" | "mov")
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        self.clips = v;
    }

    fn analyze(&mut self, ctx: &egui::Context, path: PathBuf) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        self.job(ctx, &format!("Analyzing {name}"), move |id, tx, _| {
            let t2 = tx.clone();
            let data = demo::parse_demo(
                &path,
                Some(Box::new(move |f| {
                    let _ = t2.send(Msg::Progress {
                        id,
                        frac: Some(f),
                        text: format!("Parsing demo… {:.0}%", f * 100.0),
                    });
                })),
            )
            .map_err(|e| e.to_string())?;
            let summary = format!(
                "{} · {} rounds · {} kills",
                pretty_map(&data.map),
                data.rounds.len(),
                data.kills.len()
            );
            let _ = tx.send(Msg::Parsed {
                path,
                data: Box::new(data),
            });
            Ok(summary)
        });
    }

    fn redetect(&mut self) {
        if let Some((_, m)) = &self.current {
            let who = (!self.all_players && !self.player_filter.trim().is_empty())
                .then_some(self.player_filter.as_str());
            self.highlights = detect_highlights(m, &self.rules, who);
            self.selected = self.highlights.iter().map(|h| h.id()).collect();
        }
    }

    fn handle(&mut self, ctx: &egui::Context) {
        while let Ok(m) = self.rx.try_recv() {
            match m {
                Msg::Progress { id, frac, text } => {
                    if let Some(j) = self.jobs.iter_mut().find(|j| j.id == id) {
                        j.progress = frac;
                        j.status = text;
                    }
                }
                Msg::Finished { id, result } => {
                    if let Some(j) = self.jobs.iter_mut().find(|j| j.id == id) {
                        j.done = true;
                        j.progress = Some(1.0);
                        match &result {
                            Ok(s) => j.status = s.clone(),
                            Err(e) => {
                                j.status = e.clone();
                                j.error = true;
                            }
                        }
                    }
                    if let Err(e) = result {
                        self.notify(ctx, e, false);
                    }
                }
                Msg::Parsed { path, data } => {
                    // Remember the user's SteamID the first time their name shows up.
                    if self.settings.player_steamid.is_empty()
                        && !self.settings.player_name.is_empty()
                    {
                        let n = self.settings.player_name.to_lowercase();
                        if let Some((sid, _)) = data
                            .players()
                            .into_iter()
                            .find(|(_, name)| name.to_lowercase() == n)
                        {
                            self.settings.player_steamid = sid.to_string();
                            self.player_filter = sid.to_string();
                            let _ = self.settings.save();
                        }
                    }
                    self.current = Some((path, *data));
                    self.redetect();
                    self.rescan_demos();
                    if !self.pinned_page {
                        self.page = Page::Highlights;
                    }
                    self.pinned_page = false;
                }
                Msg::Codes(c) => {
                    if let Some(l) = c.last() {
                        self.settings.last_sharecode = l.to_string();
                        let _ = self.settings.save();
                    }
                    let n = c.len();
                    self.new_codes.extend(c);
                    self.notify(ctx, format!("{n} new match(es) found"), true);
                }
                Msg::Downloaded(p) => {
                    self.rescan_demos();
                    self.analyze(ctx, p);
                }
                Msg::Thumb(p, img) => {
                    self.thumbs_pending.remove(&p);
                    if let Some(img) = img {
                        let t = ctx.load_texture(
                            p.display().to_string(),
                            img,
                            egui::TextureOptions::LINEAR,
                        );
                        self.thumbs.insert(p, t);
                    }
                }
                Msg::ClipsReady(v) => {
                    self.rescan_clips();
                    self.montage_list.extend(v);
                    self.page = Page::Clips;
                }
            }
        }
    }

    // ---------------------------------------------------------------- layout

    fn sidebar(&mut self, ui: &mut egui::Ui) {
        ui.add_space(18.0);
        ui.horizontal(|ui| {
            ui.add_space(14.0);
            logo(ui, 30.0);
            ui.vertical(|ui| {
                ui.add_space(2.0);
                ui.label(RichText::new("CS2 Clips").size(18.0).strong());
                ui.label(
                    RichText::new(format!("v{}", env!("CARGO_PKG_VERSION")))
                        .small()
                        .color(MUTED),
                );
            });
        });
        ui.add_space(22.0);
        for p in Page::ALL {
            let active = self.page == p;
            let (rect, resp) =
                ui.allocate_exact_size(Vec2::new(ui.available_width(), 40.0), Sense::click());
            let painter = ui.painter();
            if active {
                painter.rect_filled(
                    rect.shrink2(Vec2::new(10.0, 2.0)),
                    CornerRadius::same(8),
                    CARD_HOVER,
                );
                painter.rect_filled(
                    egui::Rect::from_min_size(
                        rect.min + Vec2::new(10.0, 10.0),
                        Vec2::new(3.0, 20.0),
                    ),
                    CornerRadius::same(2),
                    ACCENT,
                );
            } else if resp.hovered() {
                painter.rect_filled(
                    rect.shrink2(Vec2::new(10.0, 2.0)),
                    CornerRadius::same(8),
                    CARD,
                );
            }
            let col = if active { TEXT } else { MUTED };
            painter.text(
                rect.left_center() + Vec2::new(26.0, 0.0),
                egui::Align2::LEFT_CENTER,
                p.icon(),
                egui::FontId::proportional(16.0),
                if active { ACCENT } else { col },
            );
            let mut label = p.label().to_string();
            if p == Page::Highlights && !self.highlights.is_empty() {
                label = format!("{label}  ·  {}", self.highlights.len());
            }
            if p == Page::Montage && !self.montage_list.is_empty() {
                label = format!("{label}  ·  {}", self.montage_list.len());
            }
            painter.text(
                rect.left_center() + Vec2::new(52.0, 0.0),
                egui::Align2::LEFT_CENTER,
                label,
                egui::FontId::proportional(15.0),
                col,
            );
            if resp
                .on_hover_cursor(egui::CursorIcon::PointingHand)
                .clicked()
            {
                self.page = p;
            }
        }
        ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
            ui.add_space(12.0);
            ui.horizontal(|ui| {
                ui.add_space(16.0);
                let (c, t) = match self.ffmpeg_ok {
                    Some(true) => (GOOD, "ffmpeg ready"),
                    _ => (BAD, "ffmpeg not found"),
                };
                dot(ui, c);
                ui.label(RichText::new(t).small().color(MUTED));
            });
            ui.horizontal(|ui| {
                ui.add_space(16.0);
                let (c, t) = if cfg!(windows) {
                    (GOOD, "Recording available")
                } else {
                    (MUTED, "Recording: Windows only")
                };
                dot(ui, c);
                ui.label(RichText::new(t).small().color(MUTED));
            });
        });
    }

    fn jobs_panel(&mut self, ui: &mut egui::Ui) {
        let active: Vec<usize> = (0..self.jobs.len()).rev().take(3).collect();
        for i in active {
            let j = &self.jobs[i];
            ui.horizontal(|ui| {
                let col = if j.error {
                    BAD
                } else if j.done {
                    GOOD
                } else {
                    ACCENT
                };
                ui.label(
                    RichText::new(if j.done {
                        if j.error {
                            "✖"
                        } else {
                            "✔"
                        }
                    } else {
                        "◌"
                    })
                    .color(col),
                );
                ui.label(RichText::new(&j.title).strong());
                ui.label(RichText::new(&j.status).color(MUTED).small());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if !j.done && ui.small_button("Cancel").clicked() {
                        j.cancel.store(true, Ordering::Relaxed);
                    }
                    let bar = egui::ProgressBar::new(j.progress.unwrap_or(0.0))
                        .desired_width(220.0)
                        .fill(col)
                        .corner_radius(CornerRadius::same(4));
                    let bar = if j.progress.is_none() && !j.done {
                        bar.animate(true)
                    } else {
                        bar
                    };
                    ui.add(bar);
                });
            });
        }
    }

    // ---------------------------------------------------------------- pages

    fn page_header(ui: &mut egui::Ui, title: &str, sub: &str) {
        ui.add_space(6.0);
        ui.label(RichText::new(title).heading().strong());
        ui.label(RichText::new(sub).color(MUTED));
        ui.add_space(10.0);
    }

    fn matches_page(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        Self::page_header(
            ui,
            "Matches",
            "Your CS2 demos. Analyze one to find highlights.",
        );
        ui.horizontal(|ui| {
            if ui
                .add(accent_button("⟳  Fetch new matches"))
                .on_hover_text("Walk your match history with the Steam Web API")
                .clicked()
            {
                let c = steam::Credentials {
                    api_key: self.api_key_in.clone(),
                    steamid64: self.settings.player_steamid.clone(),
                    auth_code: self.auth_code_in.clone(),
                };
                let last = self.settings.last_sharecode.clone();
                let tx = self.tx.clone();
                self.job(ctx, "Steam match history", move |_, _, _| {
                    let codes = steam::walk(&steam::UreqHttp::default(), &c, &last, 50)
                        .map_err(|e| e.to_string())?;
                    let n = codes.len();
                    let _ = tx.send(Msg::Codes(codes));
                    Ok(format!("{n} new match(es)"))
                });
            }
            if ui.button("📂  Open demo…").clicked() {
                if let Some(p) = rfd::FileDialog::new()
                    .add_filter("CS2 demo", &["dem", "bz2"])
                    .pick_file()
                {
                    if p.extension().and_then(|e| e.to_str()) == Some("bz2") {
                        let tx = self.tx.clone();
                        self.job(ctx, "Decompressing demo", move |_, _, _| {
                            let out = download::decompress_file(&p).map_err(|e| e.to_string())?;
                            let _ = tx.send(Msg::Downloaded(out.clone()));
                            Ok(out.display().to_string())
                        });
                    } else {
                        self.analyze(ctx, p);
                    }
                }
            }
            if ui.button("Refresh").clicked() {
                self.rescan_demos();
            }
        });
        ui.add_space(6.0);
        card(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Demo URL").strong());
                ui.add(
                    egui::TextEdit::singleline(&mut self.demo_url)
                        .hint_text("http://replay….valve.net/730/…dem.bz2")
                        .desired_width(ui.available_width() - 120.0),
                );
                if ui
                    .add_enabled(
                        self.demo_url.starts_with("http"),
                        egui::Button::new("Download"),
                    )
                    .clicked()
                {
                    let url = self.demo_url.trim().to_string();
                    let dir = cs2clips_core::config::data_dir().join("demos");
                    let tx = self.tx.clone();
                    self.demo_url.clear();
                    self.job(ctx, "Downloading demo", move |id, t2, _| {
                        let name = url
                            .rsplit('/')
                            .next()
                            .unwrap_or("match")
                            .split('.')
                            .next()
                            .unwrap_or("match")
                            .to_string();
                        let p = download::download_demo(&url, &dir, &name, |n, total| {
                            let frac = total.map(|t| n as f32 / t as f32);
                            let _ = t2.send(Msg::Progress {
                                id,
                                frac,
                                text: format!("{:.1} MB", n as f32 / 1e6),
                            });
                        })
                        .map_err(|e| e.to_string())?;
                        let _ = tx.send(Msg::Downloaded(p.clone()));
                        Ok("Downloaded".into())
                    });
                }
            });
            if !self.new_codes.is_empty() {
                ui.add_space(6.0);
                ui.label(RichText::new("New matches from Steam. Steam only shares the code, so open the match in CS2 (Watch → Your Matches) or a stats site, copy the replay link and paste it above.").small().color(MUTED));
                for c in self.new_codes.clone().iter().rev() {
                    ui.horizontal(|ui| {
                        ui.monospace(c.to_string());
                        ui.label(
                            RichText::new(format!("match {}", c.match_id))
                                .small()
                                .color(MUTED),
                        );
                        if ui.small_button("Copy").clicked() {
                            ui.ctx().copy_text(c.to_string());
                        }
                    });
                }
            }
        });
        ui.add_space(8.0);
        if self.demos.is_empty() {
            empty_state(
                ui,
                "No demos yet",
                "Set your CS2 folder in Settings, download a demo by URL, or open a .dem file.",
            );
            return;
        }
        let mut to_analyze = None;
        egui::ScrollArea::vertical()
            .auto_shrink([false; 2])
            .show(ui, |ui| {
                for d in &self.demos {
                    let is_current = self
                        .current
                        .as_ref()
                        .map(|(p, _)| p == &d.path)
                        .unwrap_or(false);
                    let resp = card(ui, |ui| {
                        ui.horizontal(|ui| {
                            let map = if is_current {
                                self.current
                                    .as_ref()
                                    .map(|(_, m)| m.map.clone())
                                    .unwrap_or_default()
                            } else {
                                String::new()
                            };
                            map_tile(ui, &map, Vec2::new(120.0, 64.0));
                            ui.vertical(|ui| {
                                ui.label(
                                    RichText::new(
                                        d.path.file_name().unwrap_or_default().to_string_lossy(),
                                    )
                                    .strong(),
                                );
                                ui.label(
                                    RichText::new(format!(
                                        "{}  ·  {:.0} MB  ·  {}",
                                        ago(d.modified),
                                        d.size as f64 / 1e6,
                                        d.path
                                            .parent()
                                            .map(|p| p.display().to_string())
                                            .unwrap_or_default()
                                    ))
                                    .small()
                                    .color(MUTED),
                                );
                                if is_current {
                                    if let Some((_, m)) = &self.current {
                                        let (t, ct) = m.score();
                                        ui.horizontal(|ui| {
                                            chip(ui, &format!("T {t}"), T_COL);
                                            chip(ui, &format!("CT {ct}"), CT_COL);
                                            chip(
                                                ui,
                                                &format!("{} HIGHLIGHTS", self.highlights.len()),
                                                ACCENT,
                                            );
                                        });
                                    }
                                }
                            });
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    if ui
                                        .add(accent_button(if is_current {
                                            "Open"
                                        } else {
                                            "Analyze"
                                        }))
                                        .clicked()
                                    {
                                        to_analyze = Some((d.path.clone(), is_current));
                                    }
                                },
                            );
                        });
                    });
                    let _ = resp;
                    ui.add_space(4.0);
                }
            });
        if let Some((p, cur)) = to_analyze {
            if cur {
                self.page = Page::Highlights;
            } else {
                self.analyze(ctx, p);
            }
        }
    }

    fn highlights_page(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let Some((path, m)) = &self.current else {
            Self::page_header(ui, "Highlights", "Analyze a match first.");
            empty_state(ui, "No match selected", "Go to Matches and analyze a demo.");
            return;
        };
        let (path, tickrate) = (path.clone(), m.tickrate);
        let (t, ct) = m.score();
        let players = m.players();
        ui.horizontal(|ui| {
            map_tile(ui, &m.map, Vec2::new(150.0, 80.0));
            ui.vertical(|ui| {
                ui.label(RichText::new(pretty_map(&m.map)).heading().strong());
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(t.to_string())
                            .size(22.0)
                            .color(T_COL)
                            .strong(),
                    );
                    ui.label(RichText::new(":").size(22.0).color(MUTED));
                    ui.label(
                        RichText::new(ct.to_string())
                            .size(22.0)
                            .color(CT_COL)
                            .strong(),
                    );
                    ui.label(
                        RichText::new(format!(
                            "   {} rounds · {} kills · {} tick",
                            m.rounds.len(),
                            m.kills.len(),
                            m.tickrate
                        ))
                        .color(MUTED),
                    );
                });
            });
        });
        ui.add_space(8.0);
        let mut changed = false;
        ui.horizontal(|ui| {
            ui.label("Player");
            let label = if self.all_players {
                "Everyone".to_string()
            } else {
                players
                    .iter()
                    .find(|(s, n)| {
                        s.to_string() == self.player_filter
                            || n.eq_ignore_ascii_case(&self.player_filter)
                    })
                    .map(|(_, n)| n.clone())
                    .unwrap_or(self.player_filter.clone())
            };
            egui::ComboBox::from_id_salt("player")
                .selected_text(label)
                .width(200.0)
                .show_ui(ui, |ui| {
                    if ui.selectable_label(self.all_players, "Everyone").clicked() {
                        self.all_players = true;
                        changed = true;
                    }
                    for (sid, n) in &players {
                        if ui
                            .selectable_label(
                                !self.all_players && self.player_filter == sid.to_string(),
                                n,
                            )
                            .clicked()
                        {
                            self.all_players = false;
                            self.player_filter = sid.to_string();
                            changed = true;
                        }
                    }
                });
            ui.separator();
            ui.label("Selectivity");
            for (s, l) in [
                (Selectivity::Low, "Low"),
                (Selectivity::Medium, "Medium"),
                (Selectivity::High, "High"),
            ] {
                if ui
                    .selectable_label(self.rules.selectivity == s, l)
                    .clicked()
                {
                    self.rules.selectivity = s;
                    changed = true;
                }
            }
        });
        if changed {
            self.redetect();
        }
        ui.add_space(4.0);
        let n_sel = self
            .highlights
            .iter()
            .filter(|h| self.selected.contains(&h.id()))
            .count();
        ui.horizontal(|ui| {
            let rec = ui.add_enabled(
                cfg!(windows) && n_sel > 0,
                accent_button(&format!("⏺  Record {n_sel} clip(s)")),
            );
            let rec = if cfg!(windows) {
                rec
            } else {
                rec.on_disabled_hover_text(
                    "Recording needs CS2 on Windows. Export the plan and record on your PC.",
                )
            };
            if rec.clicked() {
                let mut p = plan::ClipPlan::new(&path, tickrate, &self.highlights);
                for it in &mut p.items {
                    it.enabled = self.selected.contains(&it.id);
                }
                let s = self.settings.clone();
                let out = self.clips_dir();
                let tx = self.tx.clone();
                self.job(ctx, "Recording clips", move |id, t2, cancel| {
                    let files = record::record_plan(&s, &p, &out, &cancel, |e| {
                        let _ = t2.send(Msg::Progress {
                            id,
                            frac: Some(e.fraction),
                            text: e.text,
                        });
                    })
                    .map_err(|e| e.to_string())?;
                    let n = files.len();
                    let _ = tx.send(Msg::ClipsReady(files));
                    Ok(format!("{n} clip(s) recorded"))
                });
            }
            if ui.button("Export plan…").clicked() {
                if let Some(f) = rfd::FileDialog::new()
                    .set_file_name("clip-plan.json")
                    .save_file()
                {
                    let mut p = plan::ClipPlan::new(&path, tickrate, &self.highlights);
                    p.items.retain(|it| self.selected.contains(&it.id));
                    let r = std::fs::write(&f, serde_json::to_string_pretty(&p).unwrap());
                    self.notify(
                        ctx,
                        if r.is_ok() {
                            "Plan saved".to_string()
                        } else {
                            "Could not save plan".to_string()
                        },
                        r.is_ok(),
                    );
                }
            }
            if ui.button("Select all").clicked() {
                self.selected = self.highlights.iter().map(|h| h.id()).collect();
            }
            if ui.button("None").clicked() {
                self.selected.clear();
            }
        });
        ui.add_space(6.0);
        if self.highlights.is_empty() {
            empty_state(
                ui,
                "No highlights with these settings",
                "Try 'Everyone' or a lower selectivity.",
            );
            return;
        }
        let max_score = self
            .highlights
            .iter()
            .map(|h| h.score)
            .max()
            .unwrap_or(1)
            .max(1);
        egui::ScrollArea::vertical()
            .auto_shrink([false; 2])
            .show(ui, |ui| {
                for h in &self.highlights {
                    let id = h.id();
                    let mut on = self.selected.contains(&id);
                    card(ui, |ui| {
                        ui.horizontal(|ui| {
                            if ui.checkbox(&mut on, "").changed() {
                                if on {
                                    self.selected.insert(id.clone());
                                } else {
                                    self.selected.remove(&id);
                                }
                            }
                            highlight_tile(ui, h, Vec2::new(150.0, 84.0));
                            ui.vertical(|ui| {
                                ui.horizontal(|ui| {
                                    ui.label(RichText::new(h.title()).size(16.0).strong());
                                });
                                ui.horizontal(|ui| {
                                    let tc = if h.team == Team::T { T_COL } else { CT_COL };
                                    ui.label(RichText::new(&h.name).color(tc));
                                    ui.label(
                                        RichText::new(format!(
                                            "Round {}  ·  {:.1}s  ·  tick {}",
                                            h.round,
                                            h.duration_s(tickrate),
                                            h.start_tick
                                        ))
                                        .small()
                                        .color(MUTED),
                                    );
                                });
                                ui.horizontal_wrapped(|ui| {
                                    for c in h.chips() {
                                        chip(ui, &c, ACCENT);
                                    }
                                });
                            });
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.vertical(|ui| {
                                        ui.label(
                                            RichText::new(h.score.to_string())
                                                .size(22.0)
                                                .strong()
                                                .color(ACCENT),
                                        );
                                        ui.add(
                                            egui::ProgressBar::new(
                                                h.score as f32 / max_score as f32,
                                            )
                                            .desired_width(70.0)
                                            .desired_height(5.0)
                                            .fill(ACCENT),
                                        );
                                    });
                                },
                            );
                        });
                    });
                    ui.add_space(4.0);
                }
            });
    }

    fn clips_page(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        Self::page_header(
            ui,
            "Clips",
            &format!("Recorded clips in {}", self.clips_dir().display()),
        );
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.rescan_clips();
            }
            if ui.button("Add files…").clicked() {
                if let Some(fs) = rfd::FileDialog::new()
                    .add_filter("Video", &["mp4", "mkv", "mov"])
                    .pick_files()
                {
                    let dir = self.clips_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    for f in fs {
                        if let Some(n) = f.file_name() {
                            let _ = std::fs::copy(&f, dir.join(n));
                        }
                    }
                    self.rescan_clips();
                }
            }
            if ui.button("Open folder").clicked() {
                let d = self.clips_dir();
                let _ = std::fs::create_dir_all(&d);
                let _ = open::that(d);
            }
        });
        if self.clips.is_empty() {
            empty_state(
                ui,
                "No clips yet",
                "Record highlights on Windows, or add existing video files.",
            );
            return;
        }
        // Kick off thumbnail jobs.
        let ff = self.settings.ffmpeg.clone();
        for c in self.clips.clone() {
            if !self.thumbs.contains_key(&c)
                && !self.thumbs_pending.contains(&c)
                && self.ffmpeg_ok == Some(true)
            {
                self.thumbs_pending.insert(c.clone());
                let tx = self.tx.clone();
                let ff = ff.clone();
                let ctx = ctx.clone();
                std::thread::spawn(move || {
                    let dir = cs2clips_core::config::data_dir().join("thumbs");
                    let _ = std::fs::create_dir_all(&dir);
                    let out = dir.join(format!(
                        "{}.jpg",
                        record::sanitize(&c.display().to_string())
                    ));
                    let _ = montage::run(&montage::thumbnail_cmd(&ff, &c, &out, 1.0));
                    let img = image::open(&out).ok().map(|i| {
                        let i = i.to_rgba8();
                        egui::ColorImage::from_rgba_unmultiplied(
                            [i.width() as usize, i.height() as usize],
                            &i,
                        )
                    });
                    let _ = tx.send(Msg::Thumb(c, img));
                    ctx.request_repaint();
                });
            }
        }
        let w = 240.0;
        let cols = ((ui.available_width() / (w + 44.0)).floor() as usize).max(1);
        egui::ScrollArea::vertical()
            .auto_shrink([false; 2])
            .show(ui, |ui| {
                for row in self.clips.clone().chunks(cols) {
                    ui.horizontal(|ui| {
                        for c in row {
                            tile_card(ui, w, |ui| {
                                let size = Vec2::new(w, w * 9.0 / 16.0);
                                if let Some(t) = self.thumbs.get(c) {
                                    ui.add(
                                        egui::Image::new(t)
                                            .fit_to_exact_size(size)
                                            .corner_radius(CornerRadius::same(6)),
                                    );
                                } else {
                                    let (r, _) = ui.allocate_exact_size(size, Sense::hover());
                                    ui.painter().rect_filled(r, CornerRadius::same(6), PANEL);
                                    ui.painter().text(
                                        r.center(),
                                        egui::Align2::CENTER_CENTER,
                                        "▶",
                                        egui::FontId::proportional(30.0),
                                        MUTED,
                                    );
                                }
                                ui.label(
                                    RichText::new(
                                        c.file_stem().unwrap_or_default().to_string_lossy(),
                                    )
                                    .strong(),
                                );
                                ui.horizontal(|ui| {
                                    if ui.small_button("Play").clicked() {
                                        let _ = open::that(c);
                                    }
                                    let inm = self.montage_list.contains(c);
                                    if ui
                                        .add_enabled(
                                            !inm,
                                            egui::Button::new(if inm {
                                                "In montage"
                                            } else {
                                                "+ Montage"
                                            })
                                            .small(),
                                        )
                                        .clicked()
                                    {
                                        self.montage_list.push(c.clone());
                                    }
                                });
                            });
                        }
                    });
                    ui.add_space(6.0);
                }
            });
    }

    fn montage_page(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        Self::page_header(
            ui,
            "Montage",
            "Order your clips, pick a transition and music, and render one video with ffmpeg.",
        );
        ui.columns(2, |cols| {
            let ui = &mut cols[0];
            card(ui, |ui| {
                ui.label(RichText::new("Timeline").strong());
                if self.montage_list.is_empty() {
                    ui.label(RichText::new("Add clips from the Clips page.").color(MUTED));
                }
                let mut action: Option<(usize, i32)> = None;
                for (i, c) in self.montage_list.iter().enumerate() {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(format!("{:>2}", i + 1))
                                .monospace()
                                .color(ACCENT),
                        );
                        ui.label(c.file_stem().unwrap_or_default().to_string_lossy());
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.small_button("✖").clicked() {
                                action = Some((i, 0));
                            }
                            if ui
                                .add_enabled(
                                    i + 1 < self.montage_list.len(),
                                    egui::Button::new("▼").small(),
                                )
                                .clicked()
                            {
                                action = Some((i, 1));
                            }
                            if ui
                                .add_enabled(i > 0, egui::Button::new("▲").small())
                                .clicked()
                            {
                                action = Some((i, -1));
                            }
                        });
                    });
                }
                match action {
                    Some((i, 0)) => {
                        self.montage_list.remove(i);
                    }
                    Some((i, d)) => self.montage_list.swap(i, (i as i32 + d) as usize),
                    None => {}
                }
            });
            let ui = &mut cols[1];
            card(ui, |ui| {
                ui.label(RichText::new("Style").strong());
                egui::Grid::new("mopts")
                    .num_columns(2)
                    .spacing([12.0, 10.0])
                    .show(ui, |ui| {
                        ui.label("Transition");
                        egui::ComboBox::from_id_salt("tr")
                            .selected_text(&self.montage_opts.transition)
                            .show_ui(ui, |ui| {
                                for t in montage::TRANSITIONS {
                                    ui.selectable_value(
                                        &mut self.montage_opts.transition,
                                        t.to_string(),
                                        *t,
                                    );
                                }
                            });
                        ui.end_row();
                        ui.label("Transition length");
                        ui.add(
                            egui::Slider::new(&mut self.montage_opts.transition_s, 0.0..=1.5)
                                .suffix(" s"),
                        );
                        ui.end_row();
                        ui.label("Speed");
                        ui.add(
                            egui::Slider::new(&mut self.montage_opts.slowmo, 0.25..=1.0)
                                .custom_formatter(|v, _| format!("{:.0}%", v * 100.0)),
                        );
                        ui.end_row();
                        ui.label("Music");
                        ui.horizontal(|ui| {
                            let name = self
                                .montage_opts
                                .music
                                .as_ref()
                                .and_then(|m| m.file_name())
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or("None".into());
                            if ui.button(name).clicked() {
                                self.montage_opts.music = rfd::FileDialog::new()
                                    .add_filter("Audio", &["mp3", "wav", "ogg", "flac", "m4a"])
                                    .pick_file();
                            }
                            if self.montage_opts.music.is_some() && ui.small_button("✖").clicked()
                            {
                                self.montage_opts.music = None;
                            }
                        });
                        ui.end_row();
                        ui.label("Music volume");
                        ui.add(egui::Slider::new(
                            &mut self.montage_opts.music_volume,
                            0.0..=1.0,
                        ));
                        ui.end_row();
                        ui.label("Duck under game audio");
                        ui.checkbox(&mut self.montage_opts.duck, "");
                        ui.end_row();
                        ui.label("Intro title");
                        let mut t = self.montage_opts.intro_text.clone().unwrap_or_default();
                        if ui.text_edit_singleline(&mut t).changed() {
                            self.montage_opts.intro_text = (!t.is_empty()).then_some(t);
                        }
                        ui.end_row();
                        ui.label("File name");
                        ui.text_edit_singleline(&mut self.montage_name);
                        ui.end_row();
                    });
                ui.add_space(8.0);
                let ready = !self.montage_list.is_empty() && self.ffmpeg_ok == Some(true);
                if ui
                    .add_enabled(ready, accent_button("🎬  Render montage"))
                    .clicked()
                {
                    let clips = self.montage_list.clone();
                    let opts = self.montage_opts.clone();
                    let ff = self.settings.ffmpeg.clone();
                    let out = self
                        .settings
                        .output_dir()
                        .join(format!("{}.mp4", record::sanitize(&self.montage_name)));
                    self.job(ctx, "Rendering montage", move |id, tx, cancel| {
                        let probe = montage::ffprobe_for(&ff);
                        let durs: Vec<f32> = clips
                            .iter()
                            .map(|c| {
                                montage::probe_duration(&probe, c)
                                    .ok_or(format!("ffprobe failed on {}", c.display()))
                            })
                            .collect::<Result<_, _>>()?;
                        let has_audio = clips.iter().all(|c| montage::has_audio(&probe, c));
                        let o = montage::MontageOptions {
                            clips_have_audio: has_audio,
                            ..opts
                        };
                        let total = durs.iter().sum::<f32>() / o.slowmo
                            - o.transition_s * (durs.len() as f32 - 1.0);
                        let _ = std::fs::create_dir_all(out.parent().unwrap());
                        let cmd = montage::build_montage_cmd(&ff, &clips, &durs, &out, &o)
                            .map_err(|e| e.to_string())?;
                        montage::run_with_progress(
                            &cmd,
                            total,
                            |f| {
                                let _ = tx.send(Msg::Progress {
                                    id,
                                    frac: Some(f),
                                    text: format!("{:.0}%", f * 100.0),
                                });
                            },
                            &cancel,
                        )?;
                        let _ = open::that(out.parent().unwrap());
                        Ok(format!("Saved {}", out.display()))
                    });
                }
                if self.ffmpeg_ok != Some(true) {
                    ui.label(
                        RichText::new(
                            "ffmpeg was not found. Install it or set its path in Settings.",
                        )
                        .color(BAD)
                        .small(),
                    );
                }
            });
        });
    }

    fn settings_page(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        Self::page_header(
            ui,
            "Settings",
            "Stored locally. The Steam key and auth code go to the OS credential store.",
        );
        egui::ScrollArea::vertical().auto_shrink([false; 2]).show(ui, |ui| {
            let s = &mut self.settings;
            card(ui, |ui| {
                ui.label(RichText::new("Player & Steam").strong());
                egui::Grid::new("steam").num_columns(2).spacing([14.0, 10.0]).show(ui, |ui| {
                    ui.label("Steam name");
                    ui.add(egui::TextEdit::singleline(&mut s.player_name).hint_text("e.g. rasu420").desired_width(320.0));
                    ui.end_row();
                    ui.label("SteamID64");
                    ui.add(egui::TextEdit::singleline(&mut s.player_steamid).hint_text("17 digits, auto-filled from your first demo").desired_width(320.0));
                    ui.end_row();
                    ui.label("Steam Web API key");
                    ui.add(egui::TextEdit::singleline(&mut self.api_key_in).password(true).desired_width(320.0));
                    ui.end_row();
                    ui.label("Game authentication code");
                    ui.add(egui::TextEdit::singleline(&mut self.auth_code_in).password(true).hint_text("XXXX-XXXXX-XXXX").desired_width(320.0));
                    ui.end_row();
                    ui.label("Latest share code");
                    let ok = s.last_sharecode.is_empty() || sharecode::is_valid(&s.last_sharecode);
                    ui.horizontal(|ui| {
                        ui.add(egui::TextEdit::singleline(&mut s.last_sharecode).hint_text("CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx").desired_width(320.0));
                        if !ok {
                            ui.label(RichText::new("invalid").color(BAD));
                        }
                    });
                    ui.end_row();
                });
                ui.horizontal(|ui| {
                    ui.hyperlink_to("Get an API key", "https://steamcommunity.com/dev/apikey");
                    ui.hyperlink_to("Get your auth code + share code", "https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128");
                });
            });
            ui.add_space(8.0);
            card(ui, |ui| {
                ui.label(RichText::new("Paths").strong());
                egui::Grid::new("paths").num_columns(3).spacing([14.0, 10.0]).show(ui, |ui| {
                    ui.label("CS2 game/csgo folder");
                    ui.add_sized([380.0, 28.0], egui::TextEdit::singleline(&mut s.cs2_dir).hint_text(cs2clips_core::config::detect_cs2_dir().map(|p| p.display().to_string()).unwrap_or("auto-detect (not found)".into())));
                    if ui.button("Browse").clicked() {
                        if let Some(d) = rfd::FileDialog::new().pick_folder() {
                            s.cs2_dir = d.display().to_string();
                        }
                    }
                    ui.end_row();
                    ui.label("Steam executable");
                    ui.add_sized([380.0, 28.0], egui::TextEdit::singleline(&mut s.steam_exe));
                    if ui.button("Browse").clicked() {
                        if let Some(f) = rfd::FileDialog::new().pick_file() {
                            s.steam_exe = f.display().to_string();
                        }
                    }
                    ui.end_row();
                    ui.label("ffmpeg");
                    ui.add_sized([380.0, 28.0], egui::TextEdit::singleline(&mut s.ffmpeg));
                    if ui.button("Test").clicked() {
                        self.ffmpeg_ok = Some(montage::ffmpeg_available(&s.ffmpeg));
                    }
                    ui.end_row();
                    ui.label("Output folder");
                    let hint = s.output_dir().display().to_string();
                    ui.add_sized([380.0, 28.0], egui::TextEdit::singleline(&mut s.output_dir).hint_text(hint));
                    if ui.button("Browse").clicked() {
                        if let Some(d) = rfd::FileDialog::new().pick_folder() {
                            s.output_dir = d.display().to_string();
                        }
                    }
                    ui.end_row();
                });
            });
            ui.add_space(8.0);
            card(ui, |ui| {
                ui.label(RichText::new("Recording").strong());
                egui::Grid::new("rec").num_columns(2).spacing([14.0, 10.0]).show(ui, |ui| {
                    ui.label("Capture");
                    ui.horizontal(|ui| {
                        ui.selectable_value(&mut s.capture, CaptureBackend::Ffmpeg, "ffmpeg (window capture)");
                        ui.selectable_value(&mut s.capture, CaptureBackend::Obs, "OBS (planned)");
                        ui.selectable_value(&mut s.capture, CaptureBackend::Hlae, "HLAE (planned)");
                    });
                    ui.end_row();
                    ui.label("Frame rate");
                    ui.add(egui::Slider::new(&mut s.fps, 30..=144).suffix(" fps"));
                    ui.end_row();
                    ui.label("Resolution");
                    ui.horizontal(|ui| {
                        for (w, h) in [(1280, 720), (1920, 1080), (2560, 1440)] {
                            ui.selectable_value(&mut s.resolution, (w, h), format!("{h}p"));
                        }
                    });
                    ui.end_row();
                });
                ui.label(RichText::new("CS2 is started with -insecure (VAC off, demo playback only) and -netconport so the app can seek the demo. Close CS2 before playing online again.").small().color(MUTED));
            });
            ui.add_space(8.0);
            card(ui, |ui| {
                ui.label(RichText::new("Highlight rules").strong());
                let r = &mut self.rules;
                egui::Grid::new("rules").num_columns(2).spacing([14.0, 10.0]).show(ui, |ui| {
                    ui.label("Multikill window");
                    ui.add(egui::Slider::new(&mut r.multikill_window_s, 0.0..=30.0).suffix(" s").custom_formatter(|v, _| if v == 0.0 { "whole round".into() } else { format!("{v:.0}") }));
                    ui.end_row();
                    ui.label("Minimum multikill");
                    ui.add(egui::Slider::new(&mut r.min_multikill, 2..=5).suffix("K"));
                    ui.end_row();
                    ui.label("Clutches");
                    ui.horizontal(|ui| {
                        ui.checkbox(&mut r.detect_clutches, "");
                        ui.add_enabled(r.detect_clutches, egui::Slider::new(&mut r.min_clutch_enemies, 1..=5).prefix("1v"));
                    });
                    ui.end_row();
                    ui.label("Single-kill specials");
                    ui.horizontal(|ui| {
                        ui.checkbox(&mut r.detect_noscopes, "Noscopes");
                        ui.checkbox(&mut r.detect_wallbangs, "Wallbangs");
                        ui.checkbox(&mut r.detect_smoke_kills, "Through smoke");
                        ui.checkbox(&mut r.detect_headshots, "Headshots");
                    });
                    ui.end_row();
                    ui.label("Pre-roll / post-roll");
                    ui.horizontal(|ui| {
                        ui.add(egui::DragValue::new(&mut r.pre_roll_s).range(0.0..=15.0).suffix(" s").speed(0.1));
                        ui.add(egui::DragValue::new(&mut r.post_roll_s).range(0.0..=15.0).suffix(" s").speed(0.1));
                    });
                    ui.end_row();
                    ui.label("Scores");
                    ui.horizontal_wrapped(|ui| {
                        for (l, v) in [("2K", &mut r.scores.k2), ("3K", &mut r.scores.k3), ("4K", &mut r.scores.k4), ("Ace", &mut r.scores.ace), ("Clutch", &mut r.scores.clutch), ("Noscope", &mut r.scores.noscope)] {
                            ui.label(RichText::new(l).small().color(MUTED));
                            ui.add(egui::DragValue::new(v).range(0..=500));
                        }
                    });
                    ui.end_row();
                });
                ui.horizontal(|ui| {
                    if ui.button("Import rules…").clicked() {
                        if let Some(f) = rfd::FileDialog::new().add_filter("Rules", &["yaml", "yml", "json"]).pick_file() {
                            match Rules::load(&f) {
                                Ok(nr) => {
                                    *r = nr;
                                    s.rules_file = f.display().to_string();
                                }
                                Err(e) => self.toast = Some((e.to_string(), false, ctx.input(|i| i.time) + 4.0)),
                            }
                        }
                    }
                    if ui.button("Export rules…").clicked() {
                        if let Some(f) = rfd::FileDialog::new().set_file_name("rules.yaml").save_file() {
                            let _ = r.save(&f);
                        }
                    }
                    if ui.button("Reset to defaults").clicked() {
                        *r = Rules::default();
                    }
                });
            });
            ui.add_space(12.0);
            if ui.add(accent_button("Save settings")).clicked() {
                let mut errs = vec![];
                if let Err(e) = self.rules.validate() {
                    errs.push(e.to_string());
                }
                if let Err(e) = secrets::set(secrets::API_KEY, self.api_key_in.trim()) {
                    errs.push(format!("API key: {e}"));
                }
                if let Err(e) = secrets::set(secrets::AUTH_CODE, self.auth_code_in.trim()) {
                    errs.push(format!("auth code: {e}"));
                }
                if !self.settings.rules_file.is_empty() {
                    let _ = self.rules.save(Path::new(&self.settings.rules_file));
                } else {
                    let p = cs2clips_core::config::config_dir().join("rules.yaml");
                    if self.rules.save(&p).is_ok() {
                        self.settings.rules_file = p.display().to_string();
                    }
                }
                if let Err(e) = self.settings.save() {
                    errs.push(e.to_string());
                }
                self.ffmpeg_ok = Some(montage::ffmpeg_available(&self.settings.ffmpeg));
                self.rescan_demos();
                self.redetect();
                if errs.is_empty() {
                    self.notify(ctx, "Settings saved", true);
                } else {
                    self.notify(ctx, errs.join("; "), false);
                }
            }
            ui.add_space(20.0);
        });
    }
}

fn dot(ui: &mut egui::Ui, c: Color32) {
    let (r, _) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
    ui.painter().circle_filled(r.center(), 4.0, c);
}

fn ago(t: SystemTime) -> String {
    let s = SystemTime::now()
        .duration_since(t)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86_399 => format!("{} h ago", s / 3600),
        _ => format!("{} days ago", s / 86_400),
    }
}

fn logo(ui: &mut egui::Ui, size: f32) {
    let (r, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    let p = ui.painter();
    p.rect(
        r,
        CornerRadius::same((size * 0.22) as u8),
        PANEL,
        Stroke::new(2.0, ACCENT),
        egui::StrokeKind::Inside,
    );
    let c = r.center();
    let rad = size * 0.3;
    p.circle_stroke(c, rad, Stroke::new(2.0, ACCENT));
    let s = size * 0.13;
    p.add(egui::Shape::convex_polygon(
        vec![
            c + Vec2::new(-s * 0.7, -s),
            c + Vec2::new(-s * 0.7, s),
            c + Vec2::new(s * 1.1, 0.0),
        ],
        TEXT,
        Stroke::NONE,
    ));
}

fn map_tile(ui: &mut egui::Ui, map: &str, size: Vec2) {
    let (r, _) = ui.allocate_exact_size(size, Sense::hover());
    let p = ui.painter_at(r);
    let col = if map.is_empty() {
        Color32::from_rgb(60, 64, 76)
    } else {
        map_color(map)
    };
    p.rect_filled(r, CornerRadius::same(8), col.gamma_multiply(0.35));
    // diagonal stripes
    let mut x = r.left() - r.height();
    while x < r.right() {
        p.line_segment(
            [
                egui::pos2(x, r.bottom()),
                egui::pos2(x + r.height(), r.top()),
            ],
            Stroke::new(6.0, col.gamma_multiply(0.18)),
        );
        x += 18.0;
    }
    p.rect_stroke(
        r,
        CornerRadius::same(8),
        Stroke::new(1.0, col.gamma_multiply(0.7)),
        egui::StrokeKind::Inside,
    );
    let name = if map.is_empty() {
        "DEMO".to_string()
    } else {
        pretty_map(map).to_uppercase()
    };
    p.text(
        r.left_bottom() + Vec2::new(10.0, -8.0),
        egui::Align2::LEFT_BOTTOM,
        name,
        egui::FontId::proportional(size.y * 0.24),
        TEXT,
    );
}

fn highlight_tile(ui: &mut egui::Ui, h: &Highlight, size: Vec2) {
    let (r, _) = ui.allocate_exact_size(size, Sense::hover());
    let p = ui.painter_at(r);
    let col = map_color(&h.map);
    p.rect_filled(r, CornerRadius::same(8), Color32::from_rgb(16, 18, 23));
    p.rect_filled(
        r.shrink(1.0),
        CornerRadius::same(8),
        col.gamma_multiply(0.22),
    );
    let label = match h.kind {
        HighlightKind::Ace => "ACE".to_string(),
        HighlightKind::MultiKill(n) => format!("{n}K"),
        HighlightKind::Clutch { enemies } => format!("1v{enemies}"),
        HighlightKind::Noscope => "NS".into(),
        HighlightKind::Wallbang => "WB".into(),
        HighlightKind::SmokeKill => "SMK".into(),
        HighlightKind::Headshot => "HS".into(),
    };
    let accent = if matches!(h.kind, HighlightKind::Ace | HighlightKind::Clutch { .. }) {
        ACCENT
    } else {
        TEXT
    };
    p.text(
        r.left_top() + Vec2::new(10.0, 6.0),
        egui::Align2::LEFT_TOP,
        label,
        egui::FontId::proportional(28.0),
        accent,
    );
    // kill pips
    let n = h.kills().min(5);
    for i in 0..5 {
        let c = r.left_bottom() + Vec2::new(16.0 + i as f32 * 20.0, -16.0);
        if i < n {
            p.circle_filled(c, 6.0, ACCENT);
        } else {
            p.circle_stroke(c, 6.0, Stroke::new(1.0, MUTED.gamma_multiply(0.5)));
        }
    }
    p.text(
        r.right_top() + Vec2::new(-8.0, 8.0),
        egui::Align2::RIGHT_TOP,
        format!("R{}", h.round),
        egui::FontId::proportional(12.0),
        MUTED,
    );
}

fn empty_state(ui: &mut egui::Ui, title: &str, sub: &str) {
    ui.add_space(60.0);
    ui.vertical_centered(|ui| {
        logo(ui, 44.0);
        ui.label(RichText::new(title).size(18.0).strong());
        ui.label(RichText::new(sub).color(MUTED));
    });
}

impl eframe::App for App {
    fn ui(&mut self, root: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = &root.ctx().clone();
        self.handle(ctx);
        if self.jobs.iter().any(|j| !j.done) {
            ctx.request_repaint_after(std::time::Duration::from_millis(100));
        }
        egui::Panel::left("nav")
            .exact_size(220.0)
            .resizable(false)
            .frame(
                egui::Frame::new()
                    .fill(PANEL)
                    .stroke(Stroke::new(1.0, BORDER)),
            )
            .show(root, |ui| self.sidebar(ui));
        if !self.jobs.is_empty() {
            egui::Panel::bottom("jobs")
                .frame(
                    egui::Frame::new()
                        .fill(PANEL)
                        .inner_margin(egui::Margin::symmetric(16, 8))
                        .stroke(Stroke::new(1.0, BORDER)),
                )
                .show(root, |ui| self.jobs_panel(ui));
        }
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(BG)
                    .inner_margin(egui::Margin::symmetric(28, 20)),
            )
            .show(root, |ui| match self.page {
                Page::Matches => self.matches_page(ui, ctx),
                Page::Highlights => self.highlights_page(ui, ctx),
                Page::Clips => self.clips_page(ui, ctx),
                Page::Montage => self.montage_page(ui, ctx),
                Page::Settings => self.settings_page(ui, ctx),
            });
        if let Some((t, ok, until)) = self.toast.clone() {
            if ctx.input(|i| i.time) > until {
                self.toast = None;
            } else {
                egui::Area::new(egui::Id::new("toast"))
                    .anchor(egui::Align2::RIGHT_TOP, Vec2::new(-20.0, 20.0))
                    .show(ctx, |ui| {
                        egui::Frame::new()
                            .fill(CARD_HOVER)
                            .stroke(Stroke::new(1.0, if ok { GOOD } else { BAD }))
                            .corner_radius(CornerRadius::same(8))
                            .inner_margin(egui::Margin::same(12))
                            .show(ui, |ui| {
                                ui.set_max_width(380.0);
                                ui.label(RichText::new(t).color(if ok { GOOD } else { BAD }));
                            });
                    });
                ctx.request_repaint_after(std::time::Duration::from_millis(250));
            }
        }
    }
}

fn main() -> eframe::Result<()> {
    let mut open = None;
    let mut page = None;
    for a in std::env::args().skip(1) {
        if let Some(p) = a.strip_prefix("--page=") {
            page = Page::ALL
                .into_iter()
                .find(|x| x.label().eq_ignore_ascii_case(p));
        } else {
            open = Some(PathBuf::from(a));
        }
    }
    let icon = image::load_from_memory(include_bytes!("../../../assets/icon-256.png"))
        .ok()
        .map(|i| {
            let i = i.to_rgba8();
            egui::IconData {
                width: i.width(),
                height: i.height(),
                rgba: i.into_raw(),
            }
        });
    let mut vp = egui::ViewportBuilder::default()
        .with_title("CS2 Clips")
        .with_inner_size([1280.0, 800.0])
        .with_min_inner_size([960.0, 600.0]);
    if let Some(i) = icon {
        vp = vp.with_icon(Arc::new(i));
    }
    eframe::run_native(
        "CS2 Clips",
        eframe::NativeOptions {
            viewport: vp,
            ..Default::default()
        },
        Box::new(move |cc| Ok(Box::new(App::new(cc, open, page)))),
    )
}
