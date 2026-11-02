import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { decode, isValid } from "./sharecode.js";
import { SteamError, walkMatches } from "./steam.js";
import { createStore } from "./matches.js";
import { fetchDemoForCode, gcStatus, startGcWorker } from "./gcWorker.js";
import { clientError, redact } from "./redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../..");
const dataDir = process.env.DATA_DIR || path.join(webRoot, "data");
const parserScript = process.env.PARSER || path.join(webRoot, "parser/parse_demo.py");
const frontend = process.env.FRONTEND_DIST || path.join(webRoot, "frontend/dist");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

const store = createStore(dataDir, parserScript);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, gc: gcStatus() });
});

app.get("/api/gc/status", (_req, res) => {
  res.json(gcStatus());
});

app.post("/api/sharecode/decode", (req, res) => {
  try {
    const code = String(req.body?.code || "");
    if (!isValid(code)) return clientError(res, 400, "bad_share_code");
    res.json(decode(code));
  } catch {
    clientError(res, 400, "bad_share_code");
  }
});

app.post("/api/steam/matches", async (req, res) => {
  const apiKey = process.env.STEAM_WEB_API_KEY || "";
  try {
    const matches = await walkMatches({
      apiKey,
      steamid64: req.body?.steamid64,
      authCode: req.body?.authCode,
      knownCode: req.body?.knownCode,
      limit: req.body?.limit,
      http: async (url) => {
        const response = await fetch(url);
        const body = await response.text();
        return { status: response.status, body };
      },
    });
    res.json({
      matches: matches.map((m) => ({
        code: m.code,
        matchId: m.matchId,
        outcomeId: m.outcomeId,
        token: m.token,
      })),
    });
  } catch (err) {
    const code = err instanceof SteamError ? err.code : "steam_failed";
    const status = code === "rate_limited" ? 429 : code === "forbidden" || code === "unknown_code" ? 400 : 400;
    if (code === "steam_failed") console.error(redact(err?.message || "steam"));
    clientError(res, status, code);
  }
});

app.get("/api/matches", async (_req, res) => {
  res.json(await store.list());
});

app.get("/api/matches/:id", async (req, res) => {
  try {
    res.json(await store.get(req.params.id));
  } catch {
    clientError(res, 404, "not_found");
  }
});

app.get("/api/matches/:id/timeline", async (req, res) => {
  try {
    res.json(await store.timeline(req.params.id));
  } catch {
    clientError(res, 404, "not_found");
  }
});

app.get("/api/matches/:id/blockout", (req, res) => {
  let file;
  try {
    file = store.blockoutFile(req.params.id);
  } catch {
    return clientError(res, 404, "not_found");
  }
  if (!fs.existsSync(file)) return clientError(res, 404, "not_found");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(file);
});

app.get("/api/matches/:id/rounds/:n", (req, res) => {
  let file;
  try {
    file = store.roundFile(req.params.id, req.params.n);
  } catch {
    return clientError(res, 404, "not_found");
  }
  if (!fs.existsSync(file)) return clientError(res, 404, "not_found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(file).pipe(res);
});

app.get("/api/matches/:id/highlights", async (req, res) => {
  try {
    const steamid = /^\d{17}$/.test(req.query.steamid || "") ? String(req.query.steamid) : "";
    res.json({ highlights: await store.highlights(req.params.id, steamid) });
  } catch {
    clientError(res, 404, "not_found");
  }
});

function acceptDemo(name) {
  const lower = String(name || "").toLowerCase();
  return lower.endsWith(".dem") || lower.endsWith(".dem.bz2") || lower.endsWith(".bz2");
}

async function saveUpload(req) {
  const tmp = path.join(os.tmpdir(), `cs2clips-${crypto.randomBytes(8).toString("hex")}`);
  await fsp.mkdir(tmp, { recursive: true });
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 400 * 1024 * 1024, fields: 8, fieldSize: 256 },
    });
    const fields = {};
    let filePath = "";
    let tooBig = false;
    let pending = null;
    bb.on("field", (name, val) => {
      if (name === "steamid" || name === "shareCode") fields[name] = String(val).slice(0, 64);
    });
    bb.on("file", (name, stream, info) => {
      if (name !== "demo" || !acceptDemo(info.filename)) {
        stream.resume();
        return;
      }
      filePath = path.join(tmp, "upload.dem");
      const out = fs.createWriteStream(filePath);
      stream.pipe(out);
      stream.on("limit", () => {
        tooBig = true;
      });
      pending = new Promise((res, rej) => {
        out.on("finish", res);
        out.on("error", rej);
      });
    });
    bb.on("error", reject);
    bb.on("finish", async () => {
      try {
        if (pending) await pending;
        if (tooBig) {
          reject(Object.assign(new Error("too_large"), { code: "too_large" }));
          return;
        }
        resolve({ fields, filePath, tmp });
      } catch (err) {
        reject(err);
      }
    });
    req.pipe(bb);
  });
}

app.post("/api/matches/upload", async (req, res) => {
  let saved;
  try {
    saved = await saveUpload(req);
    if (!saved.filePath) return clientError(res, 400, "bad_demo");
    const { meta, highlights } = await store.createFromDemo(saved.filePath, { steamid: saved.fields.steamid });
    res.json({ match: meta, highlights });
  } catch (err) {
    const code = err?.code === "bad_demo" || err?.code === "too_large" || err?.code === "parse_failed" ? err.code : "parse_failed";
    clientError(res, code === "too_large" ? 413 : 400, code);
  } finally {
    if (saved?.tmp) await fsp.rm(saved.tmp, { recursive: true, force: true }).catch(() => {});
  }
});

app.post("/api/steam/demo", async (req, res) => {
  const code = String(req.body?.shareCode || "").trim();
  if (!isValid(code)) return clientError(res, 400, "bad_share_code");
  const tmp = path.join(os.tmpdir(), `cs2clips-${crypto.randomBytes(8).toString("hex")}.dem.bz2`);
  try {
    await fetchDemoForCode(code, tmp);
    const { meta, highlights } = await store.createFromDemo(tmp, { steamid: req.body?.steamid64 });
    res.json({ match: meta, highlights });
  } catch (err) {
    const codeName = err?.code || "unavailable";
    const known = ["gc_unconfigured", "gc_unavailable", "gc_timeout", "expired", "unavailable", "bad_demo", "parse_failed"];
    clientError(res, known.includes(codeName) ? 400 : 502, known.includes(codeName) ? codeName : "unavailable");
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

app.post("/api/mux", express.raw({ type: ["video/webm", "application/octet-stream"], limit: "80mb" }), async (req, res) => {
  const { spawn } = await import("node:child_process");
  const id = crypto.randomBytes(6).toString("hex");
  const input = path.join(os.tmpdir(), `${id}.webm`);
  const output = path.join(os.tmpdir(), `${id}.mp4`);
  try {
    await fsp.writeFile(input, req.body);
    await new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", ["-y", "-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", output], {
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg"))));
    });
    res.setHeader("Content-Type", "video/mp4");
    res.send(await fsp.readFile(output));
  } catch {
    clientError(res, 400, "mux_failed");
  } finally {
    await fsp.rm(input, { force: true }).catch(() => {});
    await fsp.rm(output, { force: true }).catch(() => {});
  }
});

if (fs.existsSync(path.join(frontend, "index.html"))) {
  app.use(express.static(frontend, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(frontend, "index.html"), (err) => err && next());
  });
}

startGcWorker();
app.listen(port, host, () => {
  console.log(`cs2clips listening on ${host}:${port}`);
});
