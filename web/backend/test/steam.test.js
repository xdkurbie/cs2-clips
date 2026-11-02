import test from "node:test";
import assert from "node:assert/strict";
import { SteamError, walkMatches } from "../src/steam.js";
import { encode } from "../src/sharecode.js";

const known = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";
const creds = {
  apiKey: "a".repeat(32),
  steamid64: "76561198000000000",
  authCode: "ABCD-EFGHI-JKLM",
};

test("walks share codes and stops on HTTP 202", async () => {
  const next = encode({ matchId: "42", outcomeId: "77", token: 9 });
  const seen = [];
  const matches = await walkMatches({
    ...creds,
    knownCode: known,
    limit: 5,
    http: async (url) => {
      seen.push(url);
      assert.equal(url.includes(creds.apiKey), true);
      if (seen.length === 1) {
        return { status: 200, body: JSON.stringify({ result: { nextcode: next } }) };
      }
      return { status: 202, body: "" };
    },
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].code, next);
  assert.equal(matches[0].matchId, "42");
  assert.equal(matches[0].token, 9);
});

test("maps Steam errors without echoing secrets", async () => {
  await assert.rejects(
    () => walkMatches({
      ...creds,
      knownCode: known,
      http: async (url) => {
        throw new Error(`boom ${url}`);
      },
    }),
    (err) => err instanceof SteamError && err.code === "network" && !String(err.message).includes(creds.apiKey),
  );
  await assert.rejects(
    () => walkMatches({
      ...creds,
      knownCode: known,
      http: async () => ({ status: 403, body: "" }),
    }),
    (err) => err.code === "forbidden",
  );
  await assert.rejects(
    () => walkMatches({
      ...creds,
      knownCode: known,
      http: async () => ({ status: 412, body: "" }),
    }),
    (err) => err.code === "unknown_code",
  );
});

test("requires a known share code and credentials", async () => {
  await assert.rejects(() => walkMatches({ ...creds, knownCode: "nope", http: async () => ({ status: 200, body: "{}" }) }), /missing_share_code/);
  await assert.rejects(() => walkMatches({ ...creds, apiKey: "short", knownCode: known, http: async () => ({ status: 200, body: "{}" }) }), /missing_api_key/);
});
