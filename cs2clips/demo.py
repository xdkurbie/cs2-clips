"""Demo loading via demoparser2 -> dataframes for detect.py."""
from __future__ import annotations
import os
from pathlib import Path
import pandas as pd

TEAM_MAP = {"T": 2, "TERRORIST": 2, "CT": 3, 2: 2, 3: 3}


def default_replays_dirs() -> list[Path]:
    cands = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), "C:/Program Files (x86)",
                 os.path.expanduser("~/.steam/steam"), os.path.expanduser("~/.local/share/Steam")):
        if base:
            cands.append(Path(base) / ("Steam" if "Program" in str(base) else "") /
                         "steamapps/common/Counter-Strike Global Offensive/game/csgo/replays")
    # extra Steam libraries from libraryfolders.vdf
    for c in list(cands):
        vdf = c.parents[5] / "steamapps/libraryfolders.vdf" if len(c.parents) > 5 else None
        if vdf and vdf.exists():
            import re
            for lib in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(errors="ignore")):
                cands.append(Path(lib.replace("\\\\", "\\")) /
                             "steamapps/common/Counter-Strike Global Offensive/game/csgo/replays")
    return cands


def find_replays_dir(override: str | None = None) -> Path | None:
    if override:
        return Path(override)
    for c in default_replays_dirs():
        if c.is_dir():
            return c
    return None


def list_demos(folder: Path | None) -> list[Path]:
    if not folder or not folder.is_dir():
        return []
    return sorted(folder.glob("*.dem"), key=lambda p: p.stat().st_mtime, reverse=True)


def load_demo(path: str | Path):
    """Return (kills, rounds, roster, header)."""
    from demoparser2 import DemoParser
    p = DemoParser(str(path))
    header = p.parse_header()
    kills = p.parse_event("player_death", player=["team_num"], other=["total_rounds_played"])
    kills = kills.rename(columns={"total_rounds_played": "round", "attacker_team_num": "attacker_team",
                                  "user_team_num": "user_team"})
    kills["round"] = kills["round"].astype(int) + 1
    for c in ("headshot", "noscope"):
        if c not in kills:
            kills[c] = False
    if "penetrated" not in kills:
        kills["penetrated"] = 0

    starts = p.parse_event("round_freeze_end", other=["total_rounds_played"])
    ends = p.parse_event("round_end", other=["total_rounds_played"])
    rounds = pd.DataFrame({
        "round": starts["total_rounds_played"].astype(int) + 1,
        "start_tick": starts["tick"].astype(int)}).drop_duplicates("round", keep="last")
    if not ends.empty:
        e = pd.DataFrame({"round": ends["total_rounds_played"].astype(int),  # counter already incremented at end
                          "end_tick": ends["tick"].astype(int),
                          "winner": ends["winner"].map(lambda w: TEAM_MAP.get(w, TEAM_MAP.get(str(w).upper(), w)))})
        rounds = rounds.merge(e, on="round", how="left")
    else:
        rounds["end_tick"] = None; rounds["winner"] = None

    ticks = p.parse_ticks(["team_num", "is_alive", "name", "steamid"], ticks=[int(t) + 1 for t in rounds["start_tick"]])
    tick_to_round = {int(t) + 1: r for t, r in zip(rounds["start_tick"], rounds["round"])}
    ticks = ticks[ticks["team_num"].isin([2, 3])]
    roster = pd.DataFrame({"round": ticks["tick"].map(tick_to_round), "steamid": ticks["steamid"].astype(str),
                           "name": ticks["name"], "team": ticks["team_num"]})
    return kills, rounds, roster, header
