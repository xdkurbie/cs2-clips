//! Core library for CS2 Clips: everything that does not need a window.
//!
//! * [`sharecode`]: encode/decode `CSGO-xxxxx-...` match share codes.
//! * [`steam`]: walk match history with the official Steam Web API.
//! * [`download`]: fetch and decompress `.dem.bz2` replays.
//! * [`demo`]: turn a CS2 demo into a [`model::MatchData`] (kills, rounds, rosters).
//! * [`detect`]: rule-based highlight detection with scoring.
//! * [`plan`]: clip plans/timelines and CS2 playback configs.
//! * [`montage`]: ffmpeg command builders for recording and montages.
//! * [`config`]: persistent settings.

pub mod config;
#[cfg(feature = "parser")]
pub mod demo;
pub mod detect;
pub mod download;
pub mod model;
pub mod montage;
pub mod plan;
pub mod record;
pub mod rules;
pub mod sharecode;
#[cfg(feature = "net")]
pub mod steam;

pub use detect::{detect_highlights, Highlight, HighlightKind};
pub use model::{Kill, MatchData, RosterEntry, Round, Team};
pub use rules::Rules;
