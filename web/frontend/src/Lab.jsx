import { useEffect, useRef } from "react";
import * as THREE from "three";
import { createBlockoutMesh } from "./viewer/mesh.js";
import { triangleResource } from "./source2/fixture.js";
import { parseResource } from "./source2/resource.js";
import { meshesFromResource } from "./source2/geometry.js";
import { buildWorldGroup } from "./source2/assemble.js";

const BLOCK = {
  bounds: { minX: -80, maxX: 160, minY: -80, maxY: 160, minZ: 0, maxZ: 48 },
  floors: [{ x: -40, y: -40, z: 8, sx: 160, sy: 160, sz: 8 }],
  walls: [{ x: -40, y: -8, z: 8, sx: 160, sy: 8, sz: 40, kind: "wall" }],
};

function drawFlat(node, positions) {
  const canvas = document.createElement("canvas");
  node.appendChild(canvas);
  const paint = () => {
    const r = node.getBoundingClientRect();
    canvas.width = Math.max(2, r.width);
    canvas.height = Math.max(2, r.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1a2433";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const project = (x, y) => [canvas.width * 0.28 + x * 2.2, canvas.height * 0.72 - y * 1.6];
    ctx.fillStyle = "#8d7a62";
    ctx.beginPath();
    [[-40, -40], [120, -40], [120, 120], [-40, 120]].forEach(([x, y], i) => {
      const p = project(x, y);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#d5e6f5";
    ctx.lineWidth = 8;
    ctx.beginPath();
    positions.forEach((p, i) => {
      const pt = project(p[0] + 40, p[2] || 0);
      if (i === 0) ctx.moveTo(pt[0], pt[1]);
      else ctx.lineTo(pt[0], pt[1]);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#e0b15a";
    ctx.fill();
  };
  paint();
  const ro = new ResizeObserver(paint);
  ro.observe(node);
  return () => { ro.disconnect(); node.replaceChildren(); };
}

function mount(node, build) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x1a2433, 1);
  renderer.toneMapping = THREE.ReinhardToneMapping;
  node.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2433);
  scene.fog = new THREE.Fog(0x1a2433, 80, 520);
  scene.add(new THREE.HemisphereLight(0xe7eef8, 0x3a3228, 0.8));
  const sun = new THREE.DirectionalLight(0xfff6e8, 1.2);
  sun.position.set(80, 140, 40);
  scene.add(sun);
  build(scene);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
  camera.position.set(90, 120, 220);
  camera.lookAt(80, 20, 0);
  const resize = () => {
    const r = node.getBoundingClientRect();
    renderer.setSize(Math.max(2, r.width), Math.max(2, r.height), false);
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(node);
  resize();
  let frame = 0;
  const loop = () => {
    frame = requestAnimationFrame(loop);
    renderer.render(scene, camera);
  };
  loop();
  return () => {
    cancelAnimationFrame(frame);
    ro.disconnect();
    renderer.dispose();
    node.replaceChildren();
  };
}

export default function Lab({ i18n }) {
  const stage = useRef(null);
  const { t } = i18n;
  useEffect(() => {
    let stop = () => {};
    let dead = false;
    (async () => {
      const resource = parseResource(triangleResource());
      const parsedMesh = await meshesFromResource(resource);
      if (dead || !stage.current) return;
      const built = buildWorldGroup([{ mesh: parsedMesh.meshes[0], material: "synthetic", model: "tri" }]);
      built.group.position.set(180, 0, 0);
      const positions = [];
      const src = parsedMesh.meshes[0].positions;
      for (let i = 0; i < src.length; i += 3) positions.push([src[i], src[i + 1], src[i + 2]]);
      stop = mount(stage.current, (scene) => {
        const mesh = createBlockoutMesh(BLOCK, []);
        scene.add(mesh.ground, mesh.floors, mesh.walls, built.group);
      });
      if (!stop) stop = drawFlat(stage.current, positions);
    })();
    return () => {
      dead = true;
      stop();
    };
  }, []);
  return (
    <main className="lab">
      <figure>
        <div ref={stage} />
        <figcaption>{t.labStylized} · {t.labParsed}</figcaption>
      </figure>
    </main>
  );
}
