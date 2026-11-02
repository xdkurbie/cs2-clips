#!/usr/bin/env python3
"""Parse a CS2 .dem (or .dem.bz2) into a compact replay timeline.

Samples are a little-endian float32 blob (see the CS2S header). Events, rounds
and grenade paths stay JSON. No Valve assets are read or written.
"""

from __future__ import annotations

import argparse
import bz2
import gzip
import json
import os
import shutil
import struct
import sys
import tempfile

import numpy as np
from demoparser2 import DemoParser

STRIDE = 11
PRESENT = 128
TICKRATE = 64

REASON = {
    1: "bombed",
    7: "defused",
    8: "time",
    9: "elimination",
    12: "saved",
    17: "surrender_t",
    18: "surrender_ct",
}


def eprint(*args):
    print(*args, file=sys.stderr)


def team_name(n) -> str | None:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    if n == 2:
        return "T"
    if n == 3:
        return "CT"
    return None


def ensure_dem(path: str) -> tuple[str, bool]:
    with open(path, "rb") as f:
        magic = f.read(8)
    if magic.startswith(b"BZh"):
        tmp = tempfile.NamedTemporaryFile(suffix=".dem", delete=False)
        tmp.close()
        with bz2.open(path, "rb") as src, open(tmp.name, "wb") as dst:
            shutil.copyfileobj(src, dst)
        return tmp.name, True
    if not magic.startswith(b"PBDEMS2"):
        eprint("not a Source 2 demo")
        raise SystemExit(2)
    return path, False


def records(df):
    if df is None or len(df) == 0:
        return []
    return df.to_dict("records")


def kind_of(cls: str) -> str:
    c = str(cls)
    if "Smoke" in c:
        return "smoke"
    if "Molotov" in c or "Incendiary" in c:
        return "molotov"
    if "Flash" in c:
        return "flash"
    if "HE" in c or "Frag" in c:
        return "he"
    if "Decoy" in c:
        return "decoy"
    return "other"


def num(v, default=0.0):
    try:
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def sid(v) -> str:
    if v is None:
        return ""
    try:
        if isinstance(v, float) and np.isnan(v):
            return ""
    except TypeError:
        pass
    s = str(v).strip()
    if s in ("", "nan", "None", "0"):
        return ""
    if s.endswith(".0"):
        s = s[:-2]
    return s


