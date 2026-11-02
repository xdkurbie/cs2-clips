/** Rule-based highlights for one parsed timeline. No demo file required. */

const DEFAULTS = {
  windowS: 18,
  preRollS: 3,
  postRollS: 4,
};

function ticks(seconds, tickrate) {
  return Math.round(seconds * tickrate);
}

function validKill(k) {
  return k.attacker && k.attacker !== k.victim && k.attackerTeam && k.attackerTeam !== k.victimTeam;
}

function chains(kills, windowTicks) {
  const out = [];
  for (const k of kills) {
    const last = out[out.length - 1];
    if (last && k.tick - last[last.length - 1].tick <= windowTicks) last.push(k);
    else out.push([k]);
  }
  return out;
}

function sameKillSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].tick !== b[i].tick) return false;
  return true;
}

function tagsOf(kills) {
  const tags = [];
  if (kills.length && kills.every((k) => k.headshot)) tags.push("headshots");
  if (kills.some((k) => k.noscope)) tags.push("noscope");
  if (kills.some((k) => k.wallbang)) tags.push("wallbang");
  if (kills.some((k) => k.smoke)) tags.push("smoke");
  if (kills.some((k) => k.blind)) tags.push("blind");
  return tags;
}

function weaponOf(kills) {
  const counts = new Map();
  for (const k of kills) counts.set(k.weapon || "", (counts.get(k.weapon || "") || 0) + 1);
  let best = "";
  let n = -1;
  for (const [w, c] of counts) {
    if (c > n) {
      best = w;
      n = c;
    }
  }
  return best;
}

function make(partial, tickrate, rules) {
  const pre = ticks(rules.preRollS, tickrate);
  const post = ticks(rules.postRollS, tickrate);
  const first = partial.killTicks[0] ?? partial.clipStart ?? 0;
  const last = partial.killTicks[partial.killTicks.length - 1] ?? partial.clipEnd ?? first;
  const eventStart = partial.clipStart ?? first;
  const eventEnd = partial.clipEnd ?? last;
  return {
    ...partial,
    eventStart,
    eventEnd,
    startTick: Math.max(0, eventStart - pre),
    endTick: eventEnd + post,
    score: partial.score,
  };
}

/**
 * @param {object} timeline parser JSON (without requiring the sample blob)
 * @param {{windowS?:number, preRollS?:number, postRollS?:number}} [rules]
 */
