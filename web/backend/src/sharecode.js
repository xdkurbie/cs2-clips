/**
 * CSGO/CS2 match share codes: CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx.
 * Same layout as crates/core/src/sharecode.rs — 18 bytes, base 57, least
 * significant digit first in the code string.
 */

const ALPHABET = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

export class ShareCodeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function readU64LE(bytes, offset) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[offset + i]);
  return n;
}

export function decode(code) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed.startsWith("CSGO-")) throw new ShareCodeError("format");
  const groups = trimmed.slice(5).split("-");
  if (groups.length !== 5 || groups.some((g) => g.length !== 5)) throw new ShareCodeError("format");
  const chars = groups.join("");
  let n = 0n;
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = ALPHABET.indexOf(chars[i]);
    if (d < 0) throw new ShareCodeError("char");
    n = n * 57n + BigInt(d);
  }
  const hex = n.toString(16);
  if (hex.length > 36) throw new ShareCodeError("overflow");
  const padded = hex.padStart(36, "0");
  const bytes = new Uint8Array(18);
  for (let i = 0; i < 18; i++) bytes[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return {
    matchId: readU64LE(bytes, 0).toString(),
    outcomeId: readU64LE(bytes, 8).toString(),
    token: bytes[16] | (bytes[17] << 8),
  };
}

export function encode({ matchId, outcomeId, token }) {
  const bytes = new Uint8Array(18);
  writeU64LE(bytes, 0, BigInt(matchId));
  writeU64LE(bytes, 8, BigInt(outcomeId));
  const t = Number(token) & 0xffff;
  bytes[16] = t & 0xff;
  bytes[17] = (t >> 8) & 0xff;
  let n = 0n;
  for (let i = 0; i < 18; i++) n = (n << 8n) | BigInt(bytes[i]);
  let s = "";
  for (let i = 0; i < 25; i++) {
    if (i % 5 === 0) s += "-";
    const r = n % 57n;
    n /= 57n;
    s += ALPHABET[Number(r)];
  }
  return `CSGO${s}`;
}

function writeU64LE(bytes, offset, value) {
  let n = BigInt(value);
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}

export function isValid(code) {
  try {
    decode(code);
    return true;
  } catch {
    return false;
  }
}
