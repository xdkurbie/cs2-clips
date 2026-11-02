/**
 * Decode a CS2R round: magic + JSON header + gzip struct-of-arrays.
 * Positions are int16 (times scale). Yaw/pitch are uint8.
 */

self.onmessage = async (event) => {
  const { id, buffer } = event.data;
  try {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== "CS2R") throw new Error("bad round");
    const scale = view.getUint16(6, true) || 1;
    const headerLen = view.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLen)));
    const gz = buffer.slice(12 + headerLen);
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    const raw = await new Response(stream).arrayBuffer();
    const body = new DataView(raw);
    const nF = body.getUint32(0, true);
    const nP = body.getUint32(4, true);
    let o = 8;
    const channels = [];
    const transfers = [];
    for (let p = 0; p < nP; p++) {
      const x = new Float32Array(nF);
      const y = new Float32Array(nF);
      const z = new Float32Array(nF);
      for (let i = 0; i < nF; i++) x[i] = body.getInt16(o + i * 2, true) * scale;
      o += nF * 2;
      for (let i = 0; i < nF; i++) y[i] = body.getInt16(o + i * 2, true) * scale;
      o += nF * 2;
      for (let i = 0; i < nF; i++) z[i] = body.getInt16(o + i * 2, true) * scale;
      o += nF * 2;
      const yaw = new Float32Array(nF);
      const pitch = new Float32Array(nF);
      for (let i = 0; i < nF; i++) yaw[i] = (body.getUint8(o + i) / 255) * 360;
      o += nF;
      for (let i = 0; i < nF; i++) pitch[i] = (body.getUint8(o + i) / 255) * 180 - 90;
      o += nF;
      const hp = new Uint8Array(nF);
      const armor = new Uint8Array(nF);
      for (let i = 0; i < nF; i++) hp[i] = body.getUint8(o + i);
      o += nF;
      for (let i = 0; i < nF; i++) armor[i] = body.getUint8(o + i);
      o += nF;
      const money = new Uint16Array(nF);
      const equip = new Uint16Array(nF);
      for (let i = 0; i < nF; i++) money[i] = body.getUint16(o + i * 2, true);
      o += nF * 2;
      for (let i = 0; i < nF; i++) equip[i] = body.getUint16(o + i * 2, true);
      o += nF * 2;
      const weapon = new Uint8Array(nF);
      const flags = new Uint8Array(nF);
      for (let i = 0; i < nF; i++) weapon[i] = body.getUint8(o + i);
      o += nF;
      for (let i = 0; i < nF; i++) flags[i] = body.getUint8(o + i);
      o += nF;
      channels.push({ x, y, z, yaw, pitch, hp, armor, money, equip, weapon, flags });
      transfers.push(x.buffer, y.buffer, z.buffer, yaw.buffer, pitch.buffer, hp.buffer, armor.buffer, money.buffer, equip.buffer, weapon.buffer, flags.buffer);
    }
    self.postMessage({ id, header, nFrames: nF, channels }, transfers);
  } catch (err) {
    self.postMessage({ id, error: err?.message || "decode failed" });
  }
};
