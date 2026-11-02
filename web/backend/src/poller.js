import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { walkMatches, SteamError } from "./steam.js";
import { decryptString, encryptString } from "./secrets.js";
import { fetchDemoForCode, isFriend, notifyMatchReady } from "./gcWorker.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll linked friends for newer share codes, download demos through the bot's
 * Game Coordinator session, and parse them. Auth codes are decrypted only in
 * memory and are never logged.
 */
export function startMatchPoller({ db, users, store }) {
  const interval = Number(process.env.POLL_INTERVAL_MS || 180000);
  let running = false;
  const tick = async () => {
    if (running) return;
    if (!process.env.STEAM_WEB_API_KEY || !process.env.ENCRYPTION_KEY) return;
    running = true;
    try {
      await pollOnce({ db, users, store });
    } catch (err) {
      console.error("match poll failed", err?.code || "error");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, interval);
  timer.unref?.();
  setTimeout(tick, 15000).unref?.();
  return () => clearInterval(timer);
}

export async function pollOnce({ users, store }) {
  const rows = await users.usersToPoll();
  let delay = 1200;
  for (const row of rows) {
    if (!isFriend(row.steamid)) continue;
    let auth = "";
    let known = "";
    try {
      auth = decryptString(row.auth_enc, process.env.ENCRYPTION_KEY);
      known = decryptString(row.share_enc, process.env.ENCRYPTION_KEY);
    } catch {
      continue;
    }
    if (!auth || !known) continue;
    let matches;
    try {
      matches = await walkMatches({
        apiKey: process.env.STEAM_WEB_API_KEY,
        steamid64: row.steamid,
        authCode: auth,
        knownCode: known,
        limit: 3,
        http: async (url) => {
          const response = await fetch(url);
          return { status: response.status, body: await response.text() };
        },
      });
    } catch (err) {
      if (err instanceof SteamError && err.code === "rate_limited") {
        await sleep(60000);
        return;
      }
      await sleep(delay);
      continue;
    }
    let latest = known;
    for (const match of matches) {
      const fresh = await users.rememberCode(row.steamid, match.code);
      if (!fresh) {
        latest = match.code;
        continue;
      }
      const dest = path.join(os.tmpdir(), `cs2clips-${crypto.randomBytes(8).toString("hex")}.dem.bz2`);
      let keepSeen = false;
      try {
        await fetchDemoForCode(match.code, dest);
        const { meta } = await store.createFromDemo(dest, { steamid: row.steamid });
        await users.addMatch({
          id: meta.id,
          steamid: row.steamid,
          map: meta.map,
          created: meta.created,
          source: "auto",
        });
        keepSeen = true;
        if (Number(row.chat_notify)) {
          const front = (process.env.FRONTEND_URL || "https://xdkurbie.github.io/cs2-clips").replace(/\/$/, "");
          notifyMatchReady(row.steamid, `New CS2 demo ready: ${front}#/m/${meta.id}`);
        }
      } catch (err) {
        keepSeen = err?.code === "unavailable" || err?.code === "gc_unconfigured";
        console.error("auto demo skipped", err?.code || "error");
      } finally {
        if (!keepSeen) {
          await users.forgetCode?.(row.steamid, match.code);
        } else {
          latest = match.code;
        }
        await import("node:fs/promises").then((fs) => fs.rm(dest, { force: true })).catch(() => {});
      }
      if (!keepSeen) break;
      await sleep(delay);
    }
    if (latest !== known) {
      await users.setSecrets(row.steamid, row.auth_enc, encryptString(latest, process.env.ENCRYPTION_KEY));
    }
    await sleep(delay);
  }
}
