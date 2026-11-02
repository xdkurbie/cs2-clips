/**
 * Binary KeyValues3 reader for compiled Source 2 DATA blocks.
 * Versions and type tags follow ValveResourceFormat (MIT) and source2.wiki (CC BY-SA).
 * This file is an original reader, not a copy of that project.
 */

import { decompress } from "fzstd";
import { Cursor, alignUp } from "./cursor.js";
import { lz4Block } from "./lz4.js";

const MAGIC0 = 0x03564b56;
const MAGIC_BASE = 0x4b563300;

const TYPE = {
  NULL: 1,
  BOOLEAN: 2,
  INT64: 3,
  UINT64: 4,
  DOUBLE: 5,
  STRING: 6,
  BINARY_BLOB: 7,
  ARRAY: 8,
  OBJECT: 9,
  ARRAY_TYPED: 10,
  INT32: 11,
  UINT32: 12,
  BOOLEAN_TRUE: 13,
  BOOLEAN_FALSE: 14,
  INT64_ZERO: 15,
  INT64_ONE: 16,
  DOUBLE_ZERO: 17,
  DOUBLE_ONE: 18,
  FLOAT: 19,
  INT16: 20,
  UINT16: 21,
  INT8: 22,
  UINT8: 23,
  ARRAY_TYPE_BYTE_LENGTH: 24,
  ARRAY_TYPE_AUXILIARY_BUFFER: 25,
  UINT32_ZERO: 26,
  UINT32_ONE: 27,
};

function lane(bytes) {
  return { b: bytes || new Uint8Array(), i: 0 };
}

function take(slot, n) {
  if (!slot || slot.i + n > slot.b.length) throw new Error("kv3_truncated");
  const s = slot.b.subarray(slot.i, slot.i + n);
  slot.i += n;
  return s;
}

function takeU8(slot) {
  return take(slot, 1)[0];
}

function takeI32(slot) {
  const s = take(slot, 4);
  return new DataView(s.buffer, s.byteOffset, 4).getInt32(0, true);
}

function takeU32(slot) {
  const s = take(slot, 4);
  return new DataView(s.buffer, s.byteOffset, 4).getUint32(0, true);
}

function takeF32(slot) {
  const s = take(slot, 4);
  return new DataView(s.buffer, s.byteOffset, 4).getFloat32(0, true);
}

function takeF64(slot) {
  const s = take(slot, 8);
  return new DataView(s.buffer, s.byteOffset, 8).getFloat64(0, true);
}

function takeI16(slot) {
  const s = take(slot, 2);
  return new DataView(s.buffer, s.byteOffset, 2).getInt16(0, true);
}

function takeU16(slot) {
  const s = take(slot, 2);
  return new DataView(s.buffer, s.byteOffset, 2).getUint16(0, true);
}

function readStrings(slot, count) {
  const strings = new Array(count);
  for (let i = 0; i < count; i++) {
    const start = slot.i;
    while (slot.i < slot.b.length && slot.b[slot.i] !== 0) slot.i += 1;
    strings[i] = new TextDecoder().decode(slot.b.subarray(start, slot.i));
    slot.i += 1;
  }
  return strings;
}

function sliceCount(bytes, offset, count, width) {
  const start = offset;
  const end = offset + count * width;
  return { bytes: bytes.subarray(start, end), next: end };
}

async function inflate(method, compressed, size) {
  if (method === 0) return compressed.subarray(0, size);
  const output = new Uint8Array(size);
  if (method === 1) {
    lz4Block(compressed, output, 0);
    return output;
  }
  if (method === 2) {
    const out = decompress(compressed);
    if (out.length !== size) throw new Error("kv3_zstd");
    return out;
  }
  throw new Error("kv3_compression");
}

