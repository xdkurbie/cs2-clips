# CS2 Clips

Lokal, gratis app som finner høydepunkter i CS2-demoer og tar dem opp – inspirert av skybaserte klippetjenester, men alt kjører på din egen PC. *(English below.)*

## Hva den gjør / What it does
- Finds `.dem` files in your CS2 `replays` folder (auto-detected, configurable) or via file picker / drag-drop.
- Parses with [demoparser2](https://github.com/LaihoE/demoparser) and detects 2k–5k, aces, clutches (1vX), wallbangs, noscopes, (optional) headshots.
- Rules in JSON/YAML – see `rules.example.yaml`.
- Default player: Steam name **rasu420** (case-insensitive). The first time it's found in a demo the SteamID is saved to `%APPDATA%\cs2-clips\settings.json` and used from then on. Both are editable.
- Recording: launches CS2 with `-insecure` (VAC off, cannot join secure servers) and a generated `cs2clips_rec.cfg` (`playdemo`, `demo_gototick`, `spec_player`), then records with ffmpeg `gdigrab` or OBS (obs-websocket v5).
- Montage: ffmpeg `xfade` transitions, optional music with ducking, optional slow-mo.

## Safety
Demo playback only. No injection, no HLAE, no memory reading. The app refuses to record if CS2 is already running and only launches with `-insecure`. Close CS2 normally before playing online again.

## Run from source
```
pip install -r requirements.txt
python run_app.py            # GUI
python -m cs2clips.cli my.dem --player rasu420
python -m pytest
```
Needs ffmpeg in PATH for recording/montage. MIT license.
