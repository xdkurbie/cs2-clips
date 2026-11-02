/**
 * Vertex and index buffers stored in a VBIB block.
 * On-disk layout follows ValveResourceFormat's VBIB reader (MIT).
 */

import { decompress } from "fzstd";
import { MeshoptDecoder } from "meshoptimizer";
import { Cursor } from "./cursor.js";

const FORMAT = {
  2: { size: 16, read: (v, o) => [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true)] },
  6: { size: 12, read: (v, o) => [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)] },
  10: { size: 8, read: (v, o) => [half(v.getUint16(o, true)), half(v.getUint16(o + 2, true)), half(v.getUint16(o + 4, true)), half(v.getUint16(o + 6, true))] },
  16: { size: 8, read: (v, o) => [v.getFloat32(o, true), v.getFloat32(o + 4, true)] },
  28: { size: 4, read: (v, o) => [v.getUint8(o) / 255, v.getUint8(o + 1) / 255, v.getUint8(o + 2) / 255, v.getUint8(o + 3) / 255] },
  34: { size: 4, read: (v, o) => [half(v.getUint16(o, true)), half(v.getUint16(o + 2, true))] },
  41: { size: 4, read: (v, o) => [v.getFloat32(o, true)] },
  42: { size: 4, read: (v, o) => [v.getUint32(o, true)] },
  57: { size: 2, read: (v, o) => [v.getUint16(o, true)] },
};

function half(value) {
  const sign = (value & 0x8000) ? -1 : 1;
  const exp = (value >> 10) & 0x1f;
  const frac = value & 0x3ff;
  if (exp === 0) return sign * (frac / 1024) * 2 ** -14;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

let meshoptReady;

function meshopt() {
  meshoptReady ??= MeshoptDecoder.ready.then(() => MeshoptDecoder);
  return meshoptReady;
}

async function inflateBuffer(buffer, compressed, isVertex) {
  let bytes = compressed;
  if (buffer.zstd) bytes = decompress(bytes);
  const rawSize = buffer.count * buffer.stride;
  if (!buffer.meshopt) {
    return bytes.subarray(0, rawSize);
  }
  const decoder = await meshopt();
  const out = new Uint8Array(rawSize);
  if (isVertex) decoder.decodeVertexBuffer(out, buffer.count, buffer.stride, bytes);
  else decoder.decodeIndexBuffer(out, buffer.count, buffer.stride, bytes);
  return out;
}

function readFields(c, count) {
  const fields = [];
  for (let i = 0; i < count; i++) {
    const nameStart = c.o;
    const name = c.cstring(32).toUpperCase();
    c.seek(nameStart + 32);
    fields.push({
      name,
      semantic: c.i32(),
      format: c.u32(),
      offset: c.u32(),
      slot: c.i32(),
      slotType: c.u32(),
      step: c.i32(),
    });
  }
  return fields;
}

async function readOnDisk(c, isVertex) {
  const count = c.u32();
  const sizeField = c.i32();
  const stride = sizeField & 0x3ffffff;
  const meshoptCompressed = (sizeField & 0x4000000) === 0;
  const zstd = (sizeField & 0x8000000) !== 0;
  const refA = c.o;
  const attributeOffset = c.u32();
  const attributeCount = c.u32();
  const refB = c.o;
  const dataOffset = c.u32();
  const totalSize = c.i32();
  c.seek(refA + attributeOffset);
  const fields = isVertex ? readFields(c, attributeCount) : [];
  c.seek(refB + dataOffset);
  const stored = c.bytes(totalSize);
  const rawSize = count * stride;
  let data = stored;
  if (rawSize > totalSize) {
    data = await inflateBuffer({ count, stride, meshopt: meshoptCompressed, zstd }, stored, isVertex);
  }
  c.seek(refB + 8);
  return { count, stride, fields, data: data instanceof Uint8Array ? data : new Uint8Array(data) };
}

export async function readVbib(bytes) {
  const c = new Cursor(bytes);
  const vertexOffset = c.u32();
  const vertexCount = c.u32();
  const indexOffset = c.u32();
  const indexCount = c.u32();
  const base = 0;
  const vertices = [];
  c.seek(base + vertexOffset);
  for (let i = 0; i < vertexCount; i++) vertices.push(await readOnDisk(c, true));
  const indices = [];
  c.seek(base + 8 + indexOffset);
  for (let i = 0; i < indexCount; i++) indices.push(await readOnDisk(c, false));
  return { vertices, indices };
}

export function attribute(buffer, semantic) {
  const field = buffer.fields.find((f) => f.name === semantic || f.name.startsWith(semantic));
  if (!field || !FORMAT[field.format]) return null;
  const spec = FORMAT[field.format];
  const view = new DataView(buffer.data.buffer, buffer.data.byteOffset, buffer.data.byteLength);
  const out = new Array(buffer.count);
  for (let i = 0; i < buffer.count; i++) out[i] = spec.read(view, i * buffer.stride + field.offset);
  return out;
}

export function indexArray(buffer) {
  if (!buffer) return null;
  if (buffer.stride === 2) {
    const view = new DataView(buffer.data.buffer, buffer.data.byteOffset, buffer.data.byteLength);
    const out = new Uint32Array(buffer.count);
    for (let i = 0; i < buffer.count; i++) out[i] = view.getUint16(i * 2, true);
    return out;
  }
  if (buffer.stride === 4) return new Uint32Array(buffer.data.buffer, buffer.data.byteOffset, buffer.count);
  return null;
}