function readHeader(c, version) {
  c.skip(16);
  const compression = c.u32();
  const header = {
    version,
    compression,
    countBytes1: 0,
    countBytes2: 0,
    countBytes4: 0,
    countBytes8: 0,
    countTypes: 0,
    countBlocks: 0,
    sizeBinaryBlobsBytes: 0,
    sizeUncompressedTotal: 0,
    sizeCompressedTotal: 0,
    sizeUncompressedBuffer1: 0,
    sizeCompressedBuffer1: 0,
    sizeUncompressedBuffer2: 0,
    sizeCompressedBuffer2: 0,
    countBytes1Buffer2: 0,
    countBytes2Buffer2: 0,
    countBytes4Buffer2: 0,
    countBytes8Buffer2: 0,
    countObjectsBuffer2: 0,
    sizeBlockCompressedSizesBytes: 0,
  };
  if (version === 1) {
    header.countBytes1 = c.i32();
    header.countBytes4 = c.i32();
    header.countBytes8 = c.i32();
    header.sizeUncompressedTotal = c.i32();
    header.sizeUncompressedBuffer1 = header.sizeUncompressedTotal;
    header.sizeCompressedBuffer1 = 0;
  } else {
    const dictionary = c.u16();
    if (dictionary !== 0) throw new Error("kv3_dictionary");
    const frame = c.u16();
    if (compression === 1 && frame === 0) throw new Error("kv3_frame");
    if (compression !== 1 && frame !== 0) throw new Error("kv3_frame");
    header.countBytes1 = c.i32();
    header.countBytes4 = c.i32();
    header.countBytes8 = c.i32();
    header.countTypes = c.i32();
    c.u16();
    c.u16();
    header.sizeUncompressedTotal = c.i32();
    header.sizeCompressedTotal = c.i32();
    header.countBlocks = c.i32();
    header.sizeBinaryBlobsBytes = c.i32();
  }
  if (version >= 4) {
    header.countBytes2 = c.i32();
    header.sizeBlockCompressedSizesBytes = c.i32();
  }
  if (version >= 5) {
    header.sizeUncompressedBuffer1 = c.i32();
    header.sizeCompressedBuffer1 = c.i32();
    header.sizeUncompressedBuffer2 = c.i32();
    header.sizeCompressedBuffer2 = c.i32();
    header.countBytes1Buffer2 = c.i32();
    header.countBytes2Buffer2 = c.i32();
    header.countBytes4Buffer2 = c.i32();
    header.countBytes8Buffer2 = c.i32();
    c.i32();
    header.countObjectsBuffer2 = c.i32();
    c.i32();
    c.i32();
  } else {
    header.sizeUncompressedBuffer1 = header.sizeUncompressedTotal;
    header.sizeCompressedBuffer1 = version === 1 ? header.sizeUncompressedTotal : header.sizeCompressedTotal;
  }
  header.decompressedBuffer1 = version < 5 && compression === 2
    ? header.sizeUncompressedBuffer1 + header.sizeBinaryBlobsBytes
    : header.sizeUncompressedBuffer1;
  return header;
}

function splitLanes(bytes, counts, version) {
  let offset = 0;
  const out = { bytes1: lane(), bytes2: lane(), bytes4: lane(), bytes8: lane() };
  if (counts.countBytes1 > 0) {
    const part = sliceCount(bytes, offset, counts.countBytes1, 1);
    out.bytes1 = lane(part.bytes);
    offset = part.next;
  }
  if (counts.countBytes2 > 0) {
    offset = alignUp(offset, 2);
    const part = sliceCount(bytes, offset, counts.countBytes2, 2);
    out.bytes2 = lane(part.bytes);
    offset = part.next;
  }
  if (counts.countBytes4 > 0) {
    offset = alignUp(offset, 4);
    const part = sliceCount(bytes, offset, counts.countBytes4, 4);
    out.bytes4 = lane(part.bytes);
    offset = part.next;
  }
  if (counts.countBytes8 > 0) {
    offset = alignUp(offset, 8);
    const part = sliceCount(bytes, offset, counts.countBytes8, 8);
    out.bytes8 = lane(part.bytes);
    offset = part.next;
  } else if (version < 5) {
    offset = alignUp(offset, 8);
  }
  out.rest = bytes.subarray(offset);
  out.offset = offset;
  return out;
}

function readType(ctx) {
  let databyte = ctx.types[ctx.typeAt++];
  if (ctx.version >= 3) {
    if (databyte & 0x80) ctx.typeAt += 1;
    if (databyte & 0x40) ctx.typeAt += 1;
    databyte &= 0x3f;
  } else if (databyte & 0x80) {
    ctx.typeAt += 1;
    databyte &= 0x7f;
  }
  return databyte;
}

function stringAt(ctx, id) {
  return id >= 0 && id < ctx.strings.length ? ctx.strings[id] : "";
}