def write_round_file(path, rnd, arr, tick0, interval, n_ticks, order, names, weapons, kills, utility, bomb, trajectories, scale):
    """One round: magic + version + JSON header + gzip SoA body at 32 Hz."""
    start = int(rnd["startTick"])
    end = int(rnd["endTick"])
    first = tick0 + max(0, (start - tick0) // interval) * interval
    frames = list(range(first, max(first, end) + 1, interval))
    if not frames:
        frames = [first]
    idx = []
    for t in frames:
        i = int(round((t - tick0) / interval))
        idx.append(max(0, min(n_ticks - 1, i)))
    sub = np.nan_to_num(arr[idx], nan=0.0)
    nF = sub.shape[0]
    nP = sub.shape[1]
    xs = np.clip(np.rint(sub[:, :, 0] / scale), -32767, 32767).astype("<i2")
    ys = np.clip(np.rint(sub[:, :, 1] / scale), -32767, 32767).astype("<i2")
    zs = np.clip(np.rint(sub[:, :, 2] / scale), -32767, 32767).astype("<i2")
    yaw = np.mod(sub[:, :, 3], 360.0)
    yaw_u = np.clip(np.rint(yaw / 360.0 * 255.0), 0, 255).astype(np.uint8)
    pitch = np.clip(sub[:, :, 4], -90.0, 90.0)
    pitch_u = np.clip(np.rint((pitch + 90.0) / 180.0 * 255.0), 0, 255).astype(np.uint8)
    hp = np.clip(np.rint(sub[:, :, 5]), 0, 255).astype(np.uint8)
    armor = np.clip(np.rint(sub[:, :, 6]), 0, 255).astype(np.uint8)
    money = np.clip(np.rint(sub[:, :, 7]), 0, 65535).astype("<u2")
    equip = np.clip(np.rint(sub[:, :, 8]), 0, 65535).astype("<u2")
    weapon = np.clip(np.rint(sub[:, :, 9]), 0, 255).astype(np.uint8)
    flags = np.clip(np.rint(sub[:, :, 10]), 0, 255).astype(np.uint8)

    parts = [struct.pack("<II", nF, nP)]
    for p in range(nP):
        parts.append(xs[:, p].tobytes())
        parts.append(ys[:, p].tobytes())
        parts.append(zs[:, p].tobytes())
        parts.append(yaw_u[:, p].tobytes())
        parts.append(pitch_u[:, p].tobytes())
        parts.append(hp[:, p].tobytes())
        parts.append(armor[:, p].tobytes())
        parts.append(money[:, p].tobytes())
        parts.append(equip[:, p].tobytes())
        parts.append(weapon[:, p].tobytes())
        parts.append(flags[:, p].tobytes())
    blob = gzip.compress(b"".join(parts), compresslevel=6)

    def inside(tick, pad=128):
        return start - pad <= int(tick) <= end + pad

    header = {
        "round": rnd["number"],
        "startTick": start,
        "endTick": end,
        "tick0": frames[0],
        "interval": interval,
        "nFrames": nF,
        "scale": scale,
        "winner": rnd.get("winner"),
        "reason": rnd.get("reason"),
        "players": [{"steamid": s, "name": names.get(s, "")} for s in order],
        "weapons": weapons,
        "kills": [k for k in kills if k["round"] == rnd["number"]],
        "utility": [u for u in utility if inside(u["tick"])],
        "bomb": [b for b in bomb if inside(b["tick"])],
        "trajectories": [],
    }
    for tr in trajectories:
        pts = [p for p in tr["points"] if inside(p[0], 64)]
        if len(pts) >= 2:
            header["trajectories"].append({"kind": tr["kind"], "steamid": tr["steamid"], "points": pts})
    raw = json.dumps(header, separators=(",", ":")).encode()
    with open(path, "wb") as f:
        f.write(b"CS2R")
        f.write(struct.pack("<HHI", 1, int(scale), len(raw)))
        f.write(raw)
        f.write(blob)


def lookup_pos(arr, tick0, interval, n_ticks, players, steam, tick):
    if steam not in players or n_ticks == 0 or interval <= 0:
        return None
    i = int(round((tick - tick0) / interval))
    i = max(0, min(n_ticks - 1, i))
    p = players[steam]
    flags = int(arr[i, p, 10])
    if not (flags & PRESENT):
        return None
    return [round(float(arr[i, p, 0]), 1), round(float(arr[i, p, 1]), 1), round(float(arr[i, p, 2]), 1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("demo")
    ap.add_argument("--out", required=True)
    ap.add_argument("--rounds", required=True, help="directory for per-round CS2R files")
    ap.add_argument("--points", required=True, help="int16 xyz cloud for the blockout")
    ap.add_argument("--interval", type=int, default=2)
    args = ap.parse_args()
    interval = max(1, args.interval)

    dem, temp = ensure_dem(args.demo)
    try:
        parser = DemoParser(dem)
        header = parser.parse_header()
        map_name = header.get("map_name") or "unknown"

        info = parser.parse_player_info()
        names = {}
        for row in records(info):
            names[sid(row.get("steamid"))] = str(row.get("name") or "")

        events = dict(parser.parse_events([
            "player_death",
            "round_freeze_end",
            "round_end",
            "round_start",
            "bomb_planted",
            "bomb_defused",
            "bomb_exploded",
            "bomb_begindefuse",
            "bomb_pickup",
            "bomb_dropped",
            "smokegrenade_detonate",
            "smokegrenade_expired",
            "flashbang_detonate",
            "hegrenade_detonate",
            "inferno_startburn",
            "inferno_expire",
        ]))

        freezes = sorted(int(t) for t in events["round_freeze_end"]["tick"].tolist()) if len(events["round_freeze_end"]) else []
        ends = records(events["round_end"])
        ends.sort(key=lambda r: int(r["tick"]))

        max_tick = 0
        for df in events.values():
            if len(df) and "tick" in df.columns:
                max_tick = max(max_tick, int(df["tick"].max()))
        if freezes:
            max_tick = max(max_tick, freezes[-1])
        if max_tick <= 0:
            eprint("demo has no round data")
            raise SystemExit(2)

        tick0 = interval
        tick_list = list(range(tick0, max_tick + interval, interval))
        props = [
            "X", "Y", "Z", "yaw", "pitch", "health", "armor_value", "balance",
            "current_equip_value", "is_alive", "team_num", "active_weapon_name",
            "has_helmet", "has_defuser", "is_scoped",
        ]
        df = parser.parse_ticks(props, ticks=tick_list)
        if len(df) == 0:
            eprint("no player samples")
            raise SystemExit(2)

        order = []
        seen = set()
        for raw in df["steamid"].tolist():
            s = sid(raw)
            if s and s not in seen:
                seen.add(s)
                order.append(s)
                names.setdefault(s, "")
        index = {s: i for i, s in enumerate(order)}
        n_players = len(order)
        n_ticks = len(tick_list)
        arr = np.zeros((n_ticks, n_players, STRIDE), dtype=np.float32)

        tick_index = {t: i for i, t in enumerate(tick_list)}
        weapons_set = set()
        # Two-pass: collect weapon names, then fill. One pass with a dict is enough.
        wmap = {}

        def weapon_id(name):
            if name is None or (isinstance(name, float) and np.isnan(name)):
                return 0
            name = str(name)
            if not name or name == "nan":
                return 0
            weapons_set.add(name)
            if name not in wmap:
                wmap[name] = len(wmap) + 1
            return wmap[name]

        ticks_np = df["tick"].to_numpy()
        steam_np = df["steamid"].tolist()
        xs = df["X"].to_numpy()
        ys = df["Y"].to_numpy()
        zs = df["Z"].to_numpy()
        yaws = df["yaw"].to_numpy()
        pitches = df["pitch"].to_numpy()
        healths = df["health"].to_numpy()
        armors = df["armor_value"].to_numpy()
        moneys = df["balance"].to_numpy()
        equips = df["current_equip_value"].to_numpy()
        alives = df["is_alive"].tolist()
        teams = df["team_num"].to_numpy()
        wnames = df["active_weapon_name"].tolist()
        helmets = df["has_helmet"].tolist()
        kits = df["has_defuser"].tolist()
        scopes = df["is_scoped"].tolist()

        for i in range(len(df)):
            s = sid(steam_np[i])
            p = index.get(s)
            ti = tick_index.get(int(ticks_np[i]))
            if p is None or ti is None:
                continue
            team = int(num(teams[i]))
            alive = bool(alives[i])
            flags = PRESENT
            if alive:
                flags |= 1
            if bool(helmets[i]):
                flags |= 2
            if bool(kits[i]):
                flags |= 4
            if bool(scopes[i]):
                flags |= 8
            flags |= (team & 7) << 4
            arr[ti, p, 0] = num(xs[i])
            arr[ti, p, 1] = num(ys[i])
            arr[ti, p, 2] = num(zs[i])
            arr[ti, p, 3] = num(yaws[i])
            arr[ti, p, 4] = num(pitches[i])
            arr[ti, p, 5] = num(healths[i])
            arr[ti, p, 6] = num(armors[i])
            arr[ti, p, 7] = num(moneys[i])
            arr[ti, p, 8] = num(equips[i])
            arr[ti, p, 9] = weapon_id(wnames[i])
            arr[ti, p, 10] = flags

        weapons = [None] * (len(wmap) + 1)
        weapons[0] = ""
        for name, wid in wmap.items():
            weapons[wid] = name

        def roster_at(tick):
            i = int(round((tick - tick0) / interval))
            i = max(0, min(n_ticks - 1, i))
            roster = []
            for s, p in index.items():
                flags = int(arr[i, p, 10])
                if not (flags & 1):
                    continue
                team = team_name((flags >> 4) & 7)
                if not team:
                    continue
                roster.append({
                    "steamid": s,
                    "name": names.get(s, ""),
                    "team": team,
                    "money": int(arr[i, p, 7]),
                    "equip": int(arr[i, p, 8]),
                })
            return roster

        used_ends = set()
        rounds = []
        for n, fr in enumerate(freezes, start=1):
            end = next((e for e in ends if id(e) not in used_ends and int(e["tick"]) >= fr), None)
            if end is None:
                continue
            used_ends.add(id(end))
            winner = team_name(end.get("winner"))
            reason = int(num(end.get("reason")))
            rounds.append({
                "number": len(rounds) + 1,
                "startTick": fr,
                "endTick": int(end["tick"]),
                "winner": winner,
                "reason": REASON.get(reason, "other"),
                "reasonCode": reason,
                "roster": roster_at(fr),
            })
        for end in ends:
            if id(end) in used_ends:
                continue
            tick = int(end["tick"])
            prev = rounds[-1]["endTick"] if rounds else tick - TICKRATE
            if tick - prev < TICKRATE:
                continue
            reason = int(num(end.get("reason")))
            rounds.append({
                "number": len(rounds) + 1,
                "startTick": prev + interval,
                "endTick": tick,
                "winner": team_name(end.get("winner")),
                "reason": REASON.get(reason, "other"),
                "reasonCode": reason,
                "roster": roster_at(prev + interval),
            })

        def team_at(steam: str, tick: int):
            p = index.get(steam)
            if p is None or n_ticks == 0:
                return None
            i = int(round((tick - tick0) / interval))
            i = max(0, min(n_ticks - 1, i))
            flags = int(arr[i, p, 10])
            if not (flags & PRESENT):
                return None
            return team_name((flags >> 4) & 7)

        def round_of(tick: int) -> int:
            # Deaths after a round has gone live count, including the gap before
            # the next freeze, matching the desktop parser's kill total.
            chosen = 0
            for r in rounds:
                if r["startTick"] <= tick:
                    chosen = r["number"]
                else:
                    break
            return chosen

        kills = []
        for row in records(events["player_death"]):
            tick = int(row["tick"])
            if freezes and tick < freezes[0]:
                continue
            rnd = round_of(tick)
            if rnd == 0:
                continue
            attacker = sid(row.get("attacker_steamid"))
            victim = sid(row.get("user_steamid"))
            kills.append({
                "tick": tick,
                "round": rnd,
                "attacker": attacker,
                "attackerName": "" if row.get("attacker_name") is None else str(row.get("attacker_name")),
                "attackerTeam": team_name(row.get("attacker_team_num")) or team_at(attacker, tick),
                "victim": victim,
                "victimName": "" if row.get("user_name") is None else str(row.get("user_name")),
                "victimTeam": team_name(row.get("user_team_num")) or team_at(victim, tick),
                "assister": sid(row.get("assister_steamid")),
                "weapon": str(row.get("weapon") or ""),
                "headshot": bool(row.get("headshot")),
                "wallbang": int(num(row.get("penetrated"))) > 0,
                "noscope": bool(row.get("noscope")),
                "smoke": bool(row.get("thrusmoke")),
                "blind": bool(row.get("attackerblind")),
            })

        def event_pos(row, steam_key="user_steamid"):
            steam = sid(row.get(steam_key) or row.get("user_steamid"))
            if "x" in row and row.get("x") is not None and not (isinstance(row.get("x"), float) and np.isnan(row["x"])):
                return [round(num(row["x"]), 1), round(num(row["y"]), 1), round(num(row["z"]), 1)]
            return lookup_pos(arr, tick0, interval, n_ticks, index, steam, int(row["tick"]))

        utility = []

        def add_timed(df, kind, default_s, expire_df=None):
            expires = {}
            if expire_df is not None:
                for row in records(expire_df):
                    expires[int(num(row.get("entityid")))] = int(row["tick"])
            for row in records(df):
                tick = int(row["tick"])
                ent = int(num(row.get("entityid")))
                end = expires.get(ent, tick + int(default_s * TICKRATE))
                pos = event_pos(row)
                if not pos:
                    continue
                utility.append({
                    "kind": kind,
                    "tick": tick,
                    "endTick": end,
                    "x": pos[0],
                    "y": pos[1],
                    "z": pos[2],
                    "steamid": sid(row.get("user_steamid")),
                })

        add_timed(events["smokegrenade_detonate"], "smoke", 18, events["smokegrenade_expired"])
        add_timed(events["inferno_startburn"], "molotov", 7, events["inferno_expire"])
        add_timed(events["flashbang_detonate"], "flash", 0.4)
        add_timed(events["hegrenade_detonate"], "he", 0.45)

        # Site letters: lower raw site code in this match is A, the other is B.
        plant_rows = records(events["bomb_planted"])
        raw_sites = sorted({int(num(r.get("site"))) for r in plant_rows})
        site_letter = {}
        for i, raw in enumerate(raw_sites):
            site_letter[raw] = "A" if i == 0 else "B" if i == 1 else chr(ord("A") + i)

        bomb = []
        for row in records(events["bomb_pickup"]):
            bomb.append({"kind": "pickup", "tick": int(row["tick"]), "steamid": sid(row.get("user_steamid")), "name": str(row.get("user_name") or "")})
        for row in records(events["bomb_dropped"]):
            steam = sid(row.get("user_steamid"))
            pos = lookup_pos(arr, tick0, interval, n_ticks, index, steam, int(row["tick"]))
            ev = {"kind": "drop", "tick": int(row["tick"]), "steamid": steam, "name": str(row.get("user_name") or "")}
            if pos:
                ev["x"], ev["y"], ev["z"] = pos
            bomb.append(ev)
        for row in plant_rows:
            steam = sid(row.get("user_steamid"))
            pos = lookup_pos(arr, tick0, interval, n_ticks, index, steam, int(row["tick"])) or [0, 0, 0]
            raw = int(num(row.get("site")))
            bomb.append({
                "kind": "plant",
                "tick": int(row["tick"]),
                "steamid": steam,
                "name": str(row.get("user_name") or ""),
                "site": site_letter.get(raw, "?"),
                "x": pos[0], "y": pos[1], "z": pos[2],
            })
        for row in records(events["bomb_begindefuse"]):
            bomb.append({
                "kind": "defuse_start",
                "tick": int(row["tick"]),
                "steamid": sid(row.get("user_steamid")),
                "name": str(row.get("user_name") or ""),
                "haskit": bool(row.get("haskit")),
            })
        for row in records(events["bomb_defused"]):
            steam = sid(row.get("user_steamid"))
            pos = event_pos(row) or lookup_pos(arr, tick0, interval, n_ticks, index, steam, int(row["tick"]))
            ev = {"kind": "defuse", "tick": int(row["tick"]), "steamid": steam, "name": str(row.get("user_name") or "")}
            if pos:
                ev["x"], ev["y"], ev["z"] = pos
            bomb.append(ev)
        for row in records(events["bomb_exploded"]):
            steam = sid(row.get("user_steamid"))
            pos = event_pos(row) or lookup_pos(arr, tick0, interval, n_ticks, index, steam, int(row["tick"]))
            ev = {"kind": "explode", "tick": int(row["tick"]), "steamid": steam, "name": str(row.get("user_name") or "")}
            if pos:
                ev["x"], ev["y"], ev["z"] = pos
            bomb.append(ev)
        bomb.sort(key=lambda e: e["tick"])

        trajectories = []
        try:
            g = parser.parse_grenades()
        except Exception as exc:  # pragma: no cover - parser edge
            eprint("grenades skipped", exc)
            g = None
        if g is not None and len(g):
            g = g.sort_values(["grenade_entity_id", "tick"])
            for eid, sub in g.groupby("grenade_entity_id", sort=False):
                if len(sub) > 8:
                    last = sub.iloc[[-1]]
                    sub = sub.iloc[::8]
                    if int(sub.iloc[-1]["tick"]) != int(last.iloc[0]["tick"]):
                        sub = sub._append(last) if hasattr(sub, "_append") else __import__("pandas").concat([sub, last])
                pts = []
                steam = ""
                kind = "other"
                for row in sub.itertuples(index=False):
                    kind = kind_of(getattr(row, "grenade_type", ""))
                    steam = sid(getattr(row, "steamid", "")) or steam
                    pts.append([
                        int(row.tick),
                        round(num(row.x), 1),
                        round(num(row.y), 1),
                        round(num(row.z), 1),
                    ])
                if len(pts) >= 2 and kind != "other":
                    trajectories.append({"kind": kind, "steamid": steam, "points": pts})

        players = [{"steamid": s, "name": names.get(s, "")} for s in order]
        # Downsampled foot positions for the original blockout. Not a Valve mesh.
        chunks = []
        for ti in range(0, n_ticks, 4):
            flags = arr[ti, :, 10].astype(np.int32)
            alive = (flags & 1) != 0
            if not np.any(alive):
                continue
            chunks.append(arr[ti, alive, 0:3])
        cloud = np.concatenate(chunks, axis=0) if chunks else np.zeros((0, 3), np.float32)
        finite = np.isfinite(cloud).all(axis=1)
        cloud = cloud[finite]
        scale = 2 if cloud.size and np.max(np.abs(cloud)) > 30000 else 1
        np.clip(np.rint(cloud / scale), -32767, 32767).astype("<i2").tofile(args.points)

        os.makedirs(args.rounds, exist_ok=True)
        z_vals = cloud[:, 2] if len(cloud) else np.array([0.0])
        for rnd in rounds:
            write_round_file(
                os.path.join(args.rounds, f"r{rnd['number']}.bin"),
                rnd, arr, tick0, interval, n_ticks, order, names, weapons,
                kills, utility, bomb, trajectories, scale,
            )

        # Trajectories live in the round files. The match document stays small.
        for rnd in rounds:
            rnd.pop("_frames", None)
        payload = {
            "version": 2,
            "map": map_name,
            "tickrate": TICKRATE,
            "tick0": tick0,
            "interval": interval,
            "framerate": TICKRATE / interval,
            "totalTicks": int(tick_list[-1]) if tick_list else 0,
            "scale": scale,
            "levels": {
                "minZ": float(np.min(z_vals)) if len(cloud) else 0,
                "maxZ": float(np.max(z_vals)) if len(cloud) else 0,
            },
            "players": players,
            "weapons": weapons,
            "rounds": rounds,
            "kills": kills,
            "utility": utility,
            "bomb": bomb,
        }
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        eprint(
            f"parsed {map_name} rounds={len(rounds)} kills={len(kills)} "
            f"players={n_players} ticks={n_ticks} utility={len(utility)} points={len(cloud)}"
        )
    finally:
        if temp:
            try:
                os.remove(dem)
            except OSError:
                pass


if __name__ == "__main__":
    main()
