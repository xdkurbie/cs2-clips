//! Rule-based highlight detection on [`MatchData`].

use crate::model::{pretty_map, pretty_weapon, Kill, MatchData, Team};
use crate::rules::Rules;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HighlightKind {
    MultiKill(u8),
    Ace,
    Clutch { enemies: u8 },
    Noscope,
    Wallbang,
    SmokeKill,
    Headshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Tag {
    AllHeadshots,
    Noscope,
    Wallbang,
    ThroughSmoke,
    Blind,
    Fast,
}

impl Tag {
    pub fn label(self) -> &'static str {
        match self {
            Tag::AllHeadshots => "ALL HS",
            Tag::Noscope => "NOSCOPE",
            Tag::Wallbang => "WALLBANG",
            Tag::ThroughSmoke => "SMOKE",
            Tag::Blind => "BLIND",
            Tag::Fast => "FAST",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Highlight {
    pub kind: HighlightKind,
    pub round: u32,
    pub steamid: u64,
    pub name: String,
    pub team: Team,
    pub start_tick: u32,
    pub end_tick: u32,
    /// Ticks of the kills that make up the highlight.
    pub kill_ticks: Vec<u32>,
    pub score: i32,
    pub tags: Vec<Tag>,
    pub weapon: String,
    pub map: String,
}

impl Highlight {
    pub fn kills(&self) -> usize {
        self.kill_ticks.len()
    }

    pub fn id(&self) -> String {
        format!("r{:02}-{}-{}", self.round, self.steamid, self.start_tick)
    }

    pub fn duration_s(&self, tickrate: f32) -> f32 {
        (self.end_tick.saturating_sub(self.start_tick)) as f32 / tickrate.max(1.0)
    }

    /// e.g. "Mirage AK-47 1v3 3K Clutch".
    pub fn title(&self) -> String {
        let mut parts = vec![pretty_map(&self.map), pretty_weapon(&self.weapon)];
        match self.kind {
            HighlightKind::Clutch { enemies } => {
                parts.push(format!("1v{enemies}"));
                if self.kills() >= 2 {
                    parts.push(format!("{}K", self.kills()));
                }
                parts.push("Clutch".into());
            }
            HighlightKind::Ace => parts.push("Ace".into()),
            HighlightKind::MultiKill(n) => parts.push(format!("{n}K")),
            HighlightKind::Noscope => parts.push("Noscope".into()),
            HighlightKind::Wallbang => parts.push("Wallbang".into()),
            HighlightKind::SmokeKill => parts.push("Smoke Kill".into()),
            HighlightKind::Headshot => parts.push("Headshot".into()),
        }
        parts.retain(|p| !p.is_empty());
        parts.join(" ")
    }

    pub fn chips(&self) -> Vec<String> {
        let mut c = Vec::new();
        if self.kills() >= 2 {
            c.push(format!("{} KILLS", self.kills()));
        }
        if let HighlightKind::Clutch { enemies } = self.kind {
            c.push(format!("1V{enemies} CLUTCH"));
        }
        c.extend(self.tags.iter().map(|t| t.label().to_string()));
        c
    }
}

fn valid(k: &Kill) -> bool {
    k.attacker_steamid != 0
        && k.attacker_steamid != k.victim_steamid
        && k.attacker_team != k.victim_team
        && k.attacker_team != Team::None
}

fn chains(ticks: &[u32], window: u32) -> Vec<Vec<u32>> {
    if window == 0 {
        return if ticks.is_empty() {
            vec![]
        } else {
            vec![ticks.to_vec()]
        };
    }
    let mut out: Vec<Vec<u32>> = Vec::new();
    for &t in ticks {
        match out.last_mut() {
            Some(cur) if t - *cur.last().unwrap() <= window => cur.push(t),
            _ => out.push(vec![t]),
        }
    }
    out
}

fn most_common(ws: &[&str]) -> String {
    let mut m: HashMap<&str, usize> = HashMap::new();
    for w in ws {
        *m.entry(w).or_default() += 1;
    }
    let mut v: Vec<_> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    v.first().map(|(w, _)| w.to_string()).unwrap_or_default()
}

struct Ctx<'a> {
    rules: &'a Rules,
    tickrate: f32,
}

impl Ctx<'_> {
    fn ticks(&self, s: f32) -> u32 {
        (s * self.tickrate).round() as u32
    }
    fn span(&self, first: u32, last: u32) -> (u32, u32) {
        (
            first.saturating_sub(self.ticks(self.rules.pre_roll_s)),
            last + self.ticks(self.rules.post_roll_s),
        )
    }
    fn kill_tags(&self, k: &Kill) -> Vec<Tag> {
        let r = self.rules;
        let mut t = Vec::new();
        if r.detect_noscopes && k.noscope {
            t.push(Tag::Noscope);
        }
        if r.detect_wallbangs && k.wallbang {
            t.push(Tag::Wallbang);
        }
        if r.detect_smoke_kills && k.through_smoke {
            t.push(Tag::ThroughSmoke);
        }
        if k.attacker_blind {
            t.push(Tag::Blind);
        }
        t
    }
    fn tag_score(&self, t: Tag) -> i32 {
        let s = &self.rules.scores;
        match t {
            Tag::Noscope => s.noscope,
            Tag::Wallbang => s.wallbang,
            Tag::ThroughSmoke => s.through_smoke,
            Tag::Blind => s.blind,
            Tag::AllHeadshots | Tag::Fast => 0,
        }
    }
    fn weapon_bonus(&self, w: &str) -> i32 {
        let w = w.trim_start_matches("weapon_");
        self.rules.weapon_bonus.get(w).copied().unwrap_or(0)
    }
}

/// Detect highlights. `player` filters by SteamID64 or case-insensitive name.
pub fn detect_highlights(m: &MatchData, rules: &Rules, player: Option<&str>) -> Vec<Highlight> {
    let tickrate = if m.tickrate > 0.0 {
        m.tickrate
    } else {
        rules.tickrate
    };
    let cx = Ctx { rules, tickrate };
    let mut kills: Vec<&Kill> = m.kills.iter().filter(|k| valid(k)).collect();
    kills.sort_by_key(|k| k.tick);

    let mut groups: BTreeMap<(u32, u64), Vec<&Kill>> = BTreeMap::new();
    for k in &kills {
        groups
            .entry((k.round, k.attacker_steamid))
            .or_default()
            .push(k);
    }

    let mut out = Vec::new();
    let window = cx.ticks(rules.multikill_window_s);
    for ((round, sid), g) in &groups {
        let name = g.last().unwrap().attacker_name.clone();
        let team = g[0].attacker_team;
        let enemies = m
            .roster
            .iter()
            .filter(|r| r.round == *round && r.team != team && r.team != Team::None)
            .count();
        let ticks: Vec<u32> = g.iter().map(|k| k.tick).collect();
        let mut in_multi: Vec<u32> = Vec::new();
        for chain in chains(&ticks, window) {
            let n = chain.len();
            if n < rules.min_multikill {
                continue;
            }
            let sub: Vec<&&Kill> = g.iter().filter(|k| chain.contains(&k.tick)).collect();
            let ace = n >= 5 && (enemies == 0 || n >= enemies);
            let kind = if ace {
                HighlightKind::Ace
            } else {
                HighlightKind::MultiKill(n.min(5) as u8)
            };
            let hs = sub.iter().filter(|k| k.headshot).count() as i32;
            let mut tags: Vec<Tag> = sub.iter().flat_map(|k| cx.kill_tags(k)).collect();
            if hs as usize == n {
                tags.push(Tag::AllHeadshots);
            }
            let span_s = (chain[n - 1] - chain[0]) as f32 / tickrate;
            let mut score = if ace {
                rules.scores.ace
            } else {
                rules.scores.multikill(n)
            } + hs * rules.scores.headshot;
            if rules.multikill_window_s > 0.0 {
                score += ((rules.multikill_window_s - span_s).max(0.0) as i32)
                    * rules.scores.speed_bonus_per_s;
            }
            if span_s <= n as f32 * 1.0 {
                tags.push(Tag::Fast);
            }
            score += tags.iter().map(|t| cx.tag_score(*t)).sum::<i32>();
            let weapons: Vec<&str> = sub.iter().map(|k| k.weapon.as_str()).collect();
            let weapon = most_common(&weapons);
            score += cx.weapon_bonus(&weapon);
            tags.sort();
            tags.dedup();
            let (s, e) = cx.span(chain[0], chain[n - 1]);
            in_multi.extend(&chain);
            out.push(Highlight {
                kind,
                round: *round,
                steamid: *sid,
                name: name.clone(),
                team,
                start_tick: s,
                end_tick: e,
                kill_ticks: chain,
                score,
                tags,
                weapon,
                map: m.map.clone(),
            });
        }
        // Single-kill specials not already part of a multikill.
        for k in g.iter().filter(|k| !in_multi.contains(&k.tick)) {
            let mut tags = cx.kill_tags(k);
            let kind = match tags.first() {
                Some(Tag::Noscope) => HighlightKind::Noscope,
                Some(Tag::Wallbang) => HighlightKind::Wallbang,
                Some(Tag::ThroughSmoke) => HighlightKind::SmokeKill,
                _ if rules.detect_headshots && k.headshot => HighlightKind::Headshot,
                _ => continue,
            };
            let mut score: i32 = tags.iter().map(|t| cx.tag_score(*t)).sum();
            if kind == HighlightKind::Headshot {
                score += rules.scores.headshot;
            }
            score += cx.weapon_bonus(&k.weapon);
            if !tags.is_empty() {
                tags.remove(0);
            }
            let (s, e) = cx.span(k.tick, k.tick);
            out.push(Highlight {
                kind,
                round: *round,
                steamid: *sid,
                name: name.clone(),
                team,
                start_tick: s,
                end_tick: e,
                kill_ticks: vec![k.tick],
                score,
                tags,
                weapon: k.weapon.clone(),
                map: m.map.clone(),
            });
        }
    }

    if rules.detect_clutches && !m.roster.is_empty() {
        out.extend(clutches(m, &kills, &cx));
    }
    let mut out = merge(out, cx.ticks(rules.merge_gap_s));
    if let Some(p) = player.map(str::trim).filter(|p| !p.is_empty()) {
        let pl = p.to_lowercase();
        out.retain(|h| h.steamid.to_string() == p || h.name.to_lowercase() == pl);
    }
    let min = rules.effective_min_score();
    out.retain(|h| h.score >= min);
    out.sort_by_key(|h| (h.round, h.start_tick));
    out
}

fn clutches(m: &MatchData, kills: &[&Kill], cx: &Ctx) -> Vec<Highlight> {
    let rules = cx.rules;
    let mut out = Vec::new();
    for rd in &m.rounds {
        let Some(winner) = rd.winner else { continue };
        let mut alive: HashMap<u64, (Team, String)> = m
            .roster
            .iter()
            .filter(|r| r.round == rd.number && r.team != Team::None)
            .map(|r| (r.steamid, (r.team, r.name.clone())))
            .collect();
        // Include every death (also teamkills/suicides) for the alive count.
        let mut deaths: Vec<&Kill> = m.kills.iter().filter(|k| k.round == rd.number).collect();
        deaths.sort_by_key(|k| k.tick);
        let mut found: Option<(u64, Team, String, usize, u32)> = None;
        for k in &deaths {
            alive.remove(&k.victim_steamid);
            if found.is_some() {
                continue;
            }
            for team in [Team::T, Team::CT] {
                let mine: Vec<_> = alive.iter().filter(|(_, (t, _))| *t == team).collect();
                let enemies = alive.values().filter(|(t, _)| *t != team).count();
                if mine.len() == 1 && enemies >= rules.min_clutch_enemies {
                    let (sid, (_, name)) = mine[0];
                    found = Some((*sid, team, name.clone(), enemies, k.tick));
                    break;
                }
            }
        }
        let Some((sid, team, name, enemies, t0)) = found else {
            continue;
        };
        if team != winner {
            continue;
        }
        let mine: Vec<&&Kill> = kills
            .iter()
            .filter(|k| k.round == rd.number && k.attacker_steamid == sid && k.tick > t0)
            .collect();
        let end = mine
            .last()
            .map(|k| k.tick)
            .or(rd.end_tick)
            .unwrap_or(t0)
            .max(t0);
        let (s, e) = cx.span(t0, end);
        let weapons: Vec<&str> = mine.iter().map(|k| k.weapon.as_str()).collect();
        out.push(Highlight {
            kind: HighlightKind::Clutch {
                enemies: enemies.min(5) as u8,
            },
            round: rd.number,
            steamid: sid,
            name,
            team,
            start_tick: s,
            end_tick: e,
            kill_ticks: mine.iter().map(|k| k.tick).collect(),
            score: rules.scores.clutch + rules.scores.clutch_per_enemy * enemies as i32,
            tags: vec![],
            weapon: most_common(&weapons),
            map: m.map.clone(),
        });
    }
    out
}

fn rank(k: HighlightKind) -> u8 {
    match k {
        HighlightKind::Clutch { .. } => 3,
        HighlightKind::Ace => 2,
        HighlightKind::MultiKill(_) => 1,
        _ => 0,
    }
}

/// Merge highlights of the same player and round that overlap (or nearly do)
/// into one clip: the higher-ranked kind wins and scores are added.
fn merge(mut hs: Vec<Highlight>, gap: u32) -> Vec<Highlight> {
    hs.sort_by_key(|h| (h.steamid, h.round, h.start_tick));
    let mut out: Vec<Highlight> = Vec::new();
    for h in hs {
        if let Some(last) = out.last_mut() {
            let same = last.steamid == h.steamid && last.round == h.round;
            let clutch_round = matches!(last.kind, HighlightKind::Clutch { .. })
                || matches!(h.kind, HighlightKind::Clutch { .. });
            if same && (clutch_round || h.start_tick <= last.end_tick + gap) {
                let keep_new = rank(h.kind) > rank(last.kind);
                let mut ticks = last.kill_ticks.clone();
                ticks.extend(&h.kill_ticks);
                ticks.sort();
                ticks.dedup();
                let mut tags = last.tags.clone();
                tags.extend(&h.tags);
                tags.sort();
                tags.dedup();
                let score = last.score + h.score;
                let (s, e) = (
                    last.start_tick.min(h.start_tick),
                    last.end_tick.max(h.end_tick),
                );
                if keep_new {
                    let w = if h.weapon.is_empty() {
                        last.weapon.clone()
                    } else {
                        h.weapon.clone()
                    };
                    *last = h;
                    last.weapon = w;
                } else if last.weapon.is_empty() {
                    last.weapon = h.weapon;
                }
                if let HighlightKind::MultiKill(_) = last.kind {
                    let n = ticks.len().min(5) as u8;
                    if n >= 2 {
                        last.kind = HighlightKind::MultiKill(n);
                    }
                }
                last.kill_ticks = ticks;
                last.tags = tags;
                last.score = score;
                last.start_tick = s;
                last.end_tick = e;
                continue;
            }
        }
        out.push(h);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{RosterEntry, Round};
    use crate::rules::Selectivity;

    const ME: u64 = 76561198000000001;

    fn kill(tick: u32, round: u32, att: u64, vic: u64) -> Kill {
        let team = |s: u64| {
            if s < 76561198000000100 {
                Team::CT
            } else {
                Team::T
            }
        };
        Kill {
            tick,
            round,
            attacker_steamid: att,
            attacker_name: format!("p{}", att % 1000),
            attacker_team: team(att),
            victim_steamid: vic,
            victim_name: format!("p{}", vic % 1000),
            victim_team: team(vic),
            weapon: "ak47".into(),
            ..Default::default()
        }
    }

    fn roster(round: u32) -> Vec<RosterEntry> {
        let mut v = Vec::new();
        for i in 1..=5u64 {
            v.push(RosterEntry {
                round,
                steamid: 76561198000000000 + i,
                name: format!("p{i}"),
                team: Team::CT,
            });
            v.push(RosterEntry {
                round,
                steamid: 76561198000000100 + i,
                name: format!("p{}", 100 + i),
                team: Team::T,
            });
        }
        v
    }

    fn base(kills: Vec<Kill>, winner: Team) -> MatchData {
        MatchData {
            map: "de_mirage".into(),
            tickrate: 64.0,
            total_ticks: 100_000,
            kills,
            rounds: vec![Round {
                number: 1,
                start_tick: 0,
                end_tick: Some(10_000),
                winner: Some(winner),
            }],
            roster: roster(1),
        }
    }

    fn low() -> Rules {
        Rules {
            selectivity: Selectivity::Low,
            detect_clutches: false,
            ..Rules::default()
        }
    }

    const T: u64 = 76561198000000100;

    #[test]
    fn detects_three_k() {
        let m = base(
            (1..=3)
                .map(|i| kill(1000 + i * 64, 1, ME, T + i as u64))
                .collect(),
            Team::CT,
        );
        let h = detect_highlights(&m, &low(), None);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kind, HighlightKind::MultiKill(3));
        assert_eq!(h[0].start_tick, 1064 - 256);
        assert_eq!(h[0].end_tick, 1192 + 128);
        assert_eq!(h[0].title(), "Mirage AK-47 3K");
    }

    #[test]
    fn detects_ace() {
        let m = base(
            (1..=5)
                .map(|i| kill(1000 + i * 300, 1, ME, T + i as u64))
                .collect(),
            Team::CT,
        );
        let h = detect_highlights(&m, &low(), None);
        assert_eq!(h[0].kind, HighlightKind::Ace);
        assert_eq!(h[0].kills(), 5);
    }

    #[test]
    fn window_splits_chains() {
        let mut r = low();
        r.multikill_window_s = 5.0;
        // two kills 1 s apart, then two more 20 s later
        let ticks = [1000, 1064, 2344, 2408];
        let m = base(
            ticks
                .iter()
                .enumerate()
                .map(|(i, &t)| kill(t, 1, ME, T + 1 + i as u64))
                .collect(),
            Team::CT,
        );
        let h = detect_highlights(&m, &r, None);
        assert_eq!(h.len(), 2);
        assert!(h.iter().all(|h| h.kind == HighlightKind::MultiKill(2)));
    }

    #[test]
    fn ignores_teamkills_and_suicides() {
        let m = base(
            vec![
                kill(1000, 1, ME, 76561198000000002),
                kill(1100, 1, ME, ME),
                kill(1200, 1, ME, T + 1),
            ],
            Team::CT,
        );
        assert!(detect_highlights(&m, &low(), None).is_empty());
    }

    #[test]
    fn detects_clutch_and_merges_multikill() {
        // T kill four CTs (everyone except ME), then ME kills 3 of the remaining 5 Ts... round won by CT.
        let mut ks: Vec<Kill> = (2..=5)
            .map(|i| kill(500 + i as u32 * 10, 1, T + 1, 76561198000000000 + i))
            .collect();
        for (i, v) in (1..=5u64).enumerate() {
            ks.push(kill(2000 + i as u32 * 200, 1, ME, T + v));
        }
        let m = base(ks, Team::CT);
        let r = Rules {
            selectivity: Selectivity::Low,
            ..Rules::default()
        };
        let h = detect_highlights(&m, &r, Some("p1"));
        assert_eq!(h.len(), 1, "{h:#?}");
        assert_eq!(h[0].kind, HighlightKind::Clutch { enemies: 5 });
        assert_eq!(h[0].kills(), 5);
        assert!(h[0].score >= r.scores.clutch + 5 * r.scores.clutch_per_enemy + r.scores.ace);
        assert_eq!(h[0].title(), "Mirage AK-47 1v5 5K Clutch");
    }

    #[test]
    fn lost_clutch_is_not_a_highlight() {
        let ks: Vec<Kill> = (2..=5)
            .map(|i| kill(500 + i as u32 * 10, 1, T + 1, 76561198000000000 + i))
            .collect();
        let m = base(ks, Team::T);
        let r = Rules {
            selectivity: Selectivity::Low,
            ..Rules::default()
        };
        assert!(detect_highlights(&m, &r, Some(&ME.to_string())).is_empty());
    }

    #[test]
    fn single_noscope_and_selectivity() {
        let mut k = kill(1000, 1, ME, T + 1);
        k.noscope = true;
        k.weapon = "awp".into();
        let m = base(vec![k], Team::CT);
        let h = detect_highlights(&m, &low(), None);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kind, HighlightKind::Noscope);
        let high = Rules {
            selectivity: Selectivity::High,
            ..low()
        };
        assert!(detect_highlights(&m, &high, None).is_empty());
    }

    #[test]
    fn weapon_bonus_applies() {
        let mut r = low();
        r.weapon_bonus.insert("knife".into(), 50);
        let mut ks: Vec<Kill> = (1..=2)
            .map(|i| kill(1000 + i * 64, 1, ME, T + i as u64))
            .collect();
        for k in &mut ks {
            k.weapon = "knife".into();
        }
        let h = detect_highlights(&base(ks, Team::CT), &r, None);
        assert_eq!(h[0].score, r.scores.k2 + 50);
    }
}
