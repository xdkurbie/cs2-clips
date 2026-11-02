/**
 * Original blockout geometry from where players actually stood.
 * Floors sit on the sampled foot height, so ramps, sites and multiple
 * levels stay apart. This is not Valve art — it is a walkable-volume blockout.
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
 * @returns {{floors:object[], walls:object[], bounds:object|null}}
 * Boxes are in CS space: x/y origin at the min corner, z is the floor top.
 */
export function buildBlockout(points, opts = {}) {
  const cell = opts.cell ?? 64;
  const zBin = opts.zBin ?? 32;
  const list = [];
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    list.push(p);
  }
  if (!list.length) return { floors: [], walls: [], bounds: null };

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

  const masks = new Map();
  const colHeights = new Map();
  for (const p of list) {
    const ix = Math.floor((p.x - originX) / cell);
    const iy = Math.floor((p.y - originY) / cell);
    if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) continue;
    const iz = Math.round(p.z / zBin);
    let mask = masks.get(iz);
    if (!mask) {
      mask = new Uint8Array(cols * rows);
      masks.set(iz, mask);
    }
    const key = iy * cols + ix;
    mask[key] = 1;
    let hs = colHeights.get(key);
    if (!hs) {
      hs = [];
      colHeights.set(key, hs);
    }
    if (hs[hs.length - 1] !== iz) hs.push(iz);
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
        sz: 12,
      });
    }
  }

  function ceiling(ix, iy, iz) {
    const hs = colHeights.get(iy * cols + ix);
    if (!hs) return 100;
    let best = Infinity;
    const base = iz * zBin;
    for (const h of hs) {
      const dz = h * zBin - base;
      if (dz > zBin && dz < best) best = dz;
    }
    if (!Number.isFinite(best)) return 100;
    return Math.max(28, Math.min(100, best - 6));
  }

  function occupied(ix, iy, iz) {
    if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return false;
    for (const dz of [iz - 1, iz, iz + 1]) {
      const m = masks.get(dz);
      if (m && m[iy * cols + ix] === 1) return true;
    }
    return false;
  }

  const walls = [];
  function pushRun(axis, fixed, start, length, iz, height) {
    if (length <= 0 || height < 20) return;
    if (axis === "x") {
      walls.push({
        x: originX + fixed * cell - 5,
        y: originY + start * cell,
        z: iz * zBin,
        sx: 10,
        sy: length * cell,
        sz: height,
      });
    } else {
      walls.push({
        x: originX + start * cell,
        y: originY + fixed * cell - 5,
        z: iz * zBin,
        sx: length * cell,
        sy: 10,
        sz: height,
      });
    }
  }

  for (const iz of masks.keys()) {
    for (let ix = 0; ix <= cols; ix++) {
      let run = 0;
      let start = 0;
      let runH = 0;
      const flush = () => {
        pushRun("x", ix, start, run, iz, runH);
        run = 0;
      };
      for (let iy = 0; iy < rows; iy++) {
        const left = occupied(ix - 1, iy, iz);
        const right = occupied(ix, iy, iz);
        if (left === right) {
          flush();
          continue;
        }
        const side = left ? { ix: ix - 1, iy } : { ix, iy };
        const h = ceiling(side.ix, side.iy, iz);
        if (run > 0 && Math.abs(h - runH) > 18) flush();
        if (run === 0) {
          start = iy;
          runH = h;
        }
        run++;
      }
      flush();
    }
    for (let iy = 0; iy <= rows; iy++) {
      let run = 0;
      let start = 0;
      let runH = 0;
      const flush = () => {
        pushRun("y", iy, start, run, iz, runH);
        run = 0;
      };
      for (let ix = 0; ix < cols; ix++) {
        const a = occupied(ix, iy - 1, iz);
        const b = occupied(ix, iy, iz);
        if (a === b) {
          flush();
          continue;
        }
        const side = a ? { ix, iy: iy - 1 } : { ix, iy };
        const h = ceiling(side.ix, side.iy, iz);
        if (run > 0 && Math.abs(h - runH) > 18) flush();
        if (run === 0) {
          start = ix;
          runH = h;
        }
        run++;
      }
      flush();
    }
  }

  // Risers where two walked cells meet at different heights (stairs, drops, windows).
  for (const [key, hs] of colHeights) {
    const ix = key % cols;
    const iy = (key / cols) | 0;
    const unique = [...new Set(hs)];
    for (const iz of unique) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = ix + dx;
        const ny = iy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const other = colHeights.get(ny * cols + nx);
        if (!other) continue;
        let lower = null;
        for (const h of other) {
          if (h < iz && (lower === null || h > lower)) lower = h;
        }
        if (lower === null) continue;
        const dz = (iz - lower) * zBin;
        if (dz < 48 || dz > 160) continue;
        if (dx === 1) {
          walls.push({ x: originX + (ix + 1) * cell - 4, y: originY + iy * cell, z: lower * zBin, sx: 8, sy: cell, sz: dz });
        } else if (dx === -1) {
          walls.push({ x: originX + ix * cell - 4, y: originY + iy * cell, z: lower * zBin, sx: 8, sy: cell, sz: dz });
        } else if (dy === 1) {
          walls.push({ x: originX + ix * cell, y: originY + (iy + 1) * cell - 4, z: lower * zBin, sx: cell, sy: 8, sz: dz });
        } else {
          walls.push({ x: originX + ix * cell, y: originY + iy * cell - 4, z: lower * zBin, sx: cell, sy: 8, sz: dz });
        }
      }
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
