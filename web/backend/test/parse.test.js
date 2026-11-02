import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectHighlights } from "../src/highlights.js";

const demo = process.env.CS2CLIPS_TEST_DEMO;
const parser = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../parser/parse_demo.py");

test("parses the public CS2 demo into per-round files", { skip: !demo, timeout: 120000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs2clips-"));
  const out = path.join(dir, "timeline.json");
  const rounds = path.join(dir, "rounds");
  const points = path.join(dir, "points.bin");
  await fs.mkdir(rounds);
  const code = await new Promise((resolve, reject) => {
    const child = spawn("python3", [parser, demo, "--out", out, "--rounds", rounds, "--points", points, "--interval", "2"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (c) => resolve({ c, err }));
  });
  assert.equal(code.c, 0, code.err);
  const timeline = JSON.parse(await fs.readFile(out, "utf8"));
  assert.equal(timeline.map, "de_mirage");
  assert.equal(timeline.players.length, 10);
  assert.equal(timeline.kills.length, 73);
  assert.ok(timeline.rounds.length >= 9);
  assert.equal(timeline.framerate, 32);
  const files = await fs.readdir(rounds);
  assert.ok(files.some((f) => f.endsWith(".bin")));
  const sample = await fs.readFile(path.join(rounds, "r1.bin"));
  assert.equal(sample.subarray(0, 4).toString(), "CS2R");
  const highs = detectHighlights(timeline);
  assert.ok(highs.some((h) => h.kind === "entry" || h.kind === "multikill" || h.kind === "ace"));
  const cloud = await fs.stat(points);
  assert.ok(cloud.size > 1000);
});
