import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createBlockoutMesh, createSiteMarkers, csToThree, lerpAngle, viewForward } from "./mesh.js";

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const UP = new THREE.Vector3(0, 1, 0);

function weaponLabel(name) {
  if (!name) return "";
  return String(name).replace(/^weapon_/, "").replace(/_/g, " ");
}

function bombAt(events, tick) {
  let carrier = null;
  let planted = null;
  let defusing = null;
  for (const e of events || []) {
    if (e.tick > tick) break;
    if (e.kind === "pickup") carrier = e.steamid;
    else if (e.kind === "drop") carrier = null;
    else if (e.kind === "plant") { carrier = null; planted = e; defusing = null; }
    else if (e.kind === "defuse_start") defusing = e;
    else if (e.kind === "defuse" || e.kind === "explode") { planted = null; defusing = null; }
  }
  return { carrier, planted, defusing };
}

export class ReplayViewer {
  constructor(opts) {
    this.opts = opts;
    this.timeline = opts.timeline;
    this.blockout = opts.blockout;
    this.matchId = opts.matchId;
    this.labels = opts.labels || {};
    this.mode = opts.mode || "orbit";
    this.speed = 1;
    this.playing = false;
    this.low = opts.low === true;
    this.focus = opts.focus || this.timeline.players[0]?.steamid || "";
    this.tick = opts.tick || this.timeline.rounds[0]?.startTick || this.timeline.tick0 || 0;
    this.clipH = (this.blockout?.bounds?.maxZ ?? 0) + 400;
    this.rounds = new Map();
    this.inflight = new Map();
    this.pending = new Map();
    this.seq = 0;
    this.current = null;
    this._raf = 0;
    this._last = performance.now();
    this._snap = true;
    this._shareAt = 0;
    this._build();
    this.worker = new Worker(new URL("./roundWorker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this._onWorker(e.data);
  }

  _build() {
    const stage = this.opts.stage;
    stage.replaceChildren();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "gl";
    stage.appendChild(this.canvas);
    this.overlay = document.createElement("div");
    this.overlay.className = "overlay";
    stage.appendChild(this.overlay);
    this.clockEl = document.createElement("div");
    this.clockEl.className = "clock";
    this.overlay.appendChild(this.clockEl);
    this.feedEl = document.createElement("div");
    this.feedEl.className = "feed";
    this.overlay.appendChild(this.feedEl);
    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "banner";
    this.overlay.appendChild(this.bannerEl);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !this.low,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x1a2433, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.localClippingEnabled = true;
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), this.clipH);
    this.renderer.clippingPlanes = [this.clip];
    // Shadow maps are left off. Turning them on before every material has a
    // compiled program throws in headless WebGL (`program.isReady`). The
    // directional light still shades the blockout.
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a2433);
    this.scene.fog = new THREE.Fog(0x1a2433, 700, 6200);
    const fill = new THREE.DirectionalLight(0xc5d4e8, 0.35);
    fill.position.set(-600, 400, -800);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xe7eef8, 0x3a3228, 0.72));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.28));
    const sun = new THREE.DirectionalLight(0xfff6e8, 1.15);
    sun.position.set(900, 1600, 500);
    if (!this.low) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.bias = -0.0004;
      const spanGuess = 4000;
      sun.shadow.camera.near = 50;
      sun.shadow.camera.far = spanGuess * 2;
      sun.shadow.camera.left = -spanGuess;
      sun.shadow.camera.right = spanGuess;
      sun.shadow.camera.top = spanGuess;
      sun.shadow.camera.bottom = -spanGuess;
    }
    this.scene.add(sun);
    this._sun = sun;

    const plants = (this.timeline.bomb || []).filter((b) => b.kind === "plant");
    const mesh = createBlockoutMesh(this.blockout, plants);
    this.scene.add(mesh.ground, mesh.floors, mesh.walls, createSiteMarkers(plants));
    this._floors = mesh.floors;
    this._walls = mesh.walls;
    this._mapMats = mesh.materials;

    const b = this.blockout?.bounds;
    const cx = b ? (b.minX + b.maxX) / 2 : 0;
    const cy = b ? (b.minY + b.maxY) / 2 : 0;
    const cz = b ? (b.minZ + b.maxZ) / 2 : 0;
    this.center = new THREE.Vector3(cx, cz, -cy);
    const span = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, 800) : 2000;
    this.span = span;

    this.persp = new THREE.PerspectiveCamera(48, 1, 4, 40000);
    this.persp.position.set(cx + span * 0.22, (b?.maxZ ?? 0) + span * 0.42, -cy + span * 0.62);
    this.persp.lookAt(this.center);
    this._homePos = this.persp.position.clone();
    this._homeTarget = this.center.clone();
    if (this._sun) {
      this._sun.shadow.camera.left = -span;
      this._sun.shadow.camera.right = span;
      this._sun.shadow.camera.top = span;
      this._sun.shadow.camera.bottom = -span;
      this._sun.shadow.camera.far = span * 3;
      this._sun.shadow.camera.updateProjectionMatrix();
      this._sun.target.position.copy(this.center);
      this.scene.add(this._sun.target);
    }
    this.ortho = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1, 40000);
    this.ortho.position.set(cx, (b?.maxZ ?? 0) + 2500, -cy);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(cx, cz, -cy);
    this.controls = new OrbitControls(this.persp, this.canvas);
    this.controls.target.copy(this.center);
    this.controls.enableDamping = true;
    this.controls.maxDistance = span * 1.8;
    this.controls.minDistance = 40;
    this.controls.target.clamp = null;
    this._applyMode();

    const n = Math.max(1, this.timeline.players.length);
    this.n = n;
    const bodyMat = new THREE.MeshLambertMaterial({ emissive: 0x22180e, emissiveIntensity: 0.35 });
    const headMat = new THREE.MeshLambertMaterial({ emissive: 0x22180e, emissiveIntensity: 0.35 });
    this.body = new THREE.InstancedMesh(new THREE.CapsuleGeometry(14, 32, 4, 8), bodyMat, n);
    this.head = new THREE.InstancedMesh(new THREE.SphereGeometry(9, 12, 8), headMat, n);
    this.disc = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(26, 26, 3, 12),
      new THREE.MeshBasicMaterial(),
      n,
    );
    this.cone = new THREE.InstancedMesh(
      new THREE.ConeGeometry(18, 170, 8, 1, true),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide }),
      n,
    );
    this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.head.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.disc.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.cone.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.scene.add(this.disc, this.body, this.head, this.cone);
    this._color = new THREE.Color();
    this._dir = new THREE.Vector3();
    this._ndc = new THREE.Vector3();
    this._deathAt = new Float32Array(n);
    this._wasAlive = new Uint8Array(n);
    this.deaths = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff5d4a, transparent: true, depthTest: false });
      const g = new THREE.Group();
      const a = new THREE.Mesh(new THREE.BoxGeometry(36, 5, 5), mat);
      const c = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 36), mat);
      g.add(a, c);
      g.visible = false;
      this.scene.add(g);
      this.deaths.push({ g, mat });
    }
    this.dummy = new THREE.Object3D();
    this._fwd = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._cam = new THREE.Vector3();
    this._look = new THREE.Vector3();

    this.viewmodel = new THREE.Group();
    const gunMat = new THREE.MeshLambertMaterial({ color: 0x2c241c });
    const gun = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 36), gunMat);
    gun.position.set(18, -16, -40);
    gun.rotation.y = 0.55;
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 22), gunMat);
    barrel.position.set(16, -12, -68);
    this.viewmodel.add(barrel);
    this.viewmodel.add(gun);
    this.viewmodel.visible = false;
    this.persp.add(this.viewmodel);
    this.scene.add(this.persp);

    this.nadeMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(9, 10, 8), new THREE.MeshLambertMaterial({ emissive: 0x332211, emissiveIntensity: 0.4 }), 48);
    this.nadeMesh.count = 0;
    this.scene.add(this.nadeMesh);
    this.fireMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide }),
      40,
    );
    this.fireMesh.count = 0;
    this.scene.add(this.fireMesh);

    this.smokes = [];
    for (let i = 0; i < 16; i++) {
      const g = new THREE.Group();
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(118, 18, 12),
        new THREE.MeshLambertMaterial({ color: 0xe7eef6, emissive: 0x9aa8b8, emissiveIntensity: 0.35, transparent: true, opacity: 0.5, depthWrite: false }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(130, 138, 28, 1, 0, Math.PI * 2),
        new THREE.MeshBasicMaterial({ color: 0xe7e1d6, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
      );
      ring.rotation.x = -Math.PI / 2;
      g.add(sphere, ring);
      g.visible = false;
      this.scene.add(g);
      this.smokes.push({ g, ring });
    }
    this.flashes = [];
    const flashGeo = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.9, depthWrite: false }));
      m.visible = false;
      this.scene.add(m);
      this.flashes.push(m);
    }
    this.bombMesh = new THREE.Group();
    const casing = new THREE.Mesh(new THREE.BoxGeometry(22, 10, 36), new THREE.MeshLambertMaterial({ color: 0xc4552b }));
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 16, 6), new THREE.MeshLambertMaterial({ color: 0x222 }));
    antenna.position.y = 12;
    this.bombMesh.add(casing, antenna);
    this.bombMesh.visible = false;
    this.scene.add(this.bombMesh);
    this.arcGroup = new THREE.Group();
    this.scene.add(this.arcGroup);
    this.arcs = [];

    this.blindEl = document.createElement("div");
    this.blindEl.className = "blind";
    this.overlay.appendChild(this.blindEl);
    this.crosshair = document.createElement("div");
    this.crosshair.className = "crosshair";
    this.crosshair.hidden = true;
    this.overlay.appendChild(this.crosshair);
    this.povGun = document.createElement("div");
    this.povGun.className = "pov-gun";
    this.overlay.appendChild(this.povGun);
    this._rings = [];
    for (let i = 1; i <= 24; i++) {
      this._rings.push(new THREE.RingGeometry(132, 146, 28, 1, Math.PI / 2, (i / 24) * Math.PI * 2));
    }
    this.tags = this.timeline.players.map((p) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "tag";
      const name = document.createElement("span");
      name.className = "tag-name";
      name.textContent = p.name || p.steamid;
      const hp = document.createElement("i");
      hp.className = "tag-hp";
      const fill = document.createElement("b");
      hp.appendChild(fill);
      const gun = document.createElement("span");
      gun.className = "tag-gun";
      el.append(name, hp, gun);
      el.addEventListener("click", () => this.setFocus(p.steamid, "follow"));
      this.overlay.appendChild(el);
      return { el, fill, gun, hp: -1, weapon: "" };
    });
    this.feedSlots = [];
    for (let i = 0; i < 5; i++) {
      const line = document.createElement("div");
      const a = document.createElement("b");
      const w = document.createElement("span");
      const v = document.createElement("b");
      line.append(a, w, v);
      line.hidden = true;
      this.feedEl.appendChild(line);
      this.feedSlots.push({ line, a, w, v });
    }

    this._buildTeams();
    this._resize = () => this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(stage);
    this._key = (e) => this._onKey(e);
    window.addEventListener("keydown", this._key);
    this._scrubPtr = (e) => this._onScrub(e);
    this.opts.scrub?.addEventListener("pointerdown", this._scrubPtr);
    this.opts.scrub?.addEventListener("pointermove", this._scrubPtr);
    this.resize();
  }

  _buildTeams() {
    const root = this.opts.teams;
    if (!root) return;
    root.replaceChildren();
    this.rows = new Map();
    for (const side of ["CT", "T"]) {
      const card = document.createElement("section");
      card.className = `team team-${side.toLowerCase()}`;
      const head = document.createElement("header");
      const title = document.createElement("strong");
      title.textContent = side === "CT" ? "Counter-Terrorists" : "Terrorists";
      const score = document.createElement("b");
      head.append(title, score);
      const list = document.createElement("div");
      card.append(head, list);
      root.appendChild(card);
      if (side === "CT") { this._ctScore = score; this._ctList = list; }
      else { this._tScore = score; this._tList = list; }
    }
    for (const p of this.timeline.players) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "prow";
      row.innerHTML = `<i class="ring"><span></span></i><span class="pname"></span><span class="pmoney"></span><span class="pweap"></span><span class="putil"></span>`;
      row.querySelector(".pname").textContent = p.name || p.steamid;
      row.addEventListener("click", () => this.setFocus(p.steamid, "follow"));
      row.addEventListener("dblclick", () => this.setFocus(p.steamid, "pov"));
      this._tList.appendChild(row);
      this.rows.set(p.steamid, {
        row,
        hp: row.querySelector(".ring"),
        hpText: row.querySelector(".ring span"),
        money: row.querySelector(".pmoney"),
        weap: row.querySelector(".pweap"),
        util: row.querySelector(".putil"),
      });
    }
  }

  resize() {
    const r = this.opts.stage.getBoundingClientRect();
    const w = Math.max(2, r.width);
    const h = Math.max(2, r.height);
    const pr = this.low ? 1 : Math.min(1.25, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const aspect = w / Math.max(1, h);
    const half = this.span / (this._zoom || 1) / 2;
    this.ortho.left = -half * aspect;
    this.ortho.right = half * aspect;
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
    if (this.opts.scrub) {
      const sr = this.opts.scrub.getBoundingClientRect();
      this.opts.scrub.width = Math.max(2, sr.width) * pr;
      this.opts.scrub.height = Math.max(2, sr.height) * pr;
    }
  }

  setLabels(labels) { this.labels = labels || {}; }

  setLow(low) {
    this.low = !!low;
    this.renderer.setPixelRatio(this.low ? 1 : Math.min(1.25, window.devicePixelRatio || 1));
    this.persp.far = this.low ? 9000 : 40000;
    this.persp.updateProjectionMatrix();
    if (this.scene.fog) {
      this.scene.fog.near = this.low ? 1600 : 700;
      this.scene.fog.far = this.low ? 9000 : 6200;
    }
    this.cone.visible = !this.low;
    if (this._detail) this._detail.visible = !this.low;
    this.renderer.toneMappingExposure = this.low ? 1 : 1.18;
  }

  useInstall(built) {
    if (!built?.group) return;
    if (this._install) this.scene.remove(this._install);
    this._install = built.group;
    this._detail = built.detail;
    if (this._detail) this._detail.visible = !this.low;
    this.scene.add(built.group);
    if (this._floors) this._floors.visible = false;
    if (this._walls) this._walls.visible = false;
    this._agentGeo = built.agents || {};
    this._agentNodes?.forEach((node) => this.scene.remove(node));
    this._agentNodes = [];
    this._prev = [];
    if (this._agentGeo.ct || this._agentGeo.t) {
      for (let i = 0; i < this.n; i++) {
        const mesh = new THREE.Mesh(this._agentGeo.ct || this._agentGeo.t, new THREE.MeshLambertMaterial());
        mesh.frustumCulled = true;
        mesh.visible = false;
        this.scene.add(mesh);
        this._agentNodes.push(mesh);
      }
      this.body.visible = false;
      this.head.visible = false;
    }
  }

  setSpeed(speed) { this.speed = speed; }
  setPlaying(playing) { this.playing = playing; if (playing) this._last = performance.now(); }
  toggle() { this.setPlaying(!this.playing); }

  setMode(mode) {
    this.mode = mode;
    this._snap = true;
    this._applyMode();
    this._share();
  }

  setFocus(steamid, mode) {
    this.focus = steamid;
    if (mode) this.setMode(mode);
    else this._share();
  }

  setClip(z) {
    this.clipH = z;
    this.clip.constant = z;
  }

  seek(tick) {
    this.tick = Math.max(0, Math.min(this.timeline.totalTicks || tick, tick));
    this._snap = true;
    this._share();
    const round = this._roundFor(this.tick);
    if (round) this.ensureRound(round.number);
  }

  _applyMode() {
    const top = this.mode === "top";
    this.controls.enabled = this.mode === "orbit" || top;
    this.controls.enableRotate = this.mode === "orbit";
    this.controls.enablePan = true;
    this.controls.object = top ? this.ortho : this.persp;
    if (this.viewmodel) this.viewmodel.visible = this.mode === "pov";
    if (this.crosshair) this.crosshair.hidden = this.mode !== "pov";
    if (this.povGun) this.povGun.hidden = this.mode !== "pov";
    if (this.mode === "orbit" && this._homePos) {
      this.persp.position.copy(this._homePos);
      this.controls.target.copy(this._homeTarget);
    }
    if (top) {
      this.ortho.position.x = this.center.x;
      this.ortho.position.z = this.center.z;
      this.ortho.lookAt(this.center.x, this.center.y, this.center.z);
      this.controls.target.set(this.center.x, this.center.y, this.center.z);
    }
  }

  _roundFor(tick) {
    const rounds = this.timeline.rounds || [];
    return rounds.find((r) => tick >= r.startTick && tick <= r.endTick)
      || rounds.find((r) => tick < r.startTick)
      || rounds[rounds.length - 1]
      || null;
  }

  ensureRound(n) {
    if (this.rounds.has(n)) return Promise.resolve(this.rounds.get(n));
    if (this.inflight.has(n)) return this.inflight.get(n);
    const p = fetch(`${import.meta.env.VITE_API_URL || ""}/api/matches/${this.matchId}/rounds/${n}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error("round"); return r.arrayBuffer(); })
      .then((buffer) => this._decode(buffer))
      .then((decoded) => {
        this.rounds.set(n, decoded);
        this.inflight.delete(n);
        if (n + 1 <= (this.timeline.rounds || []).length) this.ensureRound(n + 1);
        return decoded;
      })
      .catch((err) => {
        this.inflight.delete(n);
        throw err;
      });
    this.inflight.set(n, p);
    return p;
  }

  _decode(buffer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, buffer }, [buffer]);
    });
  }

  _onWorker(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  async start() {
    try {
      if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.persp);
    } catch { /* shader warmup is optional */ }
    const round = this._roundFor(this.tick);
    if (round) this.ensureRound(round.number);
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      if (this.playing) {
        this.tick += dt * (this.timeline.tickrate || 64) * this.speed;
        const end = this.timeline.totalTicks || this.tick;
        if (this.tick >= end) { this.tick = end; this.playing = false; this.opts.onPlaying?.(false); }
      }
      this._frame(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _activeRound() {
    const round = this._roundFor(this.tick);
    if (!round) return null;
    const data = this.rounds.get(round.number);
    if (!data) {
      this.ensureRound(round.number);
      return this.current;
    }
    if (!this.current || this.current.header.round !== round.number) {
      this.current = data;
      this._rebuildArcs(data.header);
    }
    return data;
  }

  _rebuildArcs(header) {
    for (const a of this.arcs) a.line.geometry.dispose();
    this.arcGroup.clear();
    this.arcs = [];
    for (const tr of header.trajectories || []) {
      const arr = new Float32Array(tr.points.length * 3);
      tr.points.forEach((p, i) => {
        arr[i * 3] = p[1];
        arr[i * 3 + 1] = p[3];
        arr[i * 3 + 2] = -p[2];
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const color = tr.kind === "smoke" ? 0xd5e4f2 : tr.kind === "flash" ? 0xfff3b0 : tr.kind === "molotov" ? 0xff6a1a : 0xff5a42;
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
      this.arcGroup.add(line);
      this.arcs.push({ line, ticks: tr.points.map((p) => p[0]), kind: tr.kind });
    }
  }

  _sample(data, tick) {
    const { tick0, interval } = data.header;
    const nF = data.nFrames;
    let f = (tick - tick0) / Math.max(1, interval);
    if (f < 0) f = 0;
    if (f > nF - 1) f = nF - 1;
    const i = Math.floor(f);
    const j = Math.min(nF - 1, i + 1);
    const u = f - i;
    return data.channels.map((ch) => {
      const dx = ch.x[j] - ch.x[i];
      const dy = ch.y[j] - ch.y[i];
      const dz = ch.z[j] - ch.z[i];
      const teleport = dx * dx + dy * dy + dz * dz > 640000;
      const uu = teleport ? (u < 0.5 ? 0 : 1) : u;
      const s = uu < 0.5 ? i : j;
      const flags = ch.flags[s];
      return {
        x: ch.x[i] + (ch.x[j] - ch.x[i]) * uu,
        y: ch.y[i] + (ch.y[j] - ch.y[i]) * uu,
        z: ch.z[i] + (ch.z[j] - ch.z[i]) * uu,
        yaw: lerpAngle(ch.yaw[i], ch.yaw[j], uu),
        pitch: ch.pitch[i] + (ch.pitch[j] - ch.pitch[i]) * uu,
        hp: ch.hp[s],
        armor: ch.armor[s],
        money: ch.money[s],
        equip: ch.equip[s],
        weapon: ch.weapon[s],
        flags,
        present: (flags & 128) !== 0,
        alive: (flags & 1) !== 0,
        helmet: (flags & 2) !== 0,
        kit: (flags & 4) !== 0,
        team: (flags >> 4) & 7,
      };
    });
  }

  _frame(now) {
    const data = this._activeRound();
    const cam = this.mode === "top" ? this.ortho : this.persp;
    if (data) {
      const players = this._sample(data, this.tick);
      this._lastPlayers = players;
      this._drawPlayers(players, cam);
      this._drawUtility(data.header, now);
      if (!this._hudAt || now - this._hudAt > 100) {
        this._hudAt = now;
        this._drawHud(data, players);
      }
      const round = this._roundFor(this.tick);
      const tr = this.timeline.tickrate || 64;
      let remain = 0;
      if (this._bombState?.planted) remain = 40 - (this.tick - this._bombState.planted.tick) / tr;
      else if (round) remain = 115 - (this.tick - round.startTick) / tr;
      const L = this.labels;
      this.clockEl.textContent = `${L.round || "Round"} ${round?.number || "–"}   ${Math.max(0, Math.floor(remain / 60))}:${String(Math.max(0, Math.floor(remain % 60))).padStart(2, "0")}`;
    }
    if (this.controls.enabled) this.controls.update();
    if (this.mode === "top") {
      const t = this.controls.target;
      this.ortho.up.set(0, 0, -1);
      this.ortho.position.set(t.x, (this.blockout?.bounds?.maxZ ?? 0) + 2200, t.z);
      this.ortho.lookAt(t.x, t.y, t.z);
    }
    this.renderer.render(this.scene, cam);
    if (!this._shadowBaked && this.renderer.shadowMap.enabled) {
      this._shadowBaked = true;
      this.renderer.shadowMap.autoUpdate = false;
    }
    this._drawScrub();
    if (this.opts.fps) {
      this._fpsN = (this._fpsN || 0) + 1;
      if (!this._fpsT || now - this._fpsT > 500) {
        const fps = Math.round((this._fpsN * 1000) / (now - (this._fpsT || now - 500)));
        this.opts.fps.textContent = `${fps} fps`;
        this._fpsN = 0;
        this._fpsT = now;
      }
    }
    this._snap = false;
  }

  /** One frame for export. Returns after the canvas has been drawn. */
  renderAt(tick, { mode, steamid } = {}) {
    if (mode) this.mode = mode;
    if (steamid) this.focus = steamid;
    this.tick = tick;
    this._snap = true;
    this._applyMode();
    const data = this.rounds.get(this._roundFor(tick)?.number);
    if (!data) return false;
    this.current = data;
    const players = this._sample(data, tick);
    this._lastPlayers = players;
    const cam = this.mode === "top" ? this.ortho : this.persp;
    this._drawPlayers(players, cam);
    this._drawUtility(data.header, performance.now());
    this.renderer.render(this.scene, cam);
    return true;
  }

  _drawPlayers(players, cam) {
    const color = this._color;
    const weapons = (this.current && this.current.header.weapons) || this.timeline.weapons || [];
    let focusIndex = -1;
    const tr = this.timeline.tickrate || 64;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const meta = this.timeline.players[i];
      if (meta && meta.steamid === this.focus) focusIndex = i;
      const hide = !p.present || (this.mode === "pov" && meta?.steamid === this.focus);
      const teamCt = p.team === 3;
      color.set(teamCt ? 0x4aa3ff : 0xf0a04a);
      if (!p.alive) color.multiplyScalar(0.55);
      csToThree(p.x, p.y, p.z, this._pos);
      viewForward(p.yaw, p.pitch, this._fwd);
      if (this._fwd.lengthSq() < 1e-6) this._fwd.set(1, 0, 0);
      else this._fwd.normalize();
      const s = hide ? 0.0001 : 1;
      if (p.alive) this._wasAlive[i] = 1;
      else if (this._wasAlive[i]) {
        this._deathAt[i] = this.tick;
        this._wasAlive[i] = 0;
      }
      this.dummy.position.copy(this._pos);
      this.dummy.position.y += 2;
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.disc.setMatrixAt(i, this.dummy.matrix);
      this.disc.setColorAt(i, color);
      this.dummy.position.copy(this._pos);
      this.dummy.position.y += p.alive ? 36 : 10;
      this.dummy.rotation.set(p.alive ? 0 : 1.15, 0, 0);
      this.dummy.scale.setScalar(s * (p.alive ? 1 : 0.7));
      this.dummy.updateMatrix();
      this.body.setMatrixAt(i, this.dummy.matrix);
      this.body.setColorAt(i, color);
      this.dummy.position.copy(this._pos);
      this.dummy.position.y += p.alive ? 68 : 14;
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.head.setMatrixAt(i, this.dummy.matrix);
      this.head.setColorAt(i, color);
      this.dummy.position.copy(this._pos);
      this.dummy.position.y += 64;
      this.dummy.quaternion.setFromUnitVectors(UP, this._fwd);
      this.dummy.scale.setScalar(!p.alive || hide || this.mode === "pov" ? 0.0001 : 1);
      this.dummy.updateMatrix();
      this.cone.setMatrixAt(i, this.dummy.matrix);
      this.cone.setColorAt(i, color);
      const agent = this._agentNodes?.[i];
      if (agent) {
        const geo = teamCt ? (this._agentGeo.ct || this._agentGeo.t) : (this._agentGeo.t || this._agentGeo.ct);
        if (geo && agent.geometry !== geo) agent.geometry = geo;
        agent.material.color.copy(color);
        agent.visible = !hide && p.present;
        const prev = this._prev[i];
        const speed = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) * (this.timeline.tickrate || 64) : 0;
        this._prev[i] = { x: p.x, y: p.y };
        const run = speed > 90;
        agent.position.copy(this._pos);
        agent.position.y += run ? Math.abs(Math.sin(this.tick * 0.45)) * 2.4 : Math.sin(this.tick * 0.08) * 0.35;
        agent.rotation.set(run ? 0.12 : 0, (-p.yaw * Math.PI) / 180, 0);
        agent.scale.set(hide ? 0.0001 : 1, hide ? 0.0001 : 1, hide ? 0.0001 : 1);
      }

      const death = this.deaths[i];
      const age = p.alive ? 999 : (this.tick - this._deathAt[i]) / tr;
      if (death && !p.alive && this._deathAt[i] > 0 && age < 3.2 && !hide) {
        death.g.visible = true;
        death.g.position.copy(this._pos);
        death.g.position.y += 46;
        death.mat.opacity = Math.max(0, 1 - age / 3.2);
      } else if (death) death.g.visible = false;

      const tag = this.tags[i];
      if (!tag) continue;
      this._eye.copy(this._pos);
      this._eye.y += 86;
      this._dir.copy(this._eye).sub(cam.position);
      const front = this._dir.dot(cam.getWorldDirection(this._look)) > 0;
      if (!p.present || !front || hide) { tag.el.style.display = "none"; continue; }
      this._ndc.copy(this._eye).project(cam);
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      tag.el.style.display = "grid";
      tag.el.style.transform = `translate3d(${(this._ndc.x * 0.5 + 0.5) * w}px, ${(-this._ndc.y * 0.5 + 0.5) * h}px, 0) translate(-50%, -120%)`;
      tag.el.classList.toggle("ct", teamCt);
      tag.el.classList.toggle("dead", !p.alive);
      const hp = p.alive ? Math.max(0, Math.min(100, p.hp | 0)) : 0;
      if (tag.hp !== hp) {
        tag.hp = hp;
        tag.fill.style.width = `${hp}%`;
      }
      const gunName = weaponLabel(weapons[p.weapon] || "");
      if (tag.weapon !== gunName) {
        tag.weapon = gunName;
        tag.gun.textContent = gunName;
      }
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    this.disc.instanceMatrix.needsUpdate = true;
    this.cone.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.head.instanceColor) this.head.instanceColor.needsUpdate = true;
    if (this.disc.instanceColor) this.disc.instanceColor.needsUpdate = true;
    if (this.cone.instanceColor) this.cone.instanceColor.needsUpdate = true;

    const fp = focusIndex >= 0 ? players[focusIndex] : null;
    if (fp && (this.mode === "follow" || this.mode === "pov")) {
      csToThree(fp.x, fp.y, fp.z, this._pos);
      viewForward(fp.yaw, fp.pitch, this._fwd);
      if (this.mode === "pov") {
        this._eye.copy(this._pos);
        this._eye.y += 64;
        this._look.copy(this._eye).addScaledVector(this._fwd, 120);
        if (this._snap) this.persp.position.copy(this._eye);
        else this.persp.position.lerp(this._eye, 0.45);
        this.persp.up.set(0, 1, 0);
        this._aimMat ||= new THREE.Matrix4();
        this._aimQuat ||= new THREE.Quaternion();
        this._aimMat.lookAt(this.persp.position, this._look, UP);
        this._aimQuat.setFromRotationMatrix(this._aimMat);
        if (this._snap) this.persp.quaternion.copy(this._aimQuat);
        else this.persp.quaternion.slerp(this._aimQuat, 0.35);
        const gunName = weaponLabel(weapons[fp.weapon] || "");
        if (this.povGun) this.povGun.textContent = gunName;
      } else {
        this._cam.copy(this._pos).addScaledVector(this._fwd, -260);
        this._cam.y += 130;
        this._look.copy(this._pos);
        this._look.y += 48;
        const k = this._snap ? 1 : 0.18;
        this.persp.position.lerp(this._cam, k);
        this.controls.target.lerp(this._look, k);
        this.persp.lookAt(this._look);
      }
    }
  }

  _drawUtility(header, now) {
    const tick = this.tick;
    const tr = this.timeline.tickrate || 64;
    let smokeI = 0;
    let flashI = 0;
    let fireI = 0;
    let nadeI = 0;
    for (const u of header.utility || []) {
      if (tick < u.tick || tick > u.endTick) continue;
      const life = (tick - u.tick) / Math.max(1, u.endTick - u.tick);
      csToThree(u.x, u.y, u.z, this._pos);
      if (u.kind === "smoke" && smokeI < this.smokes.length) {
        const s = this.smokes[smokeI++];
        s.g.visible = true;
        s.g.position.copy(this._pos);
        const grow = Math.min(1, (tick - u.tick) / (tr * 0.35));
        s.g.scale.setScalar(0.55 + grow * 0.7);
        const step = Math.max(0, Math.min(23, Math.round((1 - life) * 23)));
        if (s.step !== step) {
          s.step = step;
          s.ring.geometry = this._rings[step];
          s.ring.rotation.x = -Math.PI / 2;
        }
        const ct = this._isCt(u.steamid);
        s.g.children[0].material.color.set(ct ? 0xd5e6f5 : 0xf3e2cc);
      } else if (u.kind === "molotov" && fireI < 36) {
        const flick = this.low ? 1 : 0.8 + Math.sin(now / 90 + u.tick) * 0.2;
        this.dummy.position.copy(this._pos);
        this.dummy.position.y += 3;
        this.dummy.rotation.set(-Math.PI / 2, 0, 0);
        this.dummy.scale.set(170 * flick, 170 * flick, 1);
        this.dummy.updateMatrix();
        this.fireMesh.setMatrixAt(fireI++, this.dummy.matrix);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(18, 70 * flick, 18);
        this.dummy.position.y += 30;
        this.dummy.updateMatrix();
        this.fireMesh.setMatrixAt(fireI++, this.dummy.matrix);
      } else if ((u.kind === "flash" || u.kind === "he") && flashI < this.flashes.length) {
        const m = this.flashes[flashI++];
        m.visible = true;
        m.position.copy(this._pos);
        const k = 1 - life;
        m.scale.setScalar((u.kind === "he" ? 160 : 220) * (0.35 + k));
        m.material.opacity = 0.2 + k * 0.8;
        m.material.color.set(u.kind === "he" ? 0xff8a3c : 0xfff6d0);
      }
    }
    for (let i = smokeI; i < this.smokes.length; i++) this.smokes[i].g.visible = false;
    for (let i = flashI; i < this.flashes.length; i++) this.flashes[i].visible = false;
    let blind = 0;
    const focus = this._focusedPlayer();
    if (focus) {
      for (const u of header.utility || []) {
        if (u.kind !== "flash") continue;
        const age = (tick - u.tick) / tr;
        if (age < 0 || age > 1.1) continue;
        const dx = focus.x - u.x;
        const dy = focus.y - u.y;
        if (dx * dx + dy * dy < 750 * 750) blind = Math.max(blind, 1 - age / 1.1);
      }
    }
    if (this.blindEl) this.blindEl.style.opacity = String(blind * 0.72);
    this.fireMesh.count = fireI;
    this.fireMesh.instanceMatrix.needsUpdate = true;

    for (const trk of header.trajectories || []) {
      if (nadeI >= 48) break;
      const pts = trk.points;
      let a = null;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i][0] <= tick) a = pts[i];
        else break;
      }
      if (!a || tick > pts[pts.length - 1][0] + 8) continue;
      csToThree(a[1], a[2], a[3], this._pos);
      this.dummy.position.copy(this._pos);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.nadeMesh.setMatrixAt(nadeI++, this.dummy.matrix);
    }
    this.nadeMesh.count = nadeI;
    this.nadeMesh.instanceMatrix.needsUpdate = true;

    for (const arc of this.arcs) {
      let count = 0;
      for (const t of arc.ticks) if (t <= tick) count++;
      arc.line.geometry.setDrawRange(0, Math.max(0, count));
      arc.line.visible = count > 1;
    }

    const state = bombAt(header.bomb, tick);
    this._bombCarrier = state.carrier;
    if (state.planted) {
      this.bombMesh.visible = true;
      csToThree(state.planted.x || 0, state.planted.y || 0, state.planted.z || 0, this._pos);
      this.bombMesh.position.copy(this._pos);
      this.bombMesh.position.y += 8;
      const blink = Math.sin(now / 140) > 0;
      this.bombMesh.children[0].material.emissive?.set?.(blink ? 0x401808 : 0x000);
      this.bombMesh.children[0].material.color.set(blink ? 0xffb15a : 0xc4552b);
    } else this.bombMesh.visible = false;
    this._bombState = state;
  }

  _drawHud(data, players) {
    const round = this._roundFor(this.tick);
    const tr = this.timeline.tickrate || 64;
    const L = this.labels;
    let remain = 0;
    if (this._bombState?.planted) remain = 40 - (this.tick - this._bombState.planted.tick) / tr;
    else if (round) remain = 115 - (this.tick - round.startTick) / tr;
    const clock = `${Math.max(0, Math.floor(remain / 60))}:${String(Math.max(0, Math.floor(remain % 60))).padStart(2, "0")}`;
    const score = this._score();
    this.clockEl.textContent = `${L.round || "Round"} ${round?.number || "–"}   ${clock}`;
    if (this._ctScore) this._ctScore.textContent = String(score.ct);
    if (this._tScore) this._tScore.textContent = String(score.t);
    if (this.opts.scoreLine) this.opts.scoreLine.textContent = `${score.t}  –  ${score.ct}`;

    const thrown = {};
    for (const u of data.header.utility || []) {
      if (u.tick > this.tick) continue;
      const key = `${u.steamid}:${u.kind}`;
      thrown[key] = (thrown[key] || 0) + 1;
    }
    const weapons = data.header.weapons || this.timeline.weapons || [];
    for (let i = 0; i < players.length; i++) {
      const meta = this.timeline.players[i];
      const row = this.rows?.get(meta.steamid);
      if (!row) continue;
      const p = players[i];
      const side = p.team === 3 ? "CT" : p.team === 2 ? "T" : "";
      const parent = side === "CT" ? this._ctList : side === "T" ? this._tList : null;
      if (parent && row.row.parentElement !== parent) parent.appendChild(row.row);
      row.row.classList.toggle("dead", !p.alive);
      row.row.classList.toggle("focus", meta.steamid === this.focus);
      row.row.hidden = !p.present || !side;
      const hp = Math.max(0, Math.min(100, p.hp || 0));
      row.hp.style.setProperty("--p", String(p.alive ? hp : 0));
      row.hpText.textContent = p.alive ? String(hp) : "";
      row.money.textContent = `$${p.money || 0}`;
      row.weap.textContent = weaponLabel(weapons[p.weapon] || "");
      const bits = ["smoke", "flash", "he", "molotov"].filter((k) => thrown[`${meta.steamid}:${k}`]);
      row.util.textContent = bits.map((k) => (k === "smoke" ? "S" : k === "flash" ? "F" : k === "he" ? "H" : "M")).join(" ");
    }

    const feed = [];
    for (const k of data.header.kills || []) {
      if (k.tick <= this.tick && this.tick - k.tick < tr * 6) feed.push(k);
    }
    const recent = feed.slice(-5);
    const sig = recent.map((k) => k.tick).join(",");
    if (sig !== this._feedSig) {
      this._feedSig = sig;
      for (let i = 0; i < this.feedSlots.length; i++) {
        const slot = this.feedSlots[i];
        const k = recent[i];
        if (!k) { slot.line.hidden = true; continue; }
        slot.line.hidden = false;
        slot.a.textContent = k.attackerName || "";
        slot.a.className = k.attackerTeam === "CT" ? "ct" : "t";
        slot.w.textContent = `${k.headshot ? "HS " : ""}${weaponLabel(k.weapon)}`;
        slot.v.textContent = k.victimName || "";
        slot.v.className = k.victimTeam === "CT" ? "ct" : "t";
      }
    }

    if (round && this.tick > round.endTick - tr * 2 && this.tick < round.endTick + tr * 3) {
      const reason = L[round.reason] || round.reason || "";
      const who = round.winner === "CT" ? "CT" : "T";
      this.bannerEl.textContent = `${who} · ${reason}`;
      this.bannerEl.hidden = false;
    } else this.bannerEl.hidden = true;
  }

  _isCt(steamid) {
    const players = this._lastPlayers;
    if (!players) return false;
    for (let i = 0; i < players.length; i++) {
      if (this.timeline.players[i]?.steamid === steamid) return players[i].team === 3;
    }
    return false;
  }

  _focusedPlayer() {
    const players = this._lastPlayers;
    if (!players) return null;
    for (let i = 0; i < players.length; i++) {
      if (this.timeline.players[i]?.steamid === this.focus) return players[i];
    }
    return players[0] || null;
  }

  _score() {
    let t = 0; let ct = 0;
    for (const r of this.timeline.rounds || []) {
      if (r.endTick > this.tick) break;
      if (r.winner === "T") t++;
      else if (r.winner === "CT") ct++;
    }
    return { t, ct };
  }

  _drawScrub() {
    const canvas = this.opts.scrub;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const total = Math.max(1, this.timeline.totalTicks || 1);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#171d27";
    ctx.fillRect(0, 0, w, h);
    for (const r of this.timeline.rounds || []) {
      const x = (r.startTick / total) * w;
      const x2 = (r.endTick / total) * w;
      ctx.fillStyle = r.winner === "CT" ? "rgba(142,183,232,0.28)" : r.winner === "T" ? "rgba(224,163,106,0.28)" : "rgba(255,255,255,0.05)";
      ctx.fillRect(x, 8, Math.max(1, x2 - x), h - 16);
    }
    for (const k of this.timeline.kills || []) {
      const x = (k.tick / total) * w;
      ctx.fillStyle = k.attackerTeam === "CT" ? "#8eb7e8" : "#e0a36a";
      ctx.fillRect(x, h * 0.35, Math.max(1, w / total * 8), h * 0.3);
    }
    for (const b of this.timeline.bomb || []) {
      if (b.kind !== "plant" && b.kind !== "defuse") continue;
      const x = (b.tick / total) * w;
      ctx.fillStyle = b.kind === "plant" ? "#e0b15a" : "#7dcea0";
      ctx.fillRect(x - 1, 4, 2, h - 8);
    }
    const px = (this.tick / total) * w;
    ctx.fillStyle = "#f3efe6";
    ctx.fillRect(px, 0, 2, h);
  }

  _onScrub(e) {
    if (e.type === "pointermove" && e.buttons !== 1) return;
    const canvas = this.opts.scrub;
    const r = canvas.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    this.playing = false;
    this.opts.onPlaying?.(false);
    this.seek(u * (this.timeline.totalTicks || 1));
  }

  _onKey(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) return;
    if (e.code === "Space") { e.preventDefault(); this.toggle(); this.opts.onPlaying?.(this.playing); }
    else if (e.key === "ArrowRight") this.seek(this.tick + (e.shiftKey ? 10 : 2) * (this.timeline.tickrate || 64));
    else if (e.key === "ArrowLeft") this.seek(this.tick - (e.shiftKey ? 10 : 2) * (this.timeline.tickrate || 64));
    else if (e.key === "f") this.setMode("follow");
    else if (e.key === "v") this.setMode("pov");
    else if (e.key === "o") this.setMode("orbit");
    else if (e.key === "t") this.setMode("top");
    else if (e.key === "c") {
      const b = this.blockout?.bounds;
      if (!b) return;
      const mid = (b.minZ + b.maxZ) / 2;
      this.setClip(this.clipH < b.maxZ ? b.maxZ + 400 : mid);
    }
  }

  _share() {
    const now = performance.now();
    if (now - this._shareAt < 400) return;
    this._shareAt = now;
    const round = this._roundFor(this.tick);
    const path = `#/m/${this.matchId}?round=${round?.number || 1}&tick=${Math.round(this.tick)}&mode=${this.mode}`;
    if (location.hash.split("?")[0] === `#/m/${this.matchId}`) history.replaceState(null, "", path);
  }

  zoom(dir) {
    this._zoom = Math.min(6, Math.max(0.4, (this._zoom || 1) * (dir > 0 ? 1.15 : 0.87)));
    this.resize();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.worker.terminate();
    this._ro.disconnect();
    window.removeEventListener("keydown", this._key);
    this.opts.scrub?.removeEventListener("pointerdown", this._scrubPtr);
    this.opts.scrub?.removeEventListener("pointermove", this._scrubPtr);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

export { SPEEDS };
