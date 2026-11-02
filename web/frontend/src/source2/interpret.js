/** Pull the fields a map loader needs out of a KV3 document. */

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value;
  return [];
}

export function matrix12(value) {
  const src = asArray(value);
  const out = new Float32Array(12);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  if (src.length >= 12) {
    for (let i = 0; i < 12; i++) out[i] = Number(src[i]) || 0;
  }
  return out;
}

export function worldPrefixes(doc) {
  return asArray(doc?.m_worldNodes)
    .map((node) => node?.m_worldNodePrefix || node?.m_worldNode || "")
    .filter(Boolean);
}

export function scenePlacements(doc, cap = 20000) {
  const out = [];
  for (const obj of asArray(doc?.m_sceneObjects)) {
    const model = obj?.m_renderableModel || obj?.m_renderable || "";
    if (!model) continue;
    out.push({ model: String(model), matrix: matrix12(obj.m_vTransform) });
    if (out.length >= cap) break;
  }
  return out;
}

export function compiledPath(path) {
  const text = String(path || "").replaceAll("\\", "/").replace(/^\//, "").toLowerCase();
  if (!text) return "";
  if (text.endsWith("_c")) return text;
  return `${text}_c`;
}
