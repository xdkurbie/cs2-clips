/**
 * Original blockout from every sampled foot position in the demo.
 * Floors are greedy-merged per height band. Full-height walls sit only on the
 * outer rim. Steps between bands are short risers, not a second maze.
 * This is not Valve geometry.
 */

function greedy(mask, cols, rows) {
  const used = new Uint8Array(cols * rows);
  const rects = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!mask[i] || used[i]) continue;
      let w = 1;
      while (x + w < cols && mask[i + w] && !used[i + w]) w++;
      let h = 1;
      outer: while (y + h < rows) {
        for (let k = 0; k < w; k++) {
          const j = (y + h) * cols + x + k;
          if (!mask[j] || used[j]) break outer;
        }
        h++;
      }
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) used[(y + yy) * cols + x + xx] = 1;
      }
      rects.push({ x, y, w, h });
    }
  }
  return rects;
}

/**
 * @param {{x:number,y:number,z:number}[]} points CS world units (Z up)
 * Boxes: x/y is the min corner. For floors, z is the top. For walls, z is the base.
 */
export function buildBlockout(points, opts = {}) {
  const cell = opts.cell ?? 72;
  const zBin = opts.zBin ?? 24;
  const list = [];
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    list.push(p);
  }
  if (!list.length) return { floors: [], walls: [], bounds: null, cell, zBin };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of list) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const originX = Math.floor(minX / cell) * cell;
  const originY = Math.floor(minY / cell) * cell;
  const cols = Math.max(1, Math.ceil((maxX - originX) / cell) + 1);
  const rows = Math.max(1, Math.ceil((maxY - originY) / cell) + 1);

  const hist = new Map();
  for (const p of list) {
    const ix = Math.floor((p.x - originX) / cell);
    const iy = Math.floor((p.y - originY) / cell);
    if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) continue;
    const iz = Math.round(p.z / zBin);
    const key = iy * cols + ix;
    let bins = hist.get(key);
    if (!bins) {
      bins = new Map();
      hist.set(key, bins);
    }
    bins.set(iz, (bins.get(iz) || 0) + 1);
  }

  /** @type {{ix:number,iy:number,iz:number,z:number}[]} */
  const levels = [];
  for (const [key, bins] of hist) {
    const ordered = [...bins.keys()].sort((a, b) => a - b);
    let cluster = [ordered[0]];
    const flush = () => {
      let weight = 0;
      let sum = 0;
      for (const b of cluster) {
        const c = bins.get(b);
        weight += c;
        sum += b * c;
      }
      const mean = sum / weight;
      levels.push({
        ix: key % cols,
        iy: (key / cols) | 0,
        iz: Math.round(mean),
        z: mean * zBin,
      });
      cluster = [];
    };
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i] - ordered[i - 1] > 2) flush();
      cluster.push(ordered[i]);
    }
    flush();
  }

  const masks = new Map();
  const colLevels = new Map();
  for (const lv of levels) {
    let mask = masks.get(lv.iz);
    if (!mask) {
      mask = new Uint8Array(cols * rows);
      masks.set(lv.iz, mask);
    }
    mask[lv.iy * cols + lv.ix] = 1;
    const key = lv.iy * cols + lv.ix;
    let arr = colLevels.get(key);
    if (!arr) {
      arr = [];
      colLevels.set(key, arr);
    }
    arr.push(lv.iz);
  }

  // Close small holes so greedy merge can make real rooms, without bridging a gap.
  for (const [iz, mask] of [...masks]) {
    const grown = new Uint8Array(mask);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!mask[y * cols + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const nk = ny * cols + nx;
            if (grown[nk]) continue;
            const other = colLevels.get(nk);
            if (other && other.some((h) => Math.abs(h - iz) > 2)) continue;
            grown[nk] = 1;
          }
        }
      }
    }
    masks.set(iz, grown);
  }

  const floors = [];
  for (const [iz, mask] of masks) {
    for (const r of greedy(mask, cols, rows)) {
      floors.push({
        x: originX + r.x * cell,
        y: originY + r.y * cell,
        z: iz * zBin,
        sx: r.w * cell,
        sy: r.h * cell,
        sz: 16,
      });
    }
  }

  function near(ix, iy, iz) {
    if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return false;
    for (let d = -2; d <= 2; d++) {
      const m = masks.get(iz + d);
      if (m && m[iy * cols + ix]) return true;
    }
    return false;
  }

  function lowerNeighbor(ix, iy, iz) {
    const hs = colLevels.get(iy * cols + ix);
    if (!hs) return null;
    let best = null;
    for (const h of hs) {
      if (h < iz - 2 && (best === null || h > best)) best = h;
    }
    return best;
  }

  const walls = [];
  function pushRun(axis, fixed, start, length, iz, height, kind) {
    if (length <= 0 || height < 12) return;
    const z = kind === "wall" ? iz * zBin : iz * zBin;
    if (axis === "x") {
      walls.push({
        x: originX + fixed * cell - 8,
        y: originY + start * cell,
        z,
        sx: kind === "wall" ? 16 : 10,
        sy: length * cell,
        sz: height,
        kind,
      });
    } else {
      walls.push({
        x: originX + start * cell,
        y: originY + fixed * cell - 8,
        z,
        sx: length * cell,
        sy: kind === "wall" ? 16 : 10,
        sz: height,
        kind,
      });
    }
  }

  for (const iz of masks.keys()) {
    for (let ix = 0; ix <= cols; ix++) {
      let run = 0;
      let start = 0;
      let runKind = "";
      let runH = 0;
      const flush = () => {
        if (runKind === "wall") pushRun("x", ix, start, run, iz, 112, "wall");
        else if (runKind === "step") pushRun("x", ix, start, run, iz - Math.round(runH / zBin), runH, "step");
        run = 0;
        runKind = "";
      };
      for (let iy = 0; iy < rows; iy++) {
        const left = near(ix - 1, iy, iz);
        const right = near(ix, iy, iz);
        if (left === right) {
          flush();
          continue;
        }
        const emptySide = left ? { ix, iy } : { ix: ix - 1, iy };
        const solid = left ? { ix: ix - 1, iy } : { ix, iy };
        const drop = lowerNeighbor(emptySide.ix, emptySide.iy, iz);
        const kind = drop == null ? "wall" : "step";
        const h = drop == null ? 112 : Math.min(100, (iz - drop) * zBin);
        if (run && (kind !== runKind || Math.abs(h - runH) > 20)) flush();
        if (!run) {
          start = iy;
          runKind = kind;
          runH = h;
        }
        run++;
        void solid;
      }
      flush();
    }
    for (let iy = 0; iy <= rows; iy++) {
      let run = 0;
      let start = 0;
      let runKind = "";
      let runH = 0;
      const flush = () => {
        if (runKind === "wall") pushRun("y", iy, start, run, iz, 112, "wall");
        else if (runKind === "step") pushRun("y", iy, start, run, iz - Math.round(runH / zBin), runH, "step");
        run = 0;
        runKind = "";
      };
      for (let ix = 0; ix < cols; ix++) {
        const a = near(ix, iy - 1, iz);
        const b = near(ix, iy, iz);
        if (a === b) {
          flush();
          continue;
        }
        const emptySide = a ? { ix, iy } : { ix, iy: iy - 1 };
        const drop = lowerNeighbor(emptySide.ix, emptySide.iy, iz);
        const kind = drop == null ? "wall" : "step";
        const h = drop == null ? 112 : Math.min(100, (iz - drop) * zBin);
        if (run && (kind !== runKind || Math.abs(h - runH) > 20)) flush();
        if (!run) {
          start = ix;
          runKind = kind;
          runH = h;
        }
        run++;
      }
      flush();
    }
  }

  return {
    floors,
    walls,
    bounds: { minX, minY, maxX, maxY, minZ, maxZ },
    cell,
    zBin,
  };
}
