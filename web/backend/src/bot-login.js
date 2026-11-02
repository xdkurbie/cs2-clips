/**
 * One-time login for the dedicated Steam bot. Prints a refresh token to stdout.
 * Run locally: STEAM_BOT_USERNAME=... STEAM_BOT_PASSWORD=... npm run bot-login -w backend
 * The password is read from the environment and never written to disk by this script.
 * If Steam Guard asks, type the code from email or the mobile authenticator.
 */

import readline from "node:readline";

const account = process.env.STEAM_BOT_USERNAME || "";
const password = process.env.STEAM_BOT_PASSWORD || "";
if (!account || !password) {
  console.error("Set STEAM_BOT_USERNAME and STEAM_BOT_PASSWORD in the environment.");
  process.exit(1);
}

const userMod = await import("steam-user");
const totpMod = await import("steam-totp");
const SteamUser = userMod.default || userMod;
const SteamTotp = totpMod.default || totpMod;
const user = new SteamUser();

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

user.on("steamGuard", async (domain, callback) => {
  const secret = process.env.STEAM_BOT_SHARED_SECRET;
  if (secret && !domain) {
    callback(SteamTotp.generateAuthCode(secret));
    return;
  }
  const code = await ask(domain ? `Email code (${domain}): ` : "Steam Guard code: ");
  callback(code);
});

user.on("refreshToken", (token) => {
  console.log(token);
  process.exit(0);
});

user.on("error", (err) => {
  console.error(err?.message || "login failed");
  process.exit(1);
});

user.logOn({ accountName: account, password });
