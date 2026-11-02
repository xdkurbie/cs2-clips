import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { highlightsFor } from "./highlights.js";
import { buildBlockout } from "../../shared/blockout.js";

async function pruneEphemeral(dataDir) {
  const ephemeral = dataDir.startsWith("/tmp") || dataDir.startsWith(os.tmpdir());
  if (!ephemeral) return;
  const index = JSON.parse(await fs.readFile(path.join(dataDir, "index.json"), "utf8").catch(() => "{\"matches\":[]}"));
  const keep = new Set((index.matches || []).slice(0, 6).map((m) => m.id));
  const names = await fs.readdir(dataDir).catch(() => []);
  for (const name of names) {
    if (!/^[a-f0-9]{16}$/.test(name) || keep.has(name)) continue;
    await fs.rm(path.join(dataDir, name), { recursive: true, force: true });
  }
  if ((index.matches || []).length > 6) {
    index.matches = index.matches.filter((m) => keep.has(m.id));
    const file = path.join(dataDir, "index.json");
    await fs.writeFile(file, JSON.stringify(index));
  }
}

export function createStore(dataDir, parserScript) {
  const python = process.env.PYTHON || "python3";

  async function ensure() {
    await fs.mkdir(dataDir, { recursive: true });
  }

  function matchDir(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) {
      const err = new Error("not_found");
      err.code = "not_found";
      throw err;
    }
    return path.join(dataDir, id);
  }

  async function readIndex() {
    try {
      return JSON.parse(await fs.readFile(path.join(dataDir, "index.json"), "utf8"));
    } catch {
      return { matches: [] };
    }
  }

  async function writeIndex(index) {
    const file = path.join(dataDir, "index.json");
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(index));
    await fs.rename(tmp, file);
  }

  function runParser(dem, out, roundsDir, points) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, [parserScript, dem, "--out", out, "--rounds", roundsDir, "--points", points, "--interval", "2"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => {
        err += d.toString();
        if (err.length > 4000) err = err.slice(-4000);
      });
      child.on("error", () => reject(Object.assign(new Error("parse_failed"), { code: "parse_failed" })));
      child.on("close", (code) => {
        if (code === 0) resolve(err.trim().split("\n").pop() || "");
        else reject(Object.assign(new Error(code === 2 ? "bad_demo" : "parse_failed"), { code: code === 2 ? "bad_demo" : "parse_failed" }));
      });
    });
  }

  return {
    async list() {
      await ensure();
      return readIndex();
    },
    async get(id) {
      const meta = JSON.parse(await fs.readFile(path.join(matchDir(id), "meta.json"), "utf8"));
      return meta;
    },
    async timeline(id) {
      return JSON.parse(await fs.readFile(path.join(matchDir(id), "timeline.json"), "utf8"));
    },
    roundFile(id, n) {
      const num = Number(n);
      if (!Number.isInteger(num) || num < 1 || num > 60) {
        const err = new Error("not_found");
        err.code = "not_found";
        throw err;
      }
      return path.join(matchDir(id), "rounds", `r${num}.bin`);
    },
    blockoutFile(id) {
      return path.join(matchDir(id), "blockout.json");
    },
    async highlights(id, steamid) {
      const file = path.join(matchDir(id), "highlights.json");
      const all = JSON.parse(await fs.readFile(file, "utf8"));
      return steamid ? all.filter((h) => h.steamid === steamid) : all;
    },
    async createFromDemo(demPath, { steamid } = {}) {
      await ensure();
      const id = crypto.randomBytes(8).toString("hex");
      const dir = path.join(dataDir, id);
      await fs.mkdir(dir);
      const out = path.join(dir, "timeline.json");
      const roundsDir = path.join(dir, "rounds");
      const points = path.join(dir, "points.bin");
      await fs.mkdir(roundsDir);
      try {
        await runParser(demPath, out, roundsDir, points);
        const timeline = JSON.parse(await fs.readFile(out, "utf8"));
        const scale = timeline.scale || 1;
        const raw = await fs.readFile(points).catch(() => Buffer.alloc(0));
        const copy = new ArrayBuffer(raw.byteLength);
        new Uint8Array(copy).set(raw);
        const i16 = new Int16Array(copy);
        const pts = [];
        for (let i = 0; i + 2 < i16.length; i += 3) {
          pts.push({ x: i16[i] * scale, y: i16[i + 1] * scale, z: i16[i + 2] * scale });
        }
        const blockout = buildBlockout(pts);
        await fs.writeFile(path.join(dir, "blockout.json"), JSON.stringify(blockout));
        await fs.rm(points, { force: true });
        const highlights = highlightsFor(timeline, null);
        await fs.writeFile(path.join(dir, "highlights.json"), JSON.stringify(highlights));
        const stat = await fs.stat(demPath).catch(() => ({ size: 0 }));
        const meta = {
          id,
          map: timeline.map,
          created: new Date().toISOString(),
          tickrate: timeline.tickrate,
          totalTicks: timeline.totalTicks,
          interval: timeline.interval,
          players: timeline.players,
          roundCount: timeline.rounds.length,
          killCount: timeline.kills.length,
          highlightCount: highlights.length,
          bytes: stat.size,
          focus: /^\d{17}$/.test(steamid || "") ? steamid : "",
        };
        await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
        const index = await readIndex();
        index.matches.unshift({
          id,
          map: meta.map,
          created: meta.created,
          roundCount: meta.roundCount,
          killCount: meta.killCount,
          players: meta.players.map((p) => p.name),
        });
        index.matches = index.matches.slice(0, 50);
        await writeIndex(index);
        await pruneEphemeral(dataDir);
        return { meta, highlights };
      } catch (err) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    },
  };
}
