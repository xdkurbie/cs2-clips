/**
 * Build Valve replay URLs from a Game Coordinator match list payload.
 * Pure helpers — no Steam login — so they can be unit tested with fixtures.
 *
 * node-globaloffensive `requestGame` resolves on the `matchList` event.
 * The last roundstats entry carries `reservationid` (outcome id). The replay
 * cluster is the small integer `reservation`, or `watchablematchinfo.server_ip`.
 */

function asString(v) {
  if (v == null || v === "") return "";
  return String(v);
}

function roundsOf(match) {
  const all = match?.roundstatsall || match?.roundstats_legacy || [];
  return Array.isArray(all) ? all : [all];
}

function findMap(match) {
  for (const r of roundsOf(match).slice().reverse()) {
    if (r?.map) return String(r.map);
  }
  return "";
}

function clusterOf(match, reservationId) {
  const rounds = roundsOf(match);
  const last = rounds[rounds.length - 1] || {};
  const candidates = [last.reservation, match?.watchablematchinfo?.server_ip];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0 && n < 2000) return n;
  }
  try {
    const n = Number(BigInt(reservationId) % 256n);
    if (n > 0) return n;
  } catch {
    /* ignore */
  }
  return 0;
}

function collectStrings(value, out, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    if (value.includes("valve.net") && value.includes(".dem")) out.push(value);
    return;
  }
  if (typeof value !== "object") return;
  for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
}

/**
 * Candidate demo URLs, preferred first. Empty when the payload has no ids.
 */
export function demoCandidates(match) {
  const direct = [];
  collectStrings(match, direct);
  const rounds = roundsOf(match);
  const last = rounds[rounds.length - 1] || {};
  const matchId = asString(match?.matchid);
  const outcomeId = asString(last.reservationid || match?.watchablematchinfo?.reservation_id);
  const built = [];
  if (matchId && outcomeId) {
    const cluster = clusterOf(match, outcomeId);
    const name = `${matchId}_${outcomeId}.dem.bz2`;
    const padded = `${matchId.padStart(21, "0")}_${outcomeId.padStart(10, "0")}.dem.bz2`;
    const clusters = cluster ? [cluster] : [];
    for (const c of clusters) {
      built.push(`http://replay${c}.valve.net/730/${name}`);
      built.push(`https://replay${c}.valve.net/730/${name}`);
      if (padded !== name) {
        built.push(`http://replay${c}.valve.net/730/${padded}`);
      }
    }
  }
  const urls = [];
  for (const u of [...direct, ...built]) {
    if (u && !urls.includes(u)) urls.push(u);
  }
  return urls;
}

export function describeMatch(match) {
  const urls = demoCandidates(match);
  if (!urls.length) return { code: "unavailable" };
  const rounds = roundsOf(match);
  const last = rounds[rounds.length - 1] || {};
  return {
    code: "ok",
    urls,
    matchId: asString(match?.matchid),
    outcomeId: asString(last.reservationid),
    map: findMap(match),
  };
}

export function classifyHttp(status) {
  if (status === 404 || status === 410) return "expired";
  if (status >= 200 && status < 300) return "ok";
  return "error";
}

/**
 * Try each candidate. 404/410 means Valve no longer has the replay
 * (demos expire after a few weeks). Other failures try the next shape.
 */
export async function downloadFirstWorking(urls, fetchImpl) {
  let sawExpired = false;
  for (const url of urls) {
    let res;
    try {
      res = await fetchImpl(url);
    } catch {
      continue;
    }
    const kind = classifyHttp(res.status);
    if (kind === "ok") return { ok: true, url, status: res.status, body: res.body, res };
    if (kind === "expired") sawExpired = true;
  }
  return { ok: false, code: sawExpired ? "expired" : "unavailable" };
}
