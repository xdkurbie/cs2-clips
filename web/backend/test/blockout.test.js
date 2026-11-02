import test from "node:test";
import assert from "node:assert/strict";
import { buildBlockout } from "../../shared/blockout.js";

test("blockout keeps two floor heights and emits walls", () => {
  const pts = [];
  for (let x = 0; x < 220; x += 18) {
    for (let y = 0; y < 80; y += 18) pts.push({ x, y, z: 0 });
    for (let y = 240; y < 340; y += 18) pts.push({ x, y, z: 128 });
  }
  const built = buildBlockout(pts, { cell: 40, zBin: 16 });
  const heights = [...new Set(built.floors.map((f) => f.z))].sort((a, b) => a - b);
  assert.ok(heights.some((z) => Math.abs(z) <= 16), "low floor");
  assert.ok(heights.some((z) => Math.abs(z - 128) <= 16), "high floor");
  assert.ok(built.walls.length > 0);
  assert.ok(built.bounds.maxZ >= 128);
});