export function detectHighlights(timeline, rules = {}) {
  const cfg = { ...DEFAULTS, ...rules };
  const tickrate = timeline.tickrate || 64;
  const windowTicks = ticks(cfg.windowS, tickrate);
  const kills = (timeline.kills || []).filter(validKill).slice().sort((a, b) => a.tick - b.tick);
  const rounds = timeline.rounds || [];
  const bombs = timeline.bomb || [];
  const out = [];

  const byRound = new Map();
  for (const k of kills) {
    if (!byRound.has(k.round)) byRound.set(k.round, []);
    byRound.get(k.round).push(k);
  }

  for (const round of rounds) {
    const rk = (byRound.get(round.number) || []).slice().sort((a, b) => a.tick - b.tick);
    if (!rk.length && !(round.roster || []).length) continue;

    const first = rk[0];
    if (first) {
      out.push(make({
        kind: "entry",
        round: round.number,
        steamid: first.attacker,
        name: first.attackerName,
        team: first.attackerTeam,
        killTicks: [first.tick],
        clipStart: first.tick,
        clipEnd: first.tick,
        weapon: first.weapon,
        tags: tagsOf([first]),
        kills: 1,
        score: 18 + (first.headshot ? 4 : 0),
      }, tickrate, cfg));
    }

    const byPlayer = new Map();
    for (const k of rk) {
      if (!byPlayer.has(k.attacker)) byPlayer.set(k.attacker, []);
      byPlayer.get(k.attacker).push(k);
    }

    for (const [steamid, pk] of byPlayer) {
      const name = pk[0].attackerName;
      const team = pk[0].attackerTeam;
      if (pk.length >= 5) {
        const five = pk.slice(0, 5);
        out.push(make({
          kind: "ace",
          round: round.number,
          steamid,
          name,
          team,
          killTicks: five.map((k) => k.tick),
          clipStart: five[0].tick,
          clipEnd: five[4].tick,
          weapon: weaponOf(five),
          tags: tagsOf(five),
          kills: 5,
          score: 100 + (five.every((k) => k.headshot) ? 12 : 0),
        }, tickrate, cfg));
      } else {
        for (const chain of chains(pk, windowTicks)) {
          if (chain.length < 2) continue;
          const n = chain.length;
          out.push(make({
            kind: "multikill",
            round: round.number,
            steamid,
            name,
            team,
            killTicks: chain.map((k) => k.tick),
            clipStart: chain[0].tick,
            clipEnd: chain[chain.length - 1].tick,
            weapon: weaponOf(chain),
            tags: tagsOf(chain),
            kills: n,
            score: n === 4 ? 74 : n === 3 ? 50 : 28,
          }, tickrate, cfg));
        }
      }

      let streak = [];
      const flush = () => {
        if (streak.length >= 3) {
          const covered = [...byPlayer.get(steamid)];
          const ace = pk.length >= 5 && sameKillSet(streak, pk.slice(0, 5));
          const multi = chains(pk, windowTicks).some((c) => sameKillSet(c, streak));
          if (!ace && !multi) {
            out.push(make({
              kind: "headshotStreak",
              round: round.number,
              steamid,
              name,
              team,
              killTicks: streak.map((k) => k.tick),
              clipStart: streak[0].tick,
              clipEnd: streak[streak.length - 1].tick,
              weapon: weaponOf(streak),
              tags: ["headshots"],
              kills: streak.length,
              score: 34 + (streak.length - 3) * 8,
            }, tickrate, cfg));
          }
          void covered;
        }
        streak = [];
      };
      for (const k of pk) {
        if (k.headshot && (streak.length === 0 || k.tick - streak[streak.length - 1].tick <= windowTicks)) streak.push(k);
        else {
          flush();
          if (k.headshot) streak = [k];
        }
      }
      flush();
    }

    // Clutches from the round roster and the death order.
    const alive = { T: new Set(), CT: new Set() };
    const teamOf = new Map();
    for (const r of round.roster || []) {
      if (r.team !== "T" && r.team !== "CT") continue;
      alive[r.team].add(r.steamid);
      teamOf.set(r.steamid, r.team);
    }
    const situation = new Map();
    for (const k of rk) {
      const vt = k.victimTeam || teamOf.get(k.victim);
      if (vt && alive[vt]) alive[vt].delete(k.victim);
      for (const team of ["T", "CT"]) {
        if (alive[team].size !== 1) continue;
        const [only] = alive[team];
        const enemies = team === "T" ? "CT" : "T";
        if (alive[enemies].size < 1) continue;
        if (!situation.has(only)) {
          situation.set(only, { tick: k.tick, enemies: alive[enemies].size, team });
        }
      }
    }
    for (const [steamid, sit] of situation) {
      if (round.winner !== sit.team) continue;
      const survived = alive[sit.team].has(steamid);
      const pk = byPlayer.get(steamid) || [];
      const gotKill = pk.some((k) => k.tick >= sit.tick);
      const planted = bombs.some((b) => b.kind === "plant" && b.tick >= round.startTick && b.tick <= round.endTick && sit.team === "T" && round.winner === "T");
      if (!survived && !gotKill && !planted) continue;
      const name = pk[0]?.attackerName || (round.roster || []).find((r) => r.steamid === steamid)?.name || "";
      out.push(make({
        kind: "clutch",
        round: round.number,
        steamid,
        name,
        team: sit.team,
        killTicks: pk.filter((k) => k.tick >= sit.tick - ticks(2, tickrate)).map((k) => k.tick),
        clipStart: sit.tick,
        clipEnd: round.endTick,
        weapon: weaponOf(pk),
        tags: tagsOf(pk),
        kills: pk.length,
        enemies: sit.enemies,
        score: 42 + sit.enemies * 14,
      }, tickrate, cfg));
    }
  }

  out.forEach((h, i) => {
    h.id = `r${h.round}-${h.steamid}-${h.kind}-${h.killTicks[0] ?? i}`;
  });
  out.sort((a, b) => b.score - a.score || a.startTick - b.startTick);
  return out;
}

export function highlightsFor(timeline, steamid) {
  const all = detectHighlights(timeline);
  if (!steamid) return all;
  return all.filter((h) => h.steamid === String(steamid));
}
