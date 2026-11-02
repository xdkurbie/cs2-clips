import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode } from "../src/sharecode.js";

const CODE = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";

test("decodes the published share code vector", () => {
  const sc = decode(CODE);
  assert.equal(sc.matchId, "3230642215713767580");
  assert.equal(sc.outcomeId, "3230647599455273103");
  assert.equal(sc.token, 55788);
});

test("round-trips share codes", () => {
  assert.equal(encode(decode(CODE)), CODE);
  for (const sc of [
    { matchId: "0", outcomeId: "0", token: 0 },
    { matchId: "1", outcomeId: "2", token: 3 },
    { matchId: "18446744073709551615", outcomeId: "18446744073709551615", token: 65535 },
  ]) {
    assert.deepEqual(decode(encode(sc)), { ...sc, token: sc.token });
  }
});

test("rejects malformed codes", () => {
  assert.throws(() => decode("CSGO-abc"), /format/);
  assert.throws(() => decode("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x0"), /char/);
});
