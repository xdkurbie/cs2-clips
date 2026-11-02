import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "cs2clips_session";

function keyFrom(secret) {
  return createHash("sha256").update(String(secret)).digest();
}

export function encryptString(plain, secret) {
  if (!secret) throw Object.assign(new Error("missing_encryption_key"), { code: "missing_encryption_key" });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString("base64url");
}

export function decryptString(blob, secret) {
  if (!secret || !blob) return "";
  const buf = Buffer.from(blob, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function sealSession(payload, secret, now = Date.now()) {
  if (!secret) throw Object.assign(new Error("missing_session_secret"), { code: "missing_session_secret" });
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + 14 * 24 * 3600 * 1000 })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function openSession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data?.steamid || !data.exp || data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}

export function readCookie(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function sessionFromRequest(req) {
  return openSession(readCookie(req), process.env.SESSION_SECRET || "");
}

export function cookieHeader(token, { secure }) {
  const flags = secure
    ? "HttpOnly; Secure; SameSite=None; Path=/; Max-Age=1209600"
    : "HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600";
  return `${COOKIE}=${encodeURIComponent(token)}; ${flags}`;
}

export function clearCookieHeader(secure) {
  const flags = secure
    ? "HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0"
    : "HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
  return `${COOKIE}=; ${flags}`;
}

export { COOKIE };
