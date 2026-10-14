//! Plain data extracted from a demo. Independent of the parser so detection is
//! fully unit-testable.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum Team {
    #[default]
    None,
    T,
    CT,
}

impl Team {
    pub fn from_num(n: i64) -> Self {
        match n {
            2 => Team::T,
            3 => Team::CT,
            _ => Team::None,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Team::T => "T",
            Team::CT => "CT",
            Team::None => "-",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Kill {
    pub tick: u32,
    pub round: u32,
    pub attacker_steamid: u64,
    pub attacker_name: String,
    pub attacker_team: Team,
    pub victim_steamid: u64,
    pub victim_name: String,
    pub victim_team: Team,
    pub weapon: String,
    pub headshot: bool,
    pub wallbang: bool,
    pub noscope: bool,
    pub through_smoke: bool,
    pub attacker_blind: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Round {
    pub number: u32,
    pub start_tick: u32,
    pub end_tick: Option<u32>,
    pub winner: Option<Team>,
}

/// A player that was on a team when the round went live.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RosterEntry {
    pub round: u32,
    pub steamid: u64,
    pub name: String,
    pub team: Team,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MatchData {
    pub map: String,
    pub tickrate: f32,
    pub total_ticks: u32,
    pub kills: Vec<Kill>,
    pub rounds: Vec<Round>,
    pub roster: Vec<RosterEntry>,
}

impl MatchData {
    pub fn players(&self) -> Vec<(u64, String)> {
        let mut v: Vec<(u64, String)> = Vec::new();
        for r in &self.roster {
            if !v.iter().any(|(s, _)| *s == r.steamid) {
                v.push((r.steamid, r.name.clone()));
            }
        }
        v
    }
    pub fn score(&self) -> (u32, u32) {
        let t = self
            .rounds
            .iter()
            .filter(|r| r.winner == Some(Team::T))
            .count() as u32;
        let ct = self
            .rounds
            .iter()
            .filter(|r| r.winner == Some(Team::CT))
            .count() as u32;
        (t, ct)
    }
}

pub fn pretty_map(map: &str) -> String {
    let m = map.trim_start_matches("de_").trim_start_matches("cs_");
    let mut c = m.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

pub fn pretty_weapon(w: &str) -> String {
    let w = w.trim_start_matches("weapon_");
    let known = [
        ("ak47", "AK-47"),
        ("m4a1", "M4A4"),
        ("m4a1_silencer", "M4A1-S"),
        ("awp", "AWP"),
        ("deagle", "Desert Eagle"),
        ("galilar", "Galil AR"),
        ("usp_silencer", "USP-S"),
        ("glock", "Glock-18"),
        ("ssg08", "SSG 08"),
        ("famas", "FAMAS"),
        ("hkp2000", "P2000"),
        ("p250", "P250"),
        ("tec9", "Tec-9"),
        ("fiveseven", "Five-SeveN"),
        ("mp9", "MP9"),
        ("mac10", "MAC-10"),
        ("ump45", "UMP-45"),
        ("sg556", "SG 553"),
        ("aug", "AUG"),
        ("hegrenade", "HE Grenade"),
        ("inferno", "Molotov"),
        ("knife", "Knife"),
    ];
    known
        .iter()
        .find(|(k, _)| *k == w)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| {
            if w.len() <= 4 {
                w.to_uppercase()
            } else {
                pretty_map(w)
            }
        })
}
