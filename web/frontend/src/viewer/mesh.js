import * as THREE from "three";

const FACES = [
  { n: [1, 0, 0], c: [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [-1, 0, 0], c: [[-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]] },
  { n: [0, 1, 0], c: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, -1, 0], c: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [-1, 1, 1], [1, 1, 1], [1, -1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, -1]] },
];

function pushBox(pos, nor, col, cx, cy, cz, sx, sy, sz, rgb) {
  for (const face of FACES) {
    const corners = face.c.map((c) => [
      cx + c[0] * sx * 0.5,
      cy + c[1] * sy * 0.5,
      cz + c[2] * sz * 0.5,
    ]);
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(corners[k][0], corners[k][1], corners[k][2]);
      nor.push(face.n[0], face.n[1], face.n[2]);
      col.push(rgb[0], rgb[1], rgb[2]);
    }
  }
}

function shade(z, minZ, maxZ, wall, site) {
  const t = (z - minZ) / Math.max(1, maxZ - minZ);
  let r = wall ? 0.28 + t * 0.1 : 0.34 + t * 0.28;
  let g = wall ? 0.30 + t * 0.08 : 0.36 + t * 0.18;
  let b = wall ? 0.36 + t * 0.06 : 0.42 + t * 0.08;
  if (site === "A") { r += 0.08; g += 0.03; }
  if (site === "B") { b += 0.08; g += 0.02; }
  return [r, g, b];
}

function siteAt(x, y, plants) {
  let best = null;
  let dist = 340;
  for (const p of plants) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < dist) { dist = d; best = p.site; }
  }
  return best;
}

/** Stylized blockout. CS Z is up; three.js Y is up. */
export function createBlockoutMesh(blockout, plants = []) {
  const floors = { pos: [], nor: [], col: [] };
  const walls = { pos: [], nor: [], col: [] };
  const b = blockout?.bounds || { minZ: 0, maxZ: 1 };
  for (const box of blockout?.floors || []) {
    const cx = box.x + box.sx / 2;
    const cy = box.y + box.sy / 2;
    const cz = box.z - box.sz / 2;
    const rgb = shade(box.z, b.minZ, b.maxZ, false, siteAt(cx, cy, plants));
    pushBox(floors.pos, floors.nor, floors.col, cx, cz, -cy, box.sx, box.sz, box.sy, rgb);
  }
  for (const box of blockout?.walls || []) {
    const cx = box.x + box.sx / 2;
    const cy = box.y + box.sy / 2;
    const cz = box.z + box.sz / 2;
    const rgb = shade(box.z, b.minZ, b.maxZ, true, null);
    pushBox(walls.pos, walls.nor, walls.col, cx, cz, -cy, box.sx, box.sz, box.sy, rgb);
  }
  const toGeo = (buf) => {
    const g = new THREE.BufferGeometry();
    if (!buf.pos.length) return g;
    g.setAttribute("position", new THREE.Float32BufferAttribute(buf.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(buf.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(buf.col, 3));
    return g;
  };
  const floorMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const wallMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return {
    floors: new THREE.Mesh(toGeo(floors), floorMat),
    walls: new THREE.Mesh(toGeo(walls), wallMat),
    materials: [floorMat, wallMat],
  };
}

export function csToThree(x, y, z, out) {
  out.set(x, z, -y);
  return out;
}

export function viewForward(yawDeg, pitchDeg, out) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  out.set(cp * cy, -sp, -(cp * sy));
  return out;
}

export function lerpAngle(a, b, u) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * u;
}
