/**
 * Read a local CS2 install in the browser. Bytes stay on this machine:
 * File System Access or a directory input, then IndexedDB and OPFS.
 */

import { archiveName, entryLocation, readVpkHeader, readVpkTree } from "./vpk.js";
import { compiledPath } from "./interpret.js";
import { buildWorldGroup } from "./assemble.js";

const CACHE = "cs2clips-local-map";
const STORE = "maps";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readCachedMap(map) {
  try {
    const base = await db();
    const row = await new Promise((resolve) => {
      const req = base.transaction(STORE).objectStore(STORE).get(map);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (!row) return null;
    return buildWorldGroup(row.entries, { low: row.low });
  } catch {
    return null;
  }
}

async function remember(map, entries, low) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("cs2clips", { create: true });
    const handle = await dir.getFileHandle(`${map}.txt`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(`local ${map} ${entries.length}\n`);
    await writable.close();
  } catch {
    /* OPFS is optional; IndexedDB still holds the mesh */
  }
  try {
    const base = await db();
    await new Promise((resolve, reject) => {
      const req = base.transaction(STORE, "readwrite").objectStore(STORE).put({ entries, low }, map);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* the live scene still works for this tab */
  }
}

async function resolveCsgo(handle) {
  async function hasPak(dir) {
    try {
      await dir.getFileHandle("pak01_dir.vpk");
      return true;
    } catch {
      return false;
    }
  }
  if (await hasPak(handle)) return handle;
  try {
    const game = await handle.getDirectoryHandle("game");
    const csgo = await game.getDirectoryHandle("csgo");
    if (await hasPak(csgo)) return csgo;
  } catch { /* try the next known folder */ }
  try {
    const csgo = await handle.getDirectoryHandle("csgo");
    if (await hasPak(csgo)) return csgo;
  } catch { /* not this folder */ }
  throw new Error("not_csgo");
}

async function sourceFromHandle(root) {
  async function walk(dir, parts) {
    const name = parts[0];
    if (parts.length === 1) return dir.getFileHandle(name);
    const next = await dir.getDirectoryHandle(name);
    return walk(next, parts.slice(1));
  }
  return {
    async file(path) {
      try {
        const handle = await walk(root, path.split("/").filter(Boolean));
        return handle.getFile();
      } catch {
        return null;
      }
    },
  };
}

export async function pickInstallDirectory() {
  if (typeof window.showDirectoryPicker === "function") {
    const picked = await window.showDirectoryPicker({ mode: "read" });
    return sourceFromHandle(await resolveCsgo(picked));
  }
  throw new Error("picker");
}

export function sourceFromFileList(files) {
  const list = [...files];
  const hit = list.find((file) => (file.webkitRelativePath || file.name).toLowerCase().endsWith("pak01_dir.vpk"));
  if (!hit) throw new Error("not_csgo");
  const full = (hit.webkitRelativePath || hit.name).replaceAll("\\", "/");
  const at = full.toLowerCase().lastIndexOf("pak01_dir.vpk");
  const root = full.slice(0, at).toLowerCase();
  const map = new Map();
  for (const file of list) {
    const path = (file.webkitRelativePath || file.name).replaceAll("\\", "/").toLowerCase();
    if (!path.startsWith(root)) continue;
    map.set(path.slice(root.length), file);
  }
  return { async file(path) { return map.get(path.toLowerCase()) || null; } };
}

async function openVpk(source, path) {
  const file = await source.file(path);
  if (!file) return null;
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const header = readVpkHeader(head);
  const tree = new Uint8Array(await file.slice(0, header.headerSize + header.treeSize).arrayBuffer());
  return { file, header, entries: readVpkTree(tree, header) };
}

async function readEntry(source, vpk, entry) {
  const loc = entryLocation(vpk.header, entry);
  const preload = entry.preload?.length ? entry.preload : new Uint8Array();
  if (!loc.length) return preload;
  const file = loc.where === "dir" ? vpk.file : await source.file(archiveName(loc.where));
  if (!file) throw new Error("vpk_archive");
  const rest = new Uint8Array(await file.slice(loc.offset, loc.offset + loc.length).arrayBuffer());
  if (!preload.length) return rest;
  const out = new Uint8Array(preload.length + rest.length);
  out.set(preload);
  out.set(rest, preload.length);
  return out;
}

function findEntry(vpk, suffix) {
  if (!vpk) return "";
  const needle = suffix.toLowerCase();
  for (const key of vpk.entries.keys()) if (key.endsWith(needle)) return key;
  return "";
}

function Parser() {
  const worker = new Worker(new URL("./parseWorker.js", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (event) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    pending.delete(event.data.id);
    if (event.data.error) job.reject(new Error(event.data.error));
    else job.resolve(event.data);
  };
  return {
    parse(bytes, limit) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes, limit }, [bytes.buffer]);
      });
    },
    close() { worker.terminate(); },
  };
}

