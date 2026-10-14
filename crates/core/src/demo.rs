//! CS2 demo parsing with the `source2-demo` crate (pure Rust, maintained).
//!
//! We listen to game events (`player_death`, `round_freeze_end`, `round_end`)
//! and read `CCSPlayerController` / game-rules entities for names, SteamIDs,
//! teams and the round counter.

use crate::model::{Kill, MatchData, RosterEntry, Round, Team};
use source2_demo::prelude::*;
use source2_demo::proto::CDemoFileHeader;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum DemoError {
    #[error("could not open demo: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a CS2 (Source 2) demo or the file is damaged: {0}")]
    Parse(String),
}

type Progress = Box<dyn FnMut(f32)>;

struct Collector {
    data: MatchData,
    last_tick: u32,
    progress: Option<Progress>,
    last_reported: u32,
}

/// Bots have SteamID 0; give them a stable pseudo-ID so they still count.
fn bot_id(slot: i32) -> u64 {
    1000 + slot as u64
}

struct PlayerInfo {
    steamid: u64,
    name: String,
    team: Team,
}

fn controller(ctx: &Context, slot: i32) -> Option<PlayerInfo> {
    if slot < 0 {
        return None;
    }
    let e = ctx
        .entities()
        .get_by_index((slot & 0xFF) as usize + 1)
        .ok()?;
    if e.class().name() != "CCSPlayerController" {
        return None;
    }
    read_controller(e, slot)
}

fn read_controller(e: &Entity, slot: i32) -> Option<PlayerInfo> {
    let name: String = try_property!(e, String, "{}", "m_iszPlayerName").unwrap_or_default();
    let steamid: u64 = try_property!(e, u64, "{}", "m_steamID").unwrap_or(0);
    let team: i64 = try_property!(e, i64, "{}", "m_iTeamNum").unwrap_or(0);
    Some(PlayerInfo {
        steamid: if steamid == 0 { bot_id(slot) } else { steamid },
        name,
        team: Team::from_num(team),
    })
}

fn rules_prop<T>(ctx: &Context, prop: &str) -> Option<T>
where
    for<'x> &'x FieldValue: TryInto<T>,
{
    let e = ctx.entities().get_by_class_name("CCSGameRulesProxy").ok()?;
    e.get_property(prop).ok().and_then(|v| v.try_into().ok())
}

fn ev_i(ge: &GameEvent, k: &str) -> i32 {
    ge.get_value(k)
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or(-1)
}
fn ev_b(ge: &GameEvent, k: &str) -> bool {
    match ge.get_value(k) {
        Ok(EventValue::Bool(b)) => *b,
        Ok(EventValue::Int(i)) => *i != 0,
        Ok(EventValue::Byte(b)) => *b != 0,
        _ => false,
    }
}
fn ev_s(ge: &GameEvent, k: &str) -> String {
    ge.get_value(k)
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_default()
}

impl Collector {
    fn current_round(&self, ctx: &Context) -> u32 {
        rules_prop::<i32>(ctx, "m_pGameRules.m_totalRoundsPlayed")
            .map(|r| r as u32 + 1)
            .unwrap_or_else(|| self.data.rounds.len().max(1) as u32)
    }
    fn warmup(ctx: &Context) -> bool {
        rules_prop::<bool>(ctx, "m_pGameRules.m_bWarmupPeriod").unwrap_or(false)
    }
}

impl Observer for Collector {
    fn interests(&self) -> Interests {
        Interests::BASE_GAME_EVENT
            | Interests::ENTITY_STATE
            | Interests::DEMO_MESSAGE
            | Interests::TICK_END
    }

    fn on_demo_command(&mut self, _ctx: &Context, t: EDemoCommands, msg: &[u8]) -> ObserverResult {
        if t == EDemoCommands::DemFileHeader {
            if let Ok(h) = CDemoFileHeader::decode(msg) {
                self.data.map = h.map_name().to_string();
            }
        }
        Ok(())
    }

    fn on_tick_end(&mut self, ctx: &Context) -> ObserverResult {
        let t = ctx.tick();
        if self.last_tick > 0 && t >= self.last_reported + 2048 {
            self.last_reported = t;
            if let Some(p) = self.progress.as_mut() {
                p((t as f32 / self.last_tick as f32).min(1.0));
            }
        }
        Ok(())
    }

