/** Steam OpenID 2.0. Verification is a server-side check_authentication POST. */

const OPENID = "https://steamcommunity.com/openid/login";
const NS = "http://specs.openid.net/auth/2.0";

export function steamLoginUrl({ returnTo, realm }) {
  const u = new URL(OPENID);
  u.searchParams.set("openid.ns", NS);
  u.searchParams.set("openid.mode", "checkid_setup");
  u.searchParams.set("openid.return_to", returnTo);
  u.searchParams.set("openid.realm", realm);
  u.searchParams.set("openid.identity", `${NS}/identifier_select`);
  u.searchParams.set("openid.claimed_id", `${NS}/identifier_select`);
  return u.toString();
}

export function steamIdFromClaimed(claimed) {
  const m = String(claimed || "").match(/\/openid\/id\/(\d{17})$/);
  return m ? m[1] : "";
}

/**
 * @param {Record<string, string>} params query params from the callback
 * @param {(url:string, body:string)=>Promise<{status:number, body:string}>} post
 */
export async function verifyAssertion(params, post) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith("openid.")) continue;
    body.set(k, k === "openid.mode" ? "check_authentication" : v);
  }
  const res = await post(OPENID, body.toString());
  if (res.status !== 200 || !String(res.body).includes("is_valid:true")) {
    throw Object.assign(new Error("steam_openid"), { code: "steam_openid" });
  }
  const steamid = steamIdFromClaimed(params["openid.claimed_id"]);
  if (!steamid) throw Object.assign(new Error("steam_openid"), { code: "steam_openid" });
  return steamid;
}

export async function fetchPlayerSummary(apiKey, steamid, get) {
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${encodeURIComponent(steamid)}`;
  const res = await get(url);
  let name = steamid;
  let avatar = "";
  try {
    const json = JSON.parse(res.body);
    const player = json?.response?.players?.[0];
    if (player?.personaname) name = String(player.personaname);
    avatar = String(player?.avatarfull || player?.avatar || "");
  } catch {
    /* name stays the steamid; the key is not included in the error */
  }
  return { name, avatar };
}
