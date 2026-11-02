# CS2 Clips — web

Watch a full CS2 demo in the browser, list highlights for a SteamID, export a clip, and cut a short montage. The desktop Rust app in `crates/` is unchanged. This folder does not deploy to the owner's GitHub Pages site (`site/`).

The 3D view is an original stylized blockout. Floors sit on the height players actually stood at, including multiple levels, with a clipping plane for the lower floor. It is not Valve geometry, radar art, or ripped models. Player markers, cones, smokes and fire are original meshes.

## One command

From `web/`, after `cp .env.example .env` (the file can stay empty for manual uploads):

```bash
npm install
npm run dev
```

- UI: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

`npm test` runs the unit tests. Set `CS2CLIPS_TEST_DEMO` to a `.dem` path to also parse a real demo.

Production, API and UI on one port:

```bash
npm start
```

Or:

```bash
docker compose up --build
```

That serves http://127.0.0.1:8787.

## What works without secrets

1. Drop a `.dem` or `.dem.bz2` on the home page.
2. The API parses it (demoparser2, 32 Hz per round) and builds the blockout.
3. Open the match: round chips, 2D / free / follow / first-person, kill feed, score, economy, utility, scrubber.
4. Highlights for a SteamID: entries, 2K–5K, aces, clutches, headshot streaks.
5. Export a clip (WebCodecs MP4, or webm remuxed with ffmpeg).
6. Add two clips to the montage, pick cut / crossfade / whip, a look, text, optional music, and export.

Share links look like `#/m/<id>?round=3&tick=12000&mode=follow`.

Auth codes typed into the Steam form stay in `sessionStorage` for that tab. They are not written to disk and not logged. The API log line is only method, path and status.

## Credentials the owner must provide

Nothing is required to parse an uploaded demo.

| Variable | Why |
|---|---|
| `STEAM_WEB_API_KEY` | 32-character key from https://steamcommunity.com/dev/apikey. Server-side only. Walks `ICSGOPlayers_730/GetNextMatchSharingCode/v1`. |
| SteamID64, auth code `XXXX-XXXXX-XXXX`, known share code | Typed by the user in the UI. The auth code is the one from Steam Help → Access to your match history. It is not an env var. |
| `STEAM_BOT_REFRESH_TOKEN` | Preferred. A dedicated bot account that can open CS2. Mint it locally with `STEAM_BOT_USERNAME` and `STEAM_BOT_PASSWORD` set, then `npm run bot-login`. Paste the printed token into `.env` and unset the password. |
| `STEAM_BOT_USERNAME` / `STEAM_BOT_PASSWORD` | Used only if you do not have a refresh token yet. |
| `STEAM_BOT_SHARED_SECRET` | Optional base64 Steam Guard shared secret so an unattended login can complete. Leave empty and use the refresh token instead. |

Valve deletes replay files after a few weeks. If the Game Coordinator has no URL, or the replay host returns 404, the API responds with `expired` and the UI asks for a manual `.dem`. The bot path is implemented and covered with mocked match payloads; it has not been logged in against a live Steam account in this environment.

## Deploy

**Render (recommended, one service).** `render.yaml` builds the Dockerfile, binds `0.0.0.0:$PORT`, and mounts `/data` for parsed matches. Set the env vars above in the dashboard. Do not put user auth codes there.

**Vercel (frontend only).** `frontend/vercel.json` is a static SPA. Set `VITE_API_URL` only if you later point fetches at another host; the current UI uses same-origin `/api`. For a split deploy, set `CORS_ORIGIN` on the API to the Vercel origin. The parser and the Game Coordinator have to stay on the Render service, because Vercel serverless will not hold a Steam bot session.

Demos and timelines live on the disk. Render's filesystem is ephemeral without that disk.

## Layout

```
web/
  parser/parse_demo.py    demoparser2 → per-round CS2R files + a point cloud
  shared/blockout.js      original multi-floor blockout
  backend/                Express API, Steam walker, GC worker
  frontend/               Vite + three.js replay
```

A round file is `CS2R`, a version, a JSON header, then a gzip body of quantized positions (int16) and angles (uint8) at 32 Hz. The browser decodes it in a worker with `DecompressionStream` and prefetches the next round. Playback lerps positions and takes the shortest yaw arc. The service worker keeps the four most recent matches.

## Tests

```bash
npm test
CS2CLIPS_TEST_DEMO=/path/to/demo.dem npm test
```

Share codes, the Steam walker, GC URL building (including expired 404s), highlights and the blockout are unit-tested without network. The public demo test checks de_mirage, 10 players and 73 kills.

## Audio

Clip and montage export can mix an original soft tone and a noise whoosh, both synthesized in the browser and released CC0. You can also upload your own music. No commercial or Valve audio is included.

## Not in this build

- Live Game Coordinator login (needs the bot credentials above).
- Volumetric smoke. v1 smokes are shaded spheres with a countdown arc.
- Skeletal player models. Avatars are instanced capsules, heads and view cones.
