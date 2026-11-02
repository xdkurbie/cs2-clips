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
    const top = face.n[1] > 0.5;
    const bottom = face.n[1] < -0.5;
    const lift = top ? 1.28 : bottom ? 0.52 : 0.92;
    const corners = face.c.map((c) => [
      cx + c[0] * sx * 0.5,
      cy + c[1] * sy * 0.5,
      cz + c[2] * sz * 0.5,
    ]);
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(corners[k][0], corners[k][1], corners[k][2]);
      nor.push(face.n[0], face.n[1], face.n[2]);
      col.push(rgb[0] * lift, rgb[1] * lift, rgb[2] * lift);
    }
  }
}

function shade(z, minZ, maxZ, kind, site) {
  const t = (z - minZ) / Math.max(1, maxZ - minZ);
  let r;
  let g;
  let b;
  if (kind === "wall") {
    r = 0.34 + t * 0.08;
    g = 0.42 + t * 0.06;
    b = 0.52 + t * 0.05;
  } else if (kind === "step") {
    r = 0.55 + t * 0.08;
    g = 0.48 + t * 0.05;
    b = 0.36;
  } else {
    r = 0.62 + t * 0.16;
    g = 0.56 + t * 0.1;
    b = 0.44 + t * 0.04;
  }
  if (site === "A") { r += 0.1; g += 0.04; }
  if (site === "B") { b += 0.12; g += 0.02; }
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
    const rgb = shade(box.z, b.minZ, b.maxZ, "floor", siteAt(cx, cy, plants));
    pushBox(floors.pos, floors.nor, floors.col, cx, cz, -cy, box.sx, box.sz, box.sy, rgb);
  }
  for (const box of blockout?.walls || []) {
    const cx = box.x + box.sx / 2;
    const cy = box.y + box.sy / 2;
    const cz = box.z + box.sz / 2;
    const rgb = shade(box.z, b.minZ, b.maxZ, box.kind === "step" ? "step" : "wall", null);
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
  const floorMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wallMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const floorMesh = new THREE.Mesh(toGeo(floors), floorMat);
  const wallMesh = new THREE.Mesh(toGeo(walls), wallMat);
  floorMesh.castShadow = true;
  floorMesh.receiveShadow = true;
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const span = Math.max(400, (b.maxX || 0) - (b.minX || 0), (b.maxY || 0) - (b.minY || 0));
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(span * 0.95, 64),
    new THREE.MeshLambertMaterial({ color: 0x243044 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(((b.minX || 0) + (b.maxX || 0)) / 2, (b.minZ || 0) - 36, -((b.minY || 0) + (b.maxY || 0)) / 2);
  ground.receiveShadow = true;
  return {
    floors: floorMesh,
    walls: wallMesh,
    ground,
    materials: [floorMat, wallMat, ground.material],
  };
}

export function createSiteMarkers(plants) {
  const grouped = new Map();
  for (const p of plants || []) {
    if (p.x == null || !p.site) continue;
    if (!grouped.has(p.site)) grouped.set(p.site, []);
    grouped.get(p.site).push(p);
  }
  const group = new THREE.Group();
  for (const [site, list] of grouped) {
    const x = list.reduce((s, p) => s + p.x, 0) / list.length;
    const y = list.reduce((s, p) => s + p.y, 0) / list.length;
    const z = list.reduce((s, p) => s + (p.z || 0), 0) / list.length;
    const color = site === "A" ? 0xe0b15a : 0x8eb7e8;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(4, 4, 96, 8),
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.25 }),
    );
    pole.position.set(x, z + 48, -y);
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = site === "A" ? "#e0b15a" : "#8eb7e8";
    ctx.font = "700 48px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(site, 64, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthTest: false,
    }));
    sprite.position.set(x, z + 130, -y);
    sprite.scale.set(160, 80, 1);
    group.add(pole, sprite);
  }
  return group;
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