function readPacked(type, count, slot) {
  if (type === TYPE.FLOAT) {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = takeF32(slot.bytes4);
    return out;
  }
  if (type === TYPE.INT32) {
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = takeI32(slot.bytes4);
    return out;
  }
  if (type === TYPE.UINT32) {
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = takeU32(slot.bytes4);
    return out;
  }
  if (type === TYPE.INT16) {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = takeI16(slot.bytes2);
    return out;
  }
  if (type === TYPE.UINT16) {
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = takeU16(slot.bytes2);
    return out;
  }
  if (type === TYPE.DOUBLE) {
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = takeF64(slot.bytes8);
    return out;
  }
  return null;
}

function readValue(ctx, type, slot) {
  switch (type) {
    case TYPE.NULL: return null;
    case TYPE.BOOLEAN_TRUE: return true;
    case TYPE.BOOLEAN_FALSE: return false;
    case TYPE.INT64_ZERO: return 0;
    case TYPE.INT64_ONE: return 1;
    case TYPE.DOUBLE_ZERO: return 0;
    case TYPE.DOUBLE_ONE: return 1;
    case TYPE.UINT32_ZERO: return 0;
    case TYPE.UINT32_ONE: return 1;
    case TYPE.BOOLEAN: return takeU8(slot.bytes1) !== 0;
    case TYPE.INT8: return (takeU8(slot.bytes1) << 24) >> 24;
    case TYPE.UINT8: return takeU8(slot.bytes1);
    case TYPE.INT16: return takeI16(slot.bytes2);
    case TYPE.UINT16: return takeU16(slot.bytes2);
    case TYPE.INT32: return takeI32(slot.bytes4);
    case TYPE.UINT32: return takeU32(slot.bytes4);
    case TYPE.FLOAT: return takeF32(slot.bytes4);
    case TYPE.INT64: {
      const s = take(slot.bytes8, 8);
      return Number(new DataView(s.buffer, s.byteOffset, 8).getBigInt64(0, true));
    }
    case TYPE.UINT64: {
      const s = take(slot.bytes8, 8);
      return Number(new DataView(s.buffer, s.byteOffset, 8).getBigUint64(0, true));
    }
    case TYPE.DOUBLE: return takeF64(slot.bytes8);
    case TYPE.STRING: return stringAt(ctx, takeI32(ctx.buffer.bytes4));
    case TYPE.BINARY_BLOB: {
      if (ctx.version < 2) {
        const n = takeI32(ctx.buffer.bytes4);
        return n > 0 ? take(ctx.buffer.bytes1, n) : new Uint8Array();
      }
      return ctx.blobs[ctx.blobAt++] || new Uint8Array();
    }
    case TYPE.ARRAY: {
      const n = takeI32(ctx.buffer.bytes4);
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = readMember(ctx, true);
      return arr;
    }
    case TYPE.ARRAY_TYPED:
    case TYPE.ARRAY_TYPE_BYTE_LENGTH:
    case TYPE.ARRAY_TYPE_AUXILIARY_BUFFER: {
      const n = type === TYPE.ARRAY_TYPED ? takeI32(ctx.buffer.bytes4) : takeU8(ctx.buffer.bytes1);
      const sub = readType(ctx);
      const elementLane = type === TYPE.ARRAY_TYPE_AUXILIARY_BUFFER ? ctx.aux : ctx.buffer;
      const packed = readPacked(sub, n, elementLane);
      if (packed) return packed;
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = readValue(ctx, sub, elementLane);
      return arr;
    }
    case TYPE.OBJECT: {
      const n = ctx.version >= 5 ? takeI32(ctx.objectLengths) : takeI32(ctx.buffer.bytes4);
      const obj = {};
      for (let i = 0; i < n; i++) {
        const [key, value] = readMember(ctx, false);
        obj[key] = value;
      }
      return obj;
    }
    default:
      throw new Error(`kv3_type_${type}`);
  }
}

function readMember(ctx, inArray) {
  const type = readType(ctx);
  if (inArray) return readValue(ctx, type, ctx.buffer);
  const name = stringAt(ctx, takeI32(ctx.buffer.bytes4));
  return [name, readValue(ctx, type, ctx.buffer)];
}

