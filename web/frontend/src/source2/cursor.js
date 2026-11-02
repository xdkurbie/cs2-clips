/** Little-endian cursor over a byte view. */

export class Cursor {
  constructor(bytes, offset = 0) {
    this.b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.o = offset;
    this.view = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
  }

  get left() {
    return this.b.length - this.o;
  }

  u8() {
    return this.b[this.o++];
  }

  u16() {
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }

  i16() {
    const v = this.view.getInt16(this.o, true);
    this.o += 2;
    return v;
  }

  u32() {
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }

  i32() {
    const v = this.view.getInt32(this.o, true);
    this.o += 4;
    return v;
  }

  f32() {
    const v = this.view.getFloat32(this.o, true);
    this.o += 4;
    return v;
  }

  f64() {
    const v = this.view.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }

  bytes(n) {
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }

  skip(n) {
    this.o += n;
  }

  seek(n) {
    this.o = n;
  }

  cstring(max) {
    const start = this.o;
    const end = Math.min(this.b.length, start + max);
    let i = start;
    while (i < end && this.b[i] !== 0) i += 1;
    const text = new TextDecoder().decode(this.b.subarray(start, i));
    this.o = i < end ? i + 1 : end;
    return text;
  }
}

export function alignUp(value, alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}
