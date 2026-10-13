"""User settings stored in %APPDATA%/cs2-clips/settings.json."""
from __future__ import annotations
import json, os
from dataclasses import dataclass, asdict
from pathlib import Path


def config_dir() -> Path:
    base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    d = Path(base) / "cs2-clips"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Settings:
    player_name: str = "rasu420"  # Steam name, matched case-insensitively
    player_steamid: str = ""      # resolved automatically from a demo, then preferred
    replays_dir: str = ""       # empty = auto-detect
    cs2_cfg_dir: str = ""       # .../game/csgo/cfg ; empty = derived from replays_dir
    steam_exe: str = "C:/Program Files (x86)/Steam/steam.exe"
    capture: str = "ffmpeg"     # "ffmpeg" or "obs"
    obs_host: str = "localhost"
    obs_port: int = 4455
    obs_password: str = ""
    output_dir: str = ""
    rules_file: str = ""
    music: str = ""
    slowmo: float = 1.0
    language: str = "no"
    onboarded: bool = False
    selectivity: str = "medium"

    @classmethod
    def load(cls, path: Path | None = None) -> "Settings":
        path = path or config_dir() / "settings.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        return cls()

    def resolve_player(self, roster_or_kills) -> bool:
        """If steamid unknown, find player_name in a demo dataframe and store its SteamID. Returns True if updated."""
        if self.player_steamid or not self.player_name:
            return False
        df = roster_or_kills
        pairs = []
        if {"name", "steamid"} <= set(df.columns):
            pairs += list(zip(df["name"], df["steamid"]))
        if {"attacker_name", "attacker_steamid"} <= set(df.columns):
            pairs += list(zip(df["attacker_name"], df["attacker_steamid"]))
        for n, sid in pairs:
            if str(n).lower() == self.player_name.lower() and str(sid) not in ("", "0", "None", "nan"):
                self.player_steamid = str(sid).removesuffix(".0")
                return True
        return False

    @property
    def player(self) -> str:
        return self.player_steamid or self.player_name

    def save(self, path: Path | None = None) -> None:
        path = path or config_dir() / "settings.json"
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
