/**
 * Pull triangle meshes out of a parsed model or mesh resource.
 */

import { readKv3 } from "./kv3.js";
import { block, blockAt } from "./resource.js";
import { attribute, indexArray, readVbib } from "./vbib.js";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bufferIndex(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return num(value.m_nBufferIndex ?? value.m_hBuffer ?? value, 0);
}

function drawCallsOf(doc) {
  const calls = [];
  for (const draw of doc?.m_drawCalls || []) calls.push(draw);
  for (const scene of doc?.m_sceneObjects || []) {
    for (const draw of scene?.m_drawCalls || []) calls.push(draw);
  }
  return calls;
}

function packMesh(positions, normals, uvs, indices, material, limit) {
  let idx = indices;
  if (limit && idx.length > limit) idx = idx.subarray(0, limit - (limit % 3));
  if (!normals) {
    normals = new Float32Array(positions.length);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i] * 3;
      const b = idx[i + 1] * 3;
      const c = idx[i + 2] * 3;
      const ux = positions[b] - positions[a];
      const uy = positions[b + 1] - positions[a + 1];
      const uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a];
      const vy = positions[c + 1] - positions[a + 1];
      const vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const at of [a, b, c]) {
        normals[at] += nx;
        normals[at + 1] += ny;
        normals[at + 2] += nz;
      }
    }
  }
  return {
    positions,
    normals,
    uvs: uvs || new Float32Array((positions.length / 3) * 2),
    indices: idx,
    material: material || "",
  };
}

async function meshFromDoc(doc, vbib, limit) {
  const vertices = vbib?.vertices || [];
  const indexBuffers = vbib?.indices || [];
  const calls = drawCallsOf(doc);
  const meshes = [];
  if (!calls.length && vertices[0]) {
    const position = attribute(vertices[0], "POSITION");
    if (!position) return meshes;
    const positions = new Float32Array(position.length * 3);
    position.forEach((p, i) => {
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1] || 0;
      positions[i * 3 + 2] = p[2] || 0;
    });
    const indices = indexArray(indexBuffers[0]) || Uint32Array.from({ length: position.length }, (_, i) => i);
    meshes.push(packMesh(positions, null, null, indices, "", limit));
    return meshes;
  }
  for (const draw of calls) {
    const vertex = vertices[bufferIndex(draw.m_vertexBuffers?.[0] ?? draw.m_nVertexBuffer ?? 0)];
    if (!vertex) continue;
    const position = attribute(vertex, "POSITION");
    if (!position) continue;
    const normalSrc = attribute(vertex, "NORMAL");
    const uvSrc = attribute(vertex, "TEXCOORD");
    const positions = new Float32Array(position.length * 3);
    const normals = normalSrc ? new Float32Array(position.length * 3) : null;
    const uvs = uvSrc ? new Float32Array(position.length * 2) : null;
    for (let i = 0; i < position.length; i++) {
      positions[i * 3] = position[i][0];
      positions[i * 3 + 1] = position[i][1] || 0;
      positions[i * 3 + 2] = position[i][2] || 0;
      if (normals && normalSrc[i]) {
        normals[i * 3] = normalSrc[i][0];
        normals[i * 3 + 1] = normalSrc[i][1] || 0;
        normals[i * 3 + 2] = normalSrc[i][2] || 0;
      }
      if (uvs && uvSrc[i]) {
        uvs[i * 2] = uvSrc[i][0];
        uvs[i * 2 + 1] = uvSrc[i][1] || 0;
      }
    }
    const indexBuffer = indexBuffers[bufferIndex(draw.m_indexBuffer ?? draw.m_nIndexBuffer ?? 0)];
    let indices = indexArray(indexBuffer);
    const start = num(draw.m_nStartIndex);
    const count = num(draw.m_nIndexCount, indices ? indices.length - start : position.length);
    const baseVertex = num(draw.m_nBaseVertex);
    if (indices) {
      const slice = indices.subarray(start, start + count);
      indices = new Uint32Array(slice.length);
      for (let i = 0; i < slice.length; i++) indices[i] = slice[i] + baseVertex;
    } else {
      indices = Uint32Array.from({ length: Math.min(count, position.length) }, (_, i) => i + baseVertex);
    }
    meshes.push(packMesh(positions, normals, uvs, indices, draw.m_material || draw.m_pMaterial || "", limit));
  }
  return meshes;
}

async function vbibFor(resource, doc) {
  const direct = block(resource, "VBIB");
  if (direct) return readVbib(direct.bytes);
  return null;
}

export async function meshesFromResource(resource, { limit = 0 } = {}) {
  const ctrl = block(resource, "CTRL");
  if (ctrl) {
    const doc = await readKv3(ctrl.bytes);
    const embedded = doc?.embedded_meshes || doc?.m_embeddedMeshes || [];
    const meshes = [];
    for (const entry of embedded) {
      const dataIndex = entry.data_block ?? entry.m_nDataBlock;
      const vbibIndex = entry.vbib_block ?? entry.m_nVBIBBlock;
      const dataBlock = blockAt(resource, dataIndex);
      const vbibBlock = blockAt(resource, vbibIndex);
      if (!dataBlock) continue;
      const data = await readKv3(dataBlock.bytes);
      const vbib = vbibBlock ? await readVbib(vbibBlock.bytes) : null;
      meshes.push(...await meshFromDoc(data, vbib, limit));
    }
    if (meshes.length) return { meshes, external: [] };
  }
  const dataBlock = block(resource, "DATA");
  if (!dataBlock) return { meshes: [], external: [] };
  const doc = await readKv3(dataBlock.bytes);
  const external = []
    .concat(doc?.m_refMeshes || [])
    .filter((path) => typeof path === "string" && path);
  const vbib = await vbibFor(resource, doc);
  const meshes = vbib || doc?.m_sceneObjects || doc?.m_drawCalls
    ? await meshFromDoc(doc, vbib, limit)
    : [];
  return { meshes, external, doc };
}

export function modelPaths(doc) {
  const refs = doc?.m_refMeshes;
  if (!refs) return [];
  return [...refs].filter((path) => typeof path === "string" && path);
}
