/**
 * Walk newer match share codes via ICSGOPlayers_730/GetNextMatchSharingCode/v1.
 * The API key and auth code are never put in thrown error messages.
 */

import { decode, isValid } from "./sharecode.js";

export const API = "https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1";

export class SteamError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function enc(s) {
  return encodeURIComponent(s);
}

export function checkCredentials({ apiKey, steamid64, authCode }) {
  if (!apiKey || String(apiKey).trim().length !== 32) throw new SteamError("missing_api_key");
  if (!/^\d{17}$/.test(String(steamid64 || "").trim())) throw new SteamError("missing_steamid");
  if (!/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{4}$/.test(String(authCode || "").trim())) {
    throw new SteamError("missing_auth_code");
  }
}

/**
 * @param {object} opts
 * @param {(url:string)=>Promise<{status:number, body:string}>} opts.http
 */
export async function nextCode(opts, known) {
  const apiKey = String(opts.apiKey).trim();
  const steamid64 = String(opts.steamid64).trim();
  const authCode = String(opts.authCode).trim();
  const url = `${API}?key=${enc(apiKey)}&steamid=${enc(steamid64)}&steamidkey=${enc(authCode)}&knowncode=${enc(known.trim())}`;
  let status;
  let body;
  try {
    const res = await opts.http(url);
    status = res.status;
    body = res.body;
  } catch {
    throw new SteamError("network");
  }
  if (status === 202) return null;
  if (status === 403) throw new SteamError("forbidden");
  if (status === 412) throw new SteamError("unknown_code");
  if (status === 429) throw new SteamError("rate_limited");
  if (status !== 200) throw new SteamError("http");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SteamError("bad_response");
  }
  const code = parsed?.result?.nextcode;
  if (!code || code === "n/a") return null;
  if (!isValid(code)) throw new SteamError("bad_response");
  return code;
}

export async function walkMatches(opts) {
  checkCredentials(opts);
  const known = String(opts.knownCode || "").trim();
  if (!isValid(known)) throw new SteamError("missing_share_code");
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 8));
  const out = [];
  let cur = known;
  for (let i = 0; i < limit; i++) {
    const n = await nextCode(opts, cur);
    if (!n) break;
    const decoded = decode(n);
    out.push({ code: n, ...decoded });
    cur = n;
  }
  return out;
}
