import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { kv3Object, kv3V5Flag, sampleVpk, triangleResource, triangleVbib } from "./fixture.js";
import { readKv3 } from "./kv3.js";
import { lz4Block } from "./lz4.js";
import { parseResource } from "./resource.js";
import { entryLocation, readVpkHeader, readVpkTree } from "./vpk.js";
import { readVbib, attribute, indexArray } from "./vbib.js";
import { meshesFromResource } from "./geometry.js";
import { scenePlacements, worldPrefixes } from "./interpret.js";

test("lz4 block round trip of a short literal", () => {
  const output = new Uint8Array(2);
  const written = lz4Block(new Uint8Array([0x20, 104, 105]), output);
  assert.equal(written, 2);
  assert.equal(new TextDecoder().decode(output), "hi");
});

test("kv3 v1 reads an object", async () => {
  const doc = await readKv3(kv3Object("m_name", "tri"));
  assert.equal(doc.m_name, "tri");
});

test("kv3 v5 reads the current CS2 container shape", async () => {
  const doc = await readKv3(kv3V5Flag());
  assert.equal(doc.a, 1);
});

test("vpk directory round trip does not need a game install", () => {
  const payload = new TextEncoder().encode("triangle");
  const bytes = sampleVpk(payload);
  const header = readVpkHeader(bytes);
  const entries = readVpkTree(bytes, header);
  const entry = entries.get("models/tri.vmdl_c");
  assert.ok(entry);
  const loc = entryLocation(header, entry);
  assert.equal(new TextDecoder().decode(bytes.subarray(loc.offset, loc.offset + loc.length)), "triangle");
});

test("resource plus vbib yields a triangle and nothing is fetched", async () => {
  const resource = parseResource(triangleResource());
  assert.equal(resource.blocks[0].type, "DATA");
  assert.equal(resource.blocks[1].type, "VBIB");
  const vbib = await readVbib(resource.blocks[1].bytes);
  const position = attribute(vbib.vertices[0], "POSITION");
  assert.equal(position.length, 3);
  assert.equal(position[1][0], 64);
  assert.deepEqual([...indexArray(vbib.indices[0])], [0, 1, 2]);
  const parsed = await meshesFromResource(resource);
  assert.equal(parsed.meshes[0].indices.length, 3);
  const source = fs.readFileSync(new URL("./install.js", import.meta.url), "utf8");
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("/api/"), false);
});

test("world documents expose node prefixes and placements", () => {
  const doc = {
    m_worldNodes: [{ m_worldNodePrefix: "maps/de_mirage/n0" }],
    m_sceneObjects: [{ m_renderableModel: "models/props/box.vmdl", m_vTransform: [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30] }],
  };
  assert.deepEqual(worldPrefixes(doc), ["maps/de_mirage/n0"]);
  const place = scenePlacements(doc);
  assert.equal(place[0].model, "models/props/box.vmdl");
  assert.equal(place[0].matrix[3], 10);
  assert.equal(place[0].matrix[11], 30);
});

test("vbib bytes are readable on their own", async () => {
  const vbib = await readVbib(triangleVbib());
  assert.equal(vbib.vertices[0].count, 3);
  assert.equal(vbib.indices[0].count, 3);
});
