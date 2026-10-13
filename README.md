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

## Automatisk nedlasting av kamper (norsk)
1. Lag en Steam Web API-nøkkel: <https://steamcommunity.com/dev/apikey>.
2. Finn SteamID64 (17 sifre, f.eks. via profil-URL eller steamid.io).
3. Gå til Steam-hjelp → *Access to your match history* (<https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128>) og lag en **Game Authentication Code**. Der står også din **siste delingskode** (CSGO-xxxxx-…).
4. I appen: **Steam…** → lim inn alle fire → OK. De lagres kun lokalt, kryptert med Windows DPAPI (bare din Windows-bruker kan lese dem). Feltene vises maskert og skrives aldri til logg.
5. **Hent nye kamper** går gjennom nye delingskoder via Steams offisielle API og lagrer fremdriften.
6. **Begrensning:** Delingskoden sier ikke hvor demoen ligger. Det får bare Game Coordinator vite (krever innlogget Steam-konto). Appen spør deg derfor om **demo-URL** for hver kamp (f.eks. fra CS2 → *Se på* → kamp, eller fra Leetify/csstats). Du kan også bruke **Lim inn demo-URL** direkte. Demoen lastes ned, pakkes ut i replays-mappa og analyseres automatisk.
7. Eksperimentelt: `GameCoordinatorResolver` (pip `steam[client] csgo`) kan prøve å hente URL-en selv, med interaktiv innlogging (passord lagres aldri). Bibliotekene er laget for CS:GO og er ikke testet mot CS2 – ikke koblet inn i GUI-en ennå.

## Automatic match download (English)
1. Get a Steam Web API key: <https://steamcommunity.com/dev/apikey>.
2. Find your SteamID64 (17 digits).
3. Steam Help → *Access to your match history*: create a **Game Authentication Code**; the page also shows your **latest share code**.
4. In the app: **Steam…** → paste all four → OK. Stored locally only, encrypted with Windows DPAPI (current user). On non-Windows the OS keyring is used, or the app refuses. Masked in the UI, never logged.
5. **Fetch new matches** walks new share codes via the official `ICSGOPlayers_730/GetNextMatchSharingCode/v1` and saves progress after each handled match.
6. **Limitation:** a share code doesn't contain the demo location; only the Game Coordinator (logged-in Steam account) knows it. The app therefore asks you to paste the **demo URL** per match (or use **Paste demo URL**). It then downloads the `.dem.bz2`, decompresses into the replays folder and runs highlight detection.
7. Experimental: `GameCoordinatorResolver` (needs `steam[client]` + `csgo`) tries to resolve URLs via the GC with an interactive login, no stored password. These libraries target CS:GO and are untested with CS2; not wired into the GUI yet.
