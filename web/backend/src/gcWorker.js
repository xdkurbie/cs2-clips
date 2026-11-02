/**
 * Logged-in CS2 Game Coordinator worker.
 * Credentials come only from the environment and are never logged.
 * Without them the process still serves uploads; demo fetch returns gc_unconfigured.
 */

import fs from "node:fs/promises";
import { demoCandidates, describeMatch, downloadFirstWorking } from "./gcUrl.js";

let state = {
  status: "unconfigured",
  detail: "Set STEAM_BOT_REFRESH_TOKEN, or STEAM_BOT_USERNAME and STEAM_BOT_PASSWORD",
};

let starting = null;
let csgo = null;
let botUser = null;
let botSteamId = "";
let queue = Promise.resolve();

const FRIEND = 3;
const REQUEST_RECIPIENT = 2;

export function gcStatus() {
  return {
    status: state.status,
    detail: state.detail,
    configured: state.status !== "unconfigured",
    botSteamId,
  };
}

export function botProfile() {
  const url = process.env.STEAM_BOT_PROFILE_URL
    || (botSteamId ? `https://steamcommunity.com/profiles/${botSteamId}` : "");
  return {
    url,
    steamid: botSteamId,
    online: state.status === "ready" || state.status === "starting",
    limitedAccountNote: "A limited Steam account can accept friend requests but cannot send them. The bot only accepts, so the user sends the invite.",
  };
}

export function isFriend(steamid64) {
  if (!botUser?.myFriends || !steamid64) return false;
  return botUser.myFriends[steamid64] === FRIEND;
}

export function notifyMatchReady(steamid64, text) {
  try {
    botUser?.chat?.sendFriendMessage?.(steamid64, String(text).slice(0, 400));
  } catch {
    /* chat is optional */
  }
}

export function startGcWorker() {
  const refresh = process.env.STEAM_BOT_REFRESH_TOKEN || "";
  const account = process.env.STEAM_BOT_USERNAME || "";
  const password = process.env.STEAM_BOT_PASSWORD || "";
  if (!refresh && !(account && password)) return;
  if (starting) return;
  starting = (async () => {
    try {
      const userMod = await import("steam-user");
      const gcMod = await import("globaloffensive");
      const totpMod = await import("steam-totp");
      const SteamUser = userMod.default || userMod;
      const GlobalOffensive = gcMod.default || gcMod;
      const SteamTotp = totpMod.default || totpMod;
      const user = new SteamUser();
      botUser = user;
      csgo = new GlobalOffensive(user);
      user.on("error", () => {
        state = { status: "error", detail: "Steam login failed. Check the bot credentials.", botSteamId };
      });
      user.on("friendRelationship", (sid, relationship) => {
        const incoming = relationship === (SteamUser.EFriendRelationship?.RequestRecipient ?? REQUEST_RECIPIENT);
        if (!incoming) return;
        try { user.addFriend(sid); } catch { /* already handled or rate limited */ }
      });
      user.on("loggedOn", () => {
        botSteamId = user.steamID?.getSteamID64?.() || botSteamId;
        state = { status: "starting", detail: "Logged on. Connecting to the Game Coordinator.", botSteamId };
        user.setPersona(SteamUser.EPersonaState?.Online ?? 1);
        user.gamesPlayed([730]);
      });
      user.on("disconnected", () => {
        if (state.status !== "unconfigured") {
          state = { status: "starting", detail: "Steam session dropped. Reconnecting.", botSteamId };
        }
      });
      csgo.on("connectedToGC", () => {
        state = { status: "ready", detail: "Connected to the CS2 Game Coordinator." };
      });
      csgo.on("disconnectedFromGC", () => {
        if (state.status === "ready") state = { status: "starting", detail: "Reconnecting to the Game Coordinator." };
      });
      const logOn = {};
      if (refresh) logOn.refreshToken = refresh;
      else {
        logOn.accountName = account;
        logOn.password = password;
        const secret = process.env.STEAM_BOT_SHARED_SECRET;
        if (secret) logOn.twoFactorCode = SteamTotp.generateAuthCode(secret);
      }
      user.logOn(logOn);
    } catch {
      state = { status: "error", detail: "Game Coordinator worker failed to start." };
    }
  })();
}

function requestMatch(shareCode) {
  return new Promise((resolve, reject) => {
    if (!csgo) {
      reject(Object.assign(new Error("gc_unavailable"), { code: "gc_unavailable" }));
      return;
    }
    const timer = setTimeout(() => {
      csgo.removeListener("matchList", onList);
      reject(Object.assign(new Error("gc_timeout"), { code: "gc_timeout" }));
    }, 20000);
    function onList(matches) {
      clearTimeout(timer);
      resolve(matches || []);
    }
    csgo.once("matchList", onList);
    try {
      if (typeof shareCode === "string") csgo.requestGame(shareCode);
      else csgo.requestGame(shareCode);
    } catch {
      clearTimeout(timer);
      csgo.removeListener("matchList", onList);
      reject(Object.assign(new Error("gc_unavailable"), { code: "gc_unavailable" }));
    }
  });
}

async function waitReady() {
  if (state.status === "unconfigured") {
    throw Object.assign(new Error("gc_unconfigured"), { code: "gc_unconfigured" });
  }
  if (starting) await starting;
  const deadline = Date.now() + 20000;
  while (state.status !== "ready" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (state.status !== "ready") {
    throw Object.assign(new Error("gc_unavailable"), { code: state.status === "error" ? "gc_unavailable" : "gc_unavailable" });
  }
}

export async function fetchDemoForCode(shareCode, destPath) {
  const run = async () => {
    await waitReady();
    const matches = await requestMatch(shareCode);
    const described = describeMatch((matches && matches[0]) || {});
    if (described.code !== "ok") {
      throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    }
    const result = await downloadFirstWorking(described.urls, async (url) => fetch(url));
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
    const buf = Buffer.from(await result.res.arrayBuffer());
    if (buf.length < 64) throw Object.assign(new Error("expired"), { code: "expired" });
    await fs.writeFile(destPath, buf);
    return { map: described.map, matchId: described.matchId, bytes: buf.length, candidates: described.urls.length };
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

export { demoCandidates };