async function readBlobs(c, header, blobLengths) {
  const blobs = blobLengths.map((n) => new Uint8Array(n));
  if (header.compression === 0) {
    for (const blob of blobs) {
      const src = c.bytes(blob.length);
      blob.set(src);
    }
  } else if (header.compression === 2 && header.version >= 5) {
    const compressedSize = header.sizeCompressedTotal - header.sizeCompressedBuffer1 - header.sizeCompressedBuffer2;
    const compressed = c.bytes(compressedSize);
    const raw = decompress(compressed);
    let at = 0;
    for (const blob of blobs) {
      blob.set(raw.subarray(at, at + blob.length));
      at += blob.length;
    }
  } else if (header.compression === 1) {
    let at = 0;
    const all = new Uint8Array(header.sizeBinaryBlobsBytes);
    for (const blob of blobs) {
      while (at < blob.length) {
        const frameLen = c.u16();
        const frame = c.bytes(frameLen);
        const wrote = lz4Block(frame, all, at);
        at += wrote;
      }
      blob.set(all.subarray(0, blob.length));
    }
  }
  const trailer = c.u32();
  if (trailer !== 0xffeedd00) throw new Error("kv3_trailer");
  return blobs;
}

export async function readKv3(bytes) {
  const c = new Cursor(bytes);
  const magic = c.u32();
  if (magic === MAGIC0) throw new Error("kv3_legacy");
  const version = magic & 0xff;
  if ((magic & 0xffffff00) !== MAGIC_BASE || version < 1 || version > 5) throw new Error("kv3_magic");
  const header = readHeader(c, version);
  const compressed1 = header.compression === 0
    ? c.bytes(header.decompressedBuffer1)
    : c.bytes(header.version >= 5 ? header.sizeCompressedBuffer1 : header.sizeCompressedBuffer1 || header.sizeCompressedTotal);
  const buffer1 = await inflate(header.compression, compressed1, header.decompressedBuffer1);
  const lanes1 = splitLanes(buffer1.subarray(0, header.sizeUncompressedBuffer1), header, version);
  const stringCount = takeI32(lanes1.bytes4);
  const strings = version >= 5
    ? readStrings(lanes1.bytes1, stringCount)
    : readStrings(lane(lanes1.rest), stringCount);

  const ctx = {
    version,
    strings,
    buffer: lanes1,
    aux: lanes1,
    types: null,
    typeAt: 0,
    blobs: [],
    blobAt: 0,
    objectLengths: lane(),
  };

  let typesBytes;
  let blobSizeBytes = new Uint8Array();
  if (version >= 5) {
    const compressed2 = header.compression === 0
      ? c.bytes(header.sizeUncompressedBuffer2)
      : c.bytes(header.sizeCompressedBuffer2);
    const buffer2 = await inflate(header.compression, compressed2, header.sizeUncompressedBuffer2);
    const objectBytes = buffer2.subarray(0, header.countObjectsBuffer2 * 4);
    ctx.objectLengths = lane(objectBytes);
    const lanes2 = splitLanes(buffer2.subarray(objectBytes.length), {
      countBytes1: header.countBytes1Buffer2,
      countBytes2: header.countBytes2Buffer2,
      countBytes4: header.countBytes4Buffer2,
      countBytes8: header.countBytes8Buffer2,
    }, 5);
    ctx.buffer = lanes2;
    typesBytes = lanes2.rest.subarray(0, header.countTypes);
    blobSizeBytes = lanes2.rest.subarray(header.countTypes);
  } else {
    const afterStrings = strings.reduce((n, s) => n + new TextEncoder().encode(s).length + 1, 0);
    const rest = lanes1.rest.subarray(afterStrings);
    const typesLength = version === 1
      ? header.sizeUncompressedTotal - lanes1.offset - afterStrings - 4
      : header.countTypes - afterStrings;
    typesBytes = rest.subarray(0, Math.max(0, typesLength));
    blobSizeBytes = rest.subarray(Math.max(0, typesLength));
  }
  ctx.types = typesBytes;

  if (header.countBlocks > 0) {
    const view = new DataView(blobSizeBytes.buffer, blobSizeBytes.byteOffset, blobSizeBytes.byteLength);
    const lengths = [];
    for (let i = 0; i < header.countBlocks; i++) lengths.push(view.getInt32(i * 4, true));
    const trailerAt = header.countBlocks * 4;
    if (view.getUint32(trailerAt, true) !== 0xffeedd00) throw new Error("kv3_trailer");
    ctx.blobs = await readBlobs(c, header, lengths);
  }

  const root = readType(ctx);
  return readValue(ctx, root, ctx.buffer);
}

export { TYPE };
