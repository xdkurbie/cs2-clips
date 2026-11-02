import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decryptString, encryptString, openSession, sealSession } from "../src/secrets.js";
import { steamIdFromClaimed, steamLoginUrl, verifyAssertion } from "../src/openid.js";
import { openDatabaseReady, userApi } from "../src/db.js";

test("session cookie round trip rejects tampering", () => {
  const token = sealSession({ steamid: "76561198000000000", name: "A" }, "session-secret", 1_700_000_000_000);
  const opened = openSession(token, "session-secret", 1_700_000_000_000);
  assert.equal(opened.steamid, "76561198000000000");
  assert.equal(openSession(token, "other-secret", 1_700_000_000_000), null);
  assert.equal(openSession(token, "session-secret", opened.exp + 1), null);
});

test("auth codes encrypt at rest and are not the ciphertext", () => {
  const code = "ABCD-EFGHI-JKLM";
  const blob = encryptString(code, "encryption-secret");
  assert.equal(blob.includes(code), false);
  assert.equal(decryptString(blob, "encryption-secret"), code);
  assert.throws(() => decryptString(blob, "wrong"));
});

test("openid check_authentication extracts the steamid", async () => {
  const claimed = "https://steamcommunity.com/openid/id/76561198000000000";
  assert.equal(steamIdFromClaimed(claimed), "76561198000000000");
  const url = steamLoginUrl({ returnTo: "https://api.example/callback", realm: "https://api.example/" });
  assert.match(url, /openid\.mode=checkid_setup/);
  const steamid = await verifyAssertion(
    { "openid.claimed_id": claimed, "openid.mode": "id_res" },
    async (_url, body) => {
      assert.match(body, /openid\.mode=check_authentication/);
      assert.doesNotMatch(body, /ABCD-EFGHI-JKLM/);
      return { status: 200, body: "is_valid:true\n" };
    },
  );
  assert.equal(steamid, "76561198000000000");
  await assert.rejects(() => verifyAssertion({ "openid.claimed_id": claimed }, async () => ({ status: 200, body: "is_valid:false\n" })));
});

test("sqlite stores credentials encrypted and a user can delete them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs2db-"));
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const db = await openDatabaseReady(dir);
  const users = userApi(db);
  await users.upsertProfile({ steamid: "76561198000000000", name: "A", avatar: "" });
  const enc = encryptString("ABCD-EFGHI-JKLM", "k");
  const share = encryptString("CSGO-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", "k");
  await users.setSecrets("76561198000000000", enc, share);
  const row = await users.get("76561198000000000");
  assert.equal(row.auth_enc.includes("ABCD"), false);
  await users.clearSecrets("76561198000000000");
  const cleared = await users.get("76561198000000000");
  assert.equal(cleared.auth_enc, null);
  if (prev) process.env.DATABASE_URL = prev;
});
