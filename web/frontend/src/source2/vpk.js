/**
 * Valve Pak directory reader.
 * Layout: source2.wiki File Formats / VPK (CC BY-SA). Nothing here is game content.
 */

import { Cursor } from "./cursor.js";

const MAGIC = 0x55aa1234;
const DIR_INDEX = 0x7fff;

export function readVpkHeader(bytes) {
  const c = new Cursor(bytes);
  const signature = c.u32();
  if (signature !== MAGIC) throw new Error("bad_vpk");
  const version = c.u32();
  const treeSize = c.u32();
  let headerSize = 12;
  let fileDataSectionSize = 0;
  if (version === 2) {
    fileDataSectionSize = c.u32();
    c.u32();
    c.u32();
    c.u32();
    headerSize = 28;
  } else if (version !== 1) {
    throw new Error("bad_vpk");
  }
  return { version, treeSize, headerSize, fileDataSectionSize };
}

function readCString(c) {
  return c.cstring(1 << 20);
}

export function readVpkTree(bytes, header) {
  const c = new Cursor(bytes);
  c.seek(header.headerSize);
  const end = header.headerSize + header.treeSize;
  const entries = new Map();
  while (c.o < end) {
    const ext = readCString(c);
    if (!ext) break;
    while (c.o < end) {
      const dir = readCString(c);
      if (!dir) break;
      while (c.o < end) {
        const name = readCString(c);
        if (!name) break;
        const crc = c.u32();
        const preload = c.u16();
        const archive = c.u16();
        const offset = c.u32();
        const length = c.u32();
        const term = c.u16();
        if (term !== 0xffff) throw new Error("bad_vpk");
        const inlineBytes = preload ? c.bytes(preload) : new Uint8Array();
        const extension = ext === " " ? "" : ext;
        const folder = dir === " " ? "" : dir;
        const base = name === " " ? "" : name;
        const path = `${folder ? `${folder}/` : ""}${base}${extension ? `.${extension}` : ""}`.toLowerCase();
        entries.set(path, { crc, archive, offset, length, preload: inlineBytes });
      }
    }
  }
  return entries;
}

export function entryLocation(header, entry) {
  if (entry.archive === DIR_INDEX) {
    return { where: "dir", offset: header.headerSize + header.treeSize + entry.offset, length: entry.length };
  }
  return { where: entry.archive, offset: entry.offset, length: entry.length };
}

export function archiveName(index) {
  return `pak01_${String(index).padStart(3, "0")}.vpk`;
}
