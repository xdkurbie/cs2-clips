"""Highlight detection on kill-event dataframes (pure pandas, testable without demos).

Expected kills columns: tick, round, attacker_steamid, attacker_name, attacker_team,
user_steamid, user_name, user_team, headshot, penetrated, noscope, weapon.
rounds dataframe: round, start_tick, end_tick, winner (team number 2=T, 3=CT).
roster dataframe (optional, for clutches/aces): round, steamid, name, team.
"""
from __future__ import annotations
from dataclasses import dataclass, field
import pandas as pd
from .rules import Rules


@dataclass
class Highlight:
    kind: str
    round: int
    steamid: str
    name: str
    start_tick: int
    end_tick: int
    kills: int
    score: int
    tags: list = field(default_factory=list)

    @property
    def label(self) -> str:
        t = f" ({', '.join(self.tags)})" if self.tags else ""
        return f"R{self.round} {self.kind}{t} – {self.name}"


def _sid(x) -> str:
    try:
        return str(int(x))
    except (TypeError, ValueError):
        return str(x) if x is not None else ""


def _chains(ticks: list[int], window_ticks: int) -> list[list[int]]:
    if window_ticks <= 0:
        return [ticks] if ticks else []
    out, cur = [], []
    for t in ticks:
        if cur and t - cur[-1] > window_ticks:
            out.append(cur); cur = []
        cur.append(t)
    if cur:
        out.append(cur)
    return out


def _clip(rules: Rules, first: int, last: int) -> tuple[int, int]:
    return max(0, int(first - rules.pre_roll_s * rules.tickrate)), int(last + rules.post_roll_s * rules.tickrate)


def detect_highlights(kills: pd.DataFrame, rounds: pd.DataFrame | None = None,
                      roster: pd.DataFrame | None = None, rules: Rules | None = None,
                      player: str | None = None) -> list[Highlight]:
    rules = rules or Rules()
    sc = rules.scores
    if kills is None or kills.empty:
        return []
    k = kills.copy()
    k["attacker_steamid"] = k["attacker_steamid"].map(_sid)
    k["user_steamid"] = k["user_steamid"].map(_sid)
    for c in ("headshot", "penetrated", "noscope"):
        if c not in k:
            k[c] = False
    k["penetrated"] = k["penetrated"].fillna(0).astype(int) > 0
    # drop suicides / world / teamkills
    valid = (k["attacker_steamid"] != k["user_steamid"]) & (k["attacker_steamid"] != "") & \
            (k["attacker_steamid"] != "0") & (k["attacker_team"] != k["user_team"])
    k = k[valid].sort_values("tick")
    hl: list[Highlight] = []
    window = int(rules.multikill_window_s * rules.tickrate)

    for (rnd, sid), g in k.groupby(["round", "attacker_steamid"]):
        name = str(g["attacker_name"].iloc[-1])
        team = g["attacker_team"].iloc[0]
        enemies_in_round = None
        if roster is not None and not roster.empty:
            r = roster[(roster["round"] == rnd) & (roster["team"] != team)]
            enemies_in_round = len(r) or None
        for chain in _chains(list(g["tick"]), window):
            n = len(chain)
            if n >= rules.min_multikill:
                sub = g[g["tick"].isin(chain)]
                ace = n >= 5 and (enemies_in_round is None or n >= enemies_in_round)
                kind = "ace" if ace else f"{min(n,5)}k"
                tags = []
                if sub["headshot"].astype(bool).all():
                    tags.append("all HS")
                s, e = _clip(rules, chain[0], chain[-1])
                hl.append(Highlight(kind, int(rnd), sid, name, s, e, n,
                                    int(sc.get(kind, 0) + 2 * int(sub["headshot"].astype(bool).sum())), tags))
        for _, row in g.iterrows():
            tags = []
            if rules.detect_noscopes and bool(row["noscope"]):
                tags.append("noscope")
            if rules.detect_wallbangs and bool(row["penetrated"]):
                tags.append("wallbang")
            if rules.detect_headshots and bool(row["headshot"]) and not tags:
                tags.append("headshot")
            if tags:
                s, e = _clip(rules, int(row["tick"]), int(row["tick"]))
                hl.append(Highlight(tags[0], int(rnd), sid, name, s, e, 1,
                                    int(sum(sc.get(t, 0) for t in tags)), tags[1:] + ([str(row.get("weapon", ""))] if row.get("weapon") else [])))

    if rules.detect_clutches and rounds is not None and roster is not None and not roster.empty:
        hl += _clutches(k, rounds, roster, rules)

    if player:
        p = player.lower()
        hl = [h for h in hl if h.steamid == player or h.name.lower() == p]  # SteamID or case-insensitive name
    hl = [h for h in hl if h.score >= rules.min_score]
    return sorted(hl, key=lambda h: (h.round, h.start_tick))


def _clutches(k, rounds, roster, rules) -> list[Highlight]:
    out = []
    sc = rules.scores
    for _, rd in rounds.iterrows():
        rnd = rd["round"]
        ro = roster[roster["round"] == rnd]
        alive = {_sid(r.steamid): r.team for r in ro.itertuples()}
        names = {_sid(r.steamid): r.name for r in ro.itertuples()}
        rk = k[k["round"] == rnd].sort_values("tick")
        found = None
        for _, kill in rk.iterrows():
            alive.pop(kill["user_steamid"], None)
            if found:
                continue
            for team in set(alive.values()):
                mine = [s for s, t in alive.items() if t == team]
                enemies = [s for s, t in alive.items() if t != team]
                if len(mine) == 1 and len(enemies) >= rules.min_clutch_enemies:
                    found = (mine[0], team, len(enemies), int(kill["tick"]))
                    break
        if found and found[1] == rd["winner"]:
            sid, team, n, t0 = found
            end = int(rk[rk["attacker_steamid"] == sid]["tick"].max()) if (rk["attacker_steamid"] == sid).any() else int(rd["end_tick"])
            s, e = _clip(rules, t0, max(end, t0))
            out.append(Highlight(f"clutch 1v{n}", int(rnd), sid, str(names.get(sid, sid)), s, e,
                                 int((rk[rk["tick"] > t0]["attacker_steamid"] == sid).sum()),
                                 int(sc["clutch"] + sc["clutch_per_enemy"] * n)))
    return out


def per_player(hl: list[Highlight]) -> dict[str, list[Highlight]]:
    d: dict[str, list[Highlight]] = {}
    for h in hl:
        d.setdefault(f"{h.name} ({h.steamid})", []).append(h)
    return d
