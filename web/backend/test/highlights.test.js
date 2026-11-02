import test from "node:test";
import assert from "node:assert/strict";
import { detectHighlights, highlightsFor } from "../src/highlights.js";

function kill(tick, round, attacker, victim, extra = {}) {
  return {
    tick,
    round,
    attacker,
    attackerName: attacker,
    attackerTeam: "T",
    victim,
    victimName: victim,
    victimTeam: "CT",
    weapon: extra.weapon || "ak47",
    headshot: !!extra.headshot,
    wallbang: !!extra.wallbang,
    noscope: !!extra.noscope,
    smoke: !!extra.smoke,
    blind: !!extra.blind,
  };
}

const roster = [
  { steamid: "A", name: "A", team: "T" },
  { steamid: "B", name: "B", team: "T" },
  { steamid: "C", name: "C", team: "CT" },
  { steamid: "D", name: "D", team: "CT" },
  { steamid: "E", name: "E", team: "CT" },
];

test("detects multikills, aces, entries and headshot tags", () => {
  const timeline = {
    tickrate: 64,
    rounds: [
      { number: 1, startTick: 100, endTick: 5000, winner: "T", roster },
      { number: 2, startTick: 6000, endTick: 12000, winner: "T", roster },
    ],
    kills: [
      kill(200, 1, "A", "C"),
      kill(400, 1, "A", "D"),
      kill(700, 1, "A", "E", { headshot: true }),
      kill(7000, 2, "A", "C", { headshot: true }),
      kill(7200, 2, "A", "D", { headshot: true }),
      kill(7400, 2, "A", "E", { headshot: true }),
      kill(7600, 2, "A", "B", { headshot: true }),
      kill(7800, 2, "B", "A"), // invalid same? B is T killing A T — filtered
    ].filter((k) => k.attacker !== "B" || k.victim !== "A"),
    bomb: [],
  };
  // Fix the 4th kill of round 2 to a 4th CT by using a synthetic victim still on CT.
  timeline.kills = [
    kill(200, 1, "A", "C"),
    kill(400, 1, "A", "D"),
    kill(700, 1, "A", "E", { headshot: true }),
    kill(7000, 2, "A", "C", { headshot: true }),
    kill(7200, 2, "A", "D", { headshot: true }),
    kill(7400, 2, "A", "E", { headshot: true }),
    kill(7600, 2, "A", "X", { headshot: true }),
    kill(7800, 2, "A", "Y", { headshot: true }),
  ];
  const all = detectHighlights(timeline);
  const a = highlightsFor(timeline, "A");
  assert.ok(a.some((h) => h.kind === "multikill" && h.kills === 3 && h.round === 1));
  assert.ok(a.some((h) => h.kind === "entry" && h.round === 1));
  assert.ok(a.some((h) => h.kind === "ace" && h.round === 2 && h.tags.includes("headshots")));
  assert.ok(all.every((h) => h.startTick <= h.endTick));
});

test("detects a won 1v2 clutch", () => {
  const timeline = {
    tickrate: 64,
    rounds: [{
      number: 1,
      startTick: 0,
      endTick: 4000,
      winner: "T",
      roster: [
        { steamid: "A", name: "Ace", team: "T" },
        { steamid: "B", name: "B", team: "T" },
        { steamid: "C", name: "C", team: "CT" },
        { steamid: "D", name: "D", team: "CT" },
      ],
    }],
    kills: [
      kill(500, 1, "C", "B"),
      kill(800, 1, "A", "C"),
      kill(1100, 1, "A", "D"),
    ].map((k) => (k.attacker === "C" ? { ...k, attackerTeam: "CT", victimTeam: "T" } : k)),
    bomb: [],
  };
  const found = highlightsFor(timeline, "A").filter((h) => h.kind === "clutch");
  assert.equal(found.length, 1);
  assert.equal(found[0].enemies, 2);
  assert.ok(found[0].eventStart >= 500);
});
