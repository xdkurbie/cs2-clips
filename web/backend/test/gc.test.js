import test from "node:test";
import assert from "node:assert/strict";
import { classifyHttp, demoCandidates, describeMatch, downloadFirstWorking } from "../src/gcUrl.js";

const match = {
  matchid: "3230642215713767580",
  watchablematchinfo: { server_ip: 131 },
  roundstatsall: [{ reservationid: "3230647599455273103", reservation: 131, map: "de_mirage" }],
};

test("builds replay URLs from a GC match payload", () => {
  const urls = demoCandidates(match);
  assert.ok(urls[0].startsWith("http://replay131.valve.net/730/"));
  assert.ok(urls[0].includes("3230642215713767580_3230647599455273103.dem.bz2"));
  const described = describeMatch(match);
  assert.equal(described.code, "ok");
  assert.equal(described.map, "de_mirage");
});

test("prefers a demo URL already present on the payload", () => {
  const urls = demoCandidates({
    matchid: "1",
    roundstatsall: [{ reservationid: "2", reservation: 10 }],
    demo_url: "http://replay10.valve.net/730/explicit.dem.bz2",
  });
  assert.equal(urls[0], "http://replay10.valve.net/730/explicit.dem.bz2");
});

test("empty GC payload is unavailable", () => {
  assert.equal(describeMatch({}).code, "unavailable");
  assert.equal(describeMatch({ matchid: "1" }).code, "unavailable");
});

test("404 means the demo expired", async () => {
  assert.equal(classifyHttp(404), "expired");
  const result = await downloadFirstWorking(
    ["http://replay1.valve.net/730/a.dem.bz2", "http://replay1.valve.net/730/b.dem.bz2"],
    async () => ({ status: 404, res: null }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "expired");
});

test("uses the first live replay URL", async () => {
  const calls = [];
  const result = await downloadFirstWorking(["http://expired", "http://ok"], async (url) => {
    calls.push(url);
    if (url === "http://expired") return { status: 410 };
    return { status: 200, res: { ok: true } };
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, "http://ok");
  assert.deepEqual(calls, ["http://expired", "http://ok"]);
});
