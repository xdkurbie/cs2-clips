/**
 * Compiled Source 2 resource container (_c files).
 * Header layout: s2v.app Valve Resource File guide.
 */

import { Cursor } from "./cursor.js";

function fourcc(value) {
  return String.fromCharCode(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
}

export function parseResource(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const c = new Cursor(raw);
  const fileSize = c.u32();
  const headerVersion = c.u16();
  if (headerVersion !== 12) throw new Error("resource_header");
  const version = c.u16();
  const blockOffset = c.u32();
  const blockCount = c.u32();
  const tableAt = 8 + blockOffset;
  c.seek(tableAt);
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const type = fourcc(c.u32());
    const offsetField = c.o;
    const relative = c.u32();
    const size = c.u32();
    const dataAt = offsetField + relative;
    blocks.push({
      type,
      bytes: raw.subarray(dataAt, dataAt + size),
    });
  }
  return {
    version,
    fileSize,
    blocks,
    tail: raw.subarray(Math.min(raw.length, fileSize)),
  };
}

export function block(resource, type, index = 0) {
  let seen = 0;
  for (const entry of resource.blocks) {
    if (entry.type !== type) continue;
    if (seen === index) return entry;
    seen += 1;
  }
  return null;
}

export function blockAt(resource, index) {
  return resource.blocks[index] || null;
}
