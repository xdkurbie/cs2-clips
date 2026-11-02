/** Synthetic Source 2 bytes for tests. Not a game asset. */

function concat(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function bytes4(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setInt32(i * 4, value, true));
  return out;
}

export function kv3V5Flag() {
  const header = new Uint8Array(160);
  const view = new DataView(header.buffer);
  let o = 0;
  const u32 = (v) => { view.setUint32(o, v, true); o += 4; };
  const i32 = (v) => { view.setInt32(o, v, true); o += 4; };
  const u16 = (v) => { view.setUint16(o, v, true); o += 2; };
  u32(0x4b563305);
  o += 16;
  u32(0);
  u16(0);
  u16(0);
  i32(2);
  i32(1);
  i32(0);
  i32(2);
  u16(0);
  u16(0);
  i32(22);
  i32(22);
  i32(0);
  i32(0);
  i32(0);
  i32(0);
  i32(8);
  i32(8);
  i32(14);
  i32(14);
  i32(0);
  i32(0);
  i32(1);
  i32(0);
  i32(0);
  i32(1);
  i32(0);
  i32(0);
  const buffer1 = new Uint8Array(8);
  buffer1[0] = 97;
  new DataView(buffer1.buffer).setInt32(4, 1, true);
  const buffer2 = new Uint8Array(14);
  const b = new DataView(buffer2.buffer);
  b.setInt32(0, 1, true);
  b.setInt32(4, 0, true);
  buffer2[8] = 9;
  buffer2[9] = 16;
  b.setUint32(10, 0xffeedd00, true);
  return concat([header.subarray(0, o), buffer1, buffer2]);
}

export function kv3Object(name, value) {
  const strings = new TextEncoder().encode(`${name}\0${value}\0`);
  const lanes = bytes4([2, 1, 0, 1]);
  const types = new Uint8Array([9, 6]);
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, 0xffeedd00, true);
  const body = concat([lanes, strings, types, trailer]);
  const header = new Uint8Array(40);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x4b563301, true);
  view.setUint32(20, 0, true);
  view.setInt32(24, 0, true);
  view.setInt32(28, 4, true);
  view.setInt32(32, 0, true);
  view.setInt32(36, body.length, true);
  return concat([header, body]);
}

function padName(name) {
  const out = new Uint8Array(32);
  const bytes = new TextEncoder().encode(name);
  out.set(bytes.subarray(0, 31));
  return out;
}

function field(name, format) {
  const out = new Uint8Array(56);
  out.set(padName(name));
  const view = new DataView(out.buffer);
  view.setInt32(32, 0, true);
  view.setUint32(36, format, true);
  view.setUint32(40, 0, true);
  return out;
}

export function triangleVbib() {
  const positions = new Float32Array([0, 0, 0, 64, 0, 0, 0, 0, 64]);
  const indices = new Uint16Array([0, 1, 2]);
  const attribute = field("POSITION", 6);
  const header = new Uint8Array(64);
  const view = new DataView(header.buffer);
  view.setUint32(0, 16, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 32, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, 3, true);
  view.setInt32(20, 12, true);
  view.setUint32(24, 40, true);
  view.setUint32(28, 1, true);
  view.setUint32(32, 88, true);
  view.setInt32(36, positions.byteLength, true);
  view.setUint32(40, 3, true);
  view.setInt32(44, 2, true);
  view.setUint32(48, 0, true);
  view.setUint32(52, 0, true);
  view.setUint32(56, 100, true);
  view.setInt32(60, indices.byteLength, true);
  return concat([
    header,
    attribute,
    new Uint8Array(positions.buffer),
    new Uint8Array(indices.buffer),
  ]);
}

export function triangleResource() {
  const data = kv3Object("m_name", "tri");
  const vbib = triangleVbib();
  const head = new Uint8Array(40);
  const view = new DataView(head.buffer);
  const fileSize = 40 + data.length + vbib.length;
  view.setUint32(0, fileSize, true);
  view.setUint16(4, 12, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, 8, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 0x41544144, true);
  view.setUint32(20, 20, true);
  view.setUint32(24, data.length, true);
  view.setUint32(28, 0x42494256, true);
  view.setUint32(32, 8 + data.length, true);
  view.setUint32(36, vbib.length, true);
  return concat([head, data, vbib]);
}

export function sampleVpk(fileBytes, path = "models/tri.vmdl_c") {
  const [folder, file] = (() => {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const ext = path.slice(dot + 1);
    const name = path.slice(slash + 1, dot);
    const dir = slash >= 0 ? path.slice(0, slash) : " ";
    return [dir, { ext, name }];
  })();
  const enc = new TextEncoder();
  const tree = concat([
    enc.encode(`${file.ext}\0`),
    enc.encode(`${folder}\0`),
    enc.encode(`${file.name}\0`),
    (() => {
      const entry = new Uint8Array(18);
      const view = new DataView(entry.buffer);
      view.setUint16(6, 0x7fff, true);
      view.setUint32(8, 0, true);
      view.setUint32(12, fileBytes.length, true);
      view.setUint16(16, 0xffff, true);
      return entry;
    })(),
    enc.encode("\0\0\0"),
  ]);
  const header = new Uint8Array(28);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x55aa1234, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, tree.length, true);
  view.setUint32(12, fileBytes.length, true);
  return concat([header, tree, fileBytes]);
}
