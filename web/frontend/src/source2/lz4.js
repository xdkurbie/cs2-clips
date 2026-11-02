/**
 * LZ4 block decode. Matches may look back into bytes already written,
 * so chained frames keep writing into one output buffer.
 */

export function lz4Block(input, output, outStart = 0) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  let ip = 0;
  let op = outStart;
  const end = outStart + (output.length - outStart);
  while (ip < src.length && op < output.length) {
    const token = src[ip++];
    let lit = token >> 4;
    if (lit === 15) {
      let more;
      do {
        more = src[ip++];
        lit += more;
      } while (more === 255);
    }
    output.set(src.subarray(ip, ip + lit), op);
    ip += lit;
    op += lit;
    if (ip >= src.length || op >= output.length) break;
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (!offset) throw new Error("lz4");
    let match = (token & 15) + 4;
    if ((token & 15) === 15) {
      let more;
      do {
        more = src[ip++];
        match += more;
      } while (more === 255);
    }
    let from = op - offset;
    const stop = Math.min(output.length, op + match, end);
    while (op < stop) output[op++] = output[from++];
  }
  return op - outStart;
}
