# Allstar.gg – high-level study (public info only)

Sources (read 2026-10-13, passive reading only): allstar.gg/howitworks, allstar.gg/feature/autocapture,
help.allstar.gg ("How does Allstar work?", "Match History FAQ"), and the public description of the Partner API
(`POST /api/clip_request`, webhook events). No code, assets, names or branding are reused.

## How Allstar works
- **Cloud, not local recording.** The user links a Steam account / share codes. After a match, Allstar fetches the
  Valve (or FACEIT/GamersClub) demo, and renders clips on its own servers by replaying the demo in the game engine.
  Nothing runs on the player's PC, so no FPS cost. Missing demos can be uploaded manually.
- **Moment scoring.** Every event (kills, multi-frags, clutches, defuses) is scored; the highest-scoring moments are
  clipped. A user "selectivity" setting is a score threshold.
- **Render settings.** HUD elements (killfeed, radar, money, crosshair), resolution up to 4K, up to 120 fps,
  motion blur levels.
- **Editing.** Effects, automatic music/FX syncing, montages ("Studio"), share to Discord/TikTok/YouTube.
- **API model.** Request = demo URL + SteamID + rounds + use case (single highlight, multi highlight, play of the
  game, ...); async processing with `submitted/processed/errored` webhooks.

## What we take as *ideas* (original implementation)
| Allstar concept | cs2-clips (local, offline) |
|---|---|
| Cloud demo fetch | User's local `replays` folder / drag-drop .dem |
| Server-side render | Local CS2 in **offline demo playback** (`playdemo`, `demo_gototick`, `spec_player`) + OBS websocket v5 or ffmpeg gdigrab |
| Moment scoring + selectivity | Rule-based detector (JSON/YAML), score per highlight, `min_score` |
| HUD options | cfg cvars (`cl_draw_only_deathnotices`, `demoui` hidden, etc.) |
| Montage studio | ffmpeg `xfade` + music `amix`/sidechain ducking + optional slow-mo |

## Differences / constraints
- Runs locally, free, open source (MIT); quality depends on user's PC.
- Never touches online/VAC sessions, no injection (no HLAE), only drives CS2's own demo player via a generated cfg.