    fn on_game_event(&mut self, ctx: &Context, ge: &GameEvent) -> ObserverResult {
        let tick = ctx.tick();
        match ge.name() {
            "round_freeze_end" => {
                if Self::warmup(ctx) {
                    return Ok(());
                }
                let round = self.current_round(ctx);
                self.data.rounds.retain(|r| r.number != round);
                self.data.rounds.push(Round {
                    number: round,
                    start_tick: tick,
                    end_tick: None,
                    winner: None,
                });
                self.data.roster.retain(|r| r.round != round);
                for e in ctx
                    .entities()
                    .iter()
                    .filter(|e| e.class().name() == "CCSPlayerController")
                {
                    let alive: bool =
                        try_property!(e, bool, "{}", "m_bPawnIsAlive").unwrap_or(true);
                    if let Some(p) = read_controller(e, e.index() as i32 - 1) {
                        if p.team != Team::None && alive {
                            self.data.roster.push(RosterEntry {
                                round,
                                steamid: p.steamid,
                                name: p.name,
                                team: p.team,
                            });
                        }
                    }
                }
            }
            "round_end" => {
                if let Some(r) = self.data.rounds.last_mut().filter(|r| r.end_tick.is_none()) {
                    r.end_tick = Some(tick);
                    r.winner = Some(Team::from_num(ev_i(ge, "winner") as i64))
                        .filter(|t| *t != Team::None);
                }
            }
            "player_death" => {
                if Self::warmup(ctx) || self.data.rounds.is_empty() {
                    return Ok(());
                }
                let victim = controller(ctx, ev_i(ge, "userid"));
                let attacker = controller(ctx, ev_i(ge, "attacker"));
                let (Some(v), a) = (victim, attacker) else {
                    return Ok(());
                };
                let a = a.unwrap_or(PlayerInfo {
                    steamid: 0,
                    name: "world".into(),
                    team: Team::None,
                });
                self.data.kills.push(Kill {
                    tick,
                    round: self.data.rounds.last().map(|r| r.number).unwrap_or(1),
                    attacker_steamid: a.steamid,
                    attacker_name: a.name,
                    attacker_team: a.team,
                    victim_steamid: v.steamid,
                    victim_name: v.name,
                    victim_team: v.team,
                    weapon: ev_s(ge, "weapon"),
                    headshot: ev_b(ge, "headshot"),
                    wallbang: ev_i(ge, "penetrated") > 0,
                    noscope: ev_b(ge, "noscope"),
                    through_smoke: ev_b(ge, "thrusmoke"),
                    attacker_blind: ev_b(ge, "attackerblind"),
                });
            }
            _ => {}
        }
        Ok(())
    }
}

/// Parse a `.dem` file. `progress` receives 0.0..=1.0.
pub fn parse_demo(path: &Path, progress: Option<Progress>) -> Result<MatchData, DemoError> {
    let file = BufReader::new(File::open(path)?);
    let mut parser = Parser::from_reader(file).map_err(|e| DemoError::Parse(e.to_string()))?;
    let info = parser.replay_info().clone();
    let last_tick = info.playback_ticks().max(0) as u32;
    let tickrate = if info.playback_time() > 0.0 {
        (last_tick as f32 / info.playback_time()).round()
    } else {
        64.0
    };
    let obs = parser.add_observer(Collector {
        data: MatchData {
            tickrate: if tickrate > 0.0 { tickrate } else { 64.0 },
            total_ticks: last_tick,
            ..Default::default()
        },
        last_tick,
        progress,
        last_reported: 0,
    });
    parser
        .run_to_end()
        .map_err(|e| DemoError::Parse(e.to_string()))?;
    drop(parser);
    let c = std::rc::Rc::try_unwrap(obs)
        .map_err(|_| DemoError::Parse("internal".into()))?
        .into_inner();
    let mut data = c.data;
    // Drop rounds that never went live (e.g. a restarted round with no end).
    data.rounds.sort_by_key(|r| r.number);
    Ok(data)
}

/// Cheap header check without a full parse.
pub fn is_cs2_demo(path: &Path) -> bool {
    use std::io::Read;
    let mut b = [0u8; 8];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut b))
        .map(|_| &b == b"PBDEMS2\0")
        .unwrap_or(false)
}