function topModels(placements, cap) {
  const counts = new Map();
  for (const place of placements) {
    const path = compiledPath(place.model);
    counts.set(path, (counts.get(path) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([path]) => path);
}

export async function loadInstallMap(source, mapName, { low = false, onProgress = () => {} } = {}) {
  onProgress("index");
  const pak = await openVpk(source, "pak01_dir.vpk");
  const mapVpk = await openVpk(source, `maps/${mapName}.vpk`);
  if (!pak && !mapVpk) throw new Error("not_csgo");
  const parser = Parser();
  const limit = low ? 6000 : 24000;
  const modelCap = low ? 48 : 180;
  try {
    const worldPath = findEntry(mapVpk, "/world.vwrld_c") || findEntry(mapVpk, "world.vwrld_c");
    if (!worldPath) throw new Error("map_missing");
    onProgress("world");
    const worldBytes = await readEntry(source, mapVpk, mapVpk.entries.get(worldPath));
    const world = await parser.parse(worldBytes, limit);
    const placements = [];
    for (const prefix of world.prefixes) {
      const nodePath = findEntry(mapVpk, `${prefix.toLowerCase()}.vwnod_c`)
        || findEntry(mapVpk, prefix.toLowerCase());
      if (!nodePath) continue;
      const node = await parser.parse(await readEntry(source, mapVpk, mapVpk.entries.get(nodePath)), limit);
      placements.push(...node.placements);
    }
    const wanted = new Set(topModels(placements, modelCap));
    const byModel = new Map();
    onProgress("models");
    for (const path of wanted) {
      const fromMap = findEntry(mapVpk, path);
      const fromPak = findEntry(pak, path);
      const vpk = fromMap ? mapVpk : pak;
      const key = fromMap || fromPak;
      if (!vpk || !key) continue;
      const parsed = await parser.parse(await readEntry(source, vpk, vpk.entries.get(key)), limit);
      let meshes = parsed.meshes;
      if (!meshes.length && parsed.external?.length) {
        meshes = [];
        for (const ext of parsed.external.slice(0, low ? 1 : 3)) {
          const meshPath = findEntry(vpk, compiledPath(ext)) || findEntry(pak, compiledPath(ext));
          const host = findEntry(vpk, compiledPath(ext)) ? vpk : pak;
          if (!host || !meshPath) continue;
          const mesh = await parser.parse(await readEntry(source, host, host.entries.get(meshPath)), limit);
          meshes.push(...mesh.meshes);
        }
      }
      if (meshes[0]) byModel.set(path, meshes[0]);
    }
    const entries = [];
    for (const [path, mesh] of byModel) {
      const matrices = placements.filter((p) => compiledPath(p.model) === path).map((p) => p.matrix);
      entries.push({ mesh, matrices, material: mesh.material, model: path });
    }
    onProgress("agents");
    for (const [agent, needle] of [["ct", "ctm_sas.vmdl_c"], ["t", "tm_phoenix.vmdl_c"]]) {
      const path = findEntry(pak, needle) || findEntry(pak, agent === "ct" ? "/ctm_" : "/tm_");
      if (!path) continue;
      const parsed = await parser.parse(await readEntry(source, pak, pak.entries.get(path)), low ? 4000 : 12000);
      if (parsed.meshes[0]) entries.push({ mesh: parsed.meshes[0], agent, model: path, material: agent });
    }
    if (!entries.length) throw new Error("no_geometry");
    await remember(mapName || "map", entries, low);
    onProgress("ready");
    return buildWorldGroup(entries, { low });
  } finally {
    parser.close();
  }
}
