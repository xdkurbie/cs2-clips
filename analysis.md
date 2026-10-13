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

## Passive web inspection findings (REA, 2026-10-13)
Method: headless Chrome on the box, REA `inspect_web_page` (passive CDP: DOM, accessibility tree, resource list; no JS
evaluation, no clicks, no login). Pages: `/`, `/start`, `/feature/autocapture`, `/add-share-codes` (redirects to
`/login?next=/add-share-codes`). No private API calls were made and no code/assets were saved.

- **Share codes / auth code:** the share-code page is behind login (redirect to `/login`), so the actual form wasn't
  visible. Public help text says the user adds their share codes / auth code at `allstar.gg/add-share-codes` after
  linking one Steam account; matches then load automatically. The Autocapture page says "connect your Steam account,
  one link, one time", and they "read the demo once the match ends". This is consistent with Valve's public
  share-code API + GC demo lookup done server-side. Only one Steam account per profile.
- **Login/onboarding:** sign-in via Steam / Discord / FACEIT / Riot / Battle.net or email. Marketing → "Try it for
  free" → "Find My Matches" is the main funnel; a consent (CMP) modal shows first.
- **Demo fetching:** no network calls to other hosts were seen on public pages (only allstar.gg resources); demo fetch
  and rendering happen entirely server-side.
- **Highlight presentation:** clip titles combine map + weapon + situation, e.g. "Dust 2 Galil AR 1V2 4K Clutch";
  chips like "4 KILLS", "1V2 CLUTCH", "ALL HEADSHOTS". Feed sections: "For You", "Today in Counter-Strike", "Recent
  Montages"; competitions such as a "No-Scope Challenge".
- **Settings concepts:** selectivity (how picky autocapture is), HUD toggles, resolution/fps/motion blur, music genres.

### UX ideas applied to cs2-clips (own implementation)
1. **Descriptive titles + chips:** highlights get a title like "Mirage AK-47 1v2 3K Clutch" and tag chips
   ("3 KILLS", "1V2 CLUTCH", "ALL HS"). A multikill inside a won clutch is merged into one highlight.
2. **Selectivity preset** (low / medium / high → `min_score`) instead of only a raw number.
3. **First-run onboarding checklist** in the GUI: 1) your player name, 2) replays folder, 3) optional Steam match
   download with direct links to the API-key and match-history help pages.
