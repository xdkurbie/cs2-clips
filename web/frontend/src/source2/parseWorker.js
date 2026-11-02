import { meshesFromResource } from "./geometry.js";
import { scenePlacements, worldPrefixes } from "./interpret.js";
import { parseResource } from "./resource.js";

self.onmessage = async (event) => {
  const { id, bytes, limit } = event.data;
  try {
    const resource = parseResource(bytes);
    const parsed = await meshesFromResource(resource, { limit });
    const doc = parsed.doc || null;
    const transfers = [];
    for (const mesh of parsed.meshes) {
      transfers.push(mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer);
    }
    self.postMessage({
      id,
      meshes: parsed.meshes,
      external: parsed.external || [],
      prefixes: worldPrefixes(doc),
      placements: scenePlacements(doc),
    }, transfers);
  } catch (err) {
    self.postMessage({ id, error: err?.message || "parse" });
  }
};
