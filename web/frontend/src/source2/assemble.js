import * as THREE from "three";
import { matrix12 } from "./interpret.js";

function convertVec3(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i];
    out[i + 1] = src[i + 2] || 0;
    out[i + 2] = -(src[i + 1] || 0);
  }
  return out;
}

export function geometryFromMesh(mesh) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(convertVec3(mesh.positions), 3));
  if (mesh.normals?.length) geo.setAttribute("normal", new THREE.BufferAttribute(convertVec3(mesh.normals), 3));
  else geo.computeVertexNormals();
  if (mesh.uvs?.length) geo.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

function colorOf(name) {
  let hash = 0;
  const text = name || "world";
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.22, 0.46);
}

export function matrixToThree(value) {
  const f = value?.length >= 12 ? value : matrix12(value);
  const x = new THREE.Vector3(f[0], f[8], -f[4]);
  const y = new THREE.Vector3(f[1], f[9], -f[5]);
  const z = new THREE.Vector3(f[2], f[10], -f[6]);
  const t = new THREE.Vector3(f[3], f[11], -f[7]);
  const mat = new THREE.Matrix4();
  mat.makeBasis(x, y, z);
  mat.setPosition(t);
  return mat;
}

export function buildWorldGroup(entries, { low = false } = {}) {
  const world = new THREE.Group();
  world.name = "cs2-install";
  const detail = new THREE.Group();
  detail.name = "detail";
  world.add(detail);
  const agents = {};
  for (const entry of entries) {
    const geo = geometryFromMesh(entry.mesh);
    const mat = new THREE.MeshLambertMaterial({ color: colorOf(entry.material) });
    const matrices = entry.matrices?.length ? entry.matrices : [matrix12(null)];
    const clutter = /foliage|detail|clutter|props_/.test(entry.model || "");
    if (entry.agent) {
      agents[entry.agent] = geo;
      continue;
    }
    const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
    mesh.frustumCulled = true;
    mesh.castShadow = !low;
    mesh.receiveShadow = true;
    mesh.count = matrices.length;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, matrixToThree(m)));
    mesh.instanceMatrix.needsUpdate = true;
    (clutter ? detail : world).add(mesh);
  }
  detail.visible = !low;
  return { group: world, detail, agents };
}
