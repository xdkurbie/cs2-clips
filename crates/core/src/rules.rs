//! Configurable highlight rules (JSON or YAML). Unknown keys are rejected so
//! typos do not silently fall back to defaults.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Scores {
    pub k2: i32,
    pub k3: i32,
    pub k4: i32,
    pub k5: i32,
    pub ace: i32,
    pub clutch: i32,
    pub clutch_per_enemy: i32,
    pub headshot: i32,
    pub wallbang: i32,
    pub noscope: i32,
    pub through_smoke: i32,
    pub blind: i32,
    /// Bonus per second saved compared to the multikill window (fast chains score higher).
    pub speed_bonus_per_s: i32,
}

impl Default for Scores {
    fn default() -> Self {
        Self {
            k2: 20,
            k3: 40,
            k4: 70,
            k5: 100,
            ace: 110,
            clutch: 30,
            clutch_per_enemy: 15,
            headshot: 3,
            wallbang: 15,
            noscope: 20,
            through_smoke: 10,
            blind: 10,
            speed_bonus_per_s: 2,
        }
    }
}

impl Scores {
    pub fn multikill(&self, n: usize) -> i32 {
        match n {
            0 | 1 => 0,
            2 => self.k2,
            3 => self.k3,
            4 => self.k4,
            _ => self.k5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Selectivity {
    Low,
    #[default]
    Medium,
    High,
    /// Use `min_score` as-is.
    Custom,
}

impl Selectivity {
    pub fn min_score(self) -> Option<i32> {
        match self {
            Selectivity::Low => Some(0),
            Selectivity::Medium => Some(20),
            Selectivity::High => Some(60),
            Selectivity::Custom => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Rules {
    /// 0 = all kills in a round count; > 0 = kills must chain within this many seconds.
    pub multikill_window_s: f32,
    pub min_multikill: usize,
    pub detect_clutches: bool,
    pub min_clutch_enemies: usize,
    pub detect_headshots: bool,
    pub detect_wallbangs: bool,
    pub detect_noscopes: bool,
    pub detect_smoke_kills: bool,
    pub pre_roll_s: f32,
    pub post_roll_s: f32,
    pub selectivity: Selectivity,
    pub min_score: i32,
    /// Fallback when the demo does not report a tick rate.
    pub tickrate: f32,
    /// Merge highlights of the same player that overlap or are closer than this.
    pub merge_gap_s: f32,
    pub scores: Scores,
    /// Extra per-weapon score adjustments, e.g. `{ "knife": 40, "awp": -5 }`.
    pub weapon_bonus: BTreeMap<String, i32>,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            multikill_window_s: 0.0,
            min_multikill: 2,
            detect_clutches: true,
            min_clutch_enemies: 1,
            detect_headshots: false,
            detect_wallbangs: true,
            detect_noscopes: true,
            detect_smoke_kills: true,
            pre_roll_s: 4.0,
            post_roll_s: 2.0,
            selectivity: Selectivity::Medium,
            min_score: 20,
            tickrate: 64.0,
            merge_gap_s: 1.0,
            scores: Scores::default(),
            weapon_bonus: BTreeMap::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RulesError {
    #[error("invalid rule: {0}")]
    Invalid(String),
    #[error("could not read rules: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not parse rules: {0}")]
    Parse(String),
}

impl Rules {
    pub fn validate(&self) -> Result<(), RulesError> {
        let bad = |m: &str| Err(RulesError::Invalid(m.into()));
        if !(2..=5).contains(&self.min_multikill) {
            return bad("min_multikill must be 2..=5");
        }
        if !(1..=5).contains(&self.min_clutch_enemies) {
            return bad("min_clutch_enemies must be 1..=5");
        }
        if self.multikill_window_s < 0.0
            || self.pre_roll_s < 0.0
            || self.post_roll_s < 0.0
            || self.merge_gap_s < 0.0
        {
            return bad("time values must be >= 0");
        }
        if self.tickrate <= 0.0 {
            return bad("tickrate must be > 0");
        }
        Ok(())
    }

    pub fn effective_min_score(&self) -> i32 {
        self.selectivity.min_score().unwrap_or(self.min_score)
    }

    pub fn from_yaml(s: &str) -> Result<Self, RulesError> {
        let r: Rules = serde_yaml::from_str(s).map_err(|e| RulesError::Parse(e.to_string()))?;
        r.validate()?;
        Ok(r)
    }

    pub fn from_json(s: &str) -> Result<Self, RulesError> {
        let r: Rules = serde_json::from_str(s).map_err(|e| RulesError::Parse(e.to_string()))?;
        r.validate()?;
        Ok(r)
    }

    pub fn load(path: &Path) -> Result<Self, RulesError> {
        let text = std::fs::read_to_string(path)?;
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("yml" | "yaml") => Self::from_yaml(&text),
            _ => Self::from_json(&text),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), RulesError> {
        let s = match path.extension().and_then(|e| e.to_str()) {
            Some("yml" | "yaml") => {
                serde_yaml::to_string(self).map_err(|e| RulesError::Parse(e.to_string()))?
            }
            _ => {
                serde_json::to_string_pretty(self).map_err(|e| RulesError::Parse(e.to_string()))?
            }
        };
        std::fs::write(path, s)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_partial_overrides() {
        let r =
            Rules::from_yaml("min_multikill: 3\nscores: {ace: 150}\nselectivity: high\n").unwrap();
        assert_eq!(r.min_multikill, 3);
        assert_eq!(r.scores.ace, 150);
        assert_eq!(r.scores.k2, 20);
        assert_eq!(r.effective_min_score(), 60);
    }

    #[test]
    fn rejects_unknown_and_invalid() {
        assert!(Rules::from_yaml("min_multikil: 3").is_err());
        assert!(Rules::from_yaml("min_multikill: 7").is_err());
        assert!(Rules::from_json(r#"{"pre_roll_s": -1}"#).is_err());
    }
}

#[cfg(test)]
mod example_file {
    #[test]
    fn example_rules_file_is_valid() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../rules.example.yaml");
        super::Rules::load(std::path::Path::new(p)).unwrap();
    }
}
