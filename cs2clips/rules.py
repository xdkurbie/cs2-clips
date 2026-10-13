"""Highlight rule config (JSON or YAML)."""
from __future__ import annotations
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

DEFAULT_SCORES = {"2k": 20, "3k": 40, "4k": 70, "5k": 100, "ace": 100, "clutch": 30,
                  "clutch_per_enemy": 15, "headshot": 3, "wallbang": 15, "noscope": 20}


SELECTIVITY = {"low": 0, "medium": 20, "high": 60}


@dataclass
class Rules:
    multikill_window_s: float = 0.0     # 0 = whole round counts; >0 = kills must chain within this many seconds
    min_multikill: int = 2
    detect_clutches: bool = True
    min_clutch_enemies: int = 1
    detect_headshots: bool = False      # single headshots are noisy, off by default
    detect_wallbangs: bool = True
    detect_noscopes: bool = True
    pre_roll_s: float = 4.0
    post_roll_s: float = 2.0
    min_score: int = 0
    tickrate: int = 64
    selectivity: str = ""                # "", "low", "medium", "high" – overrides min_score when set
    scores: dict = field(default_factory=lambda: dict(DEFAULT_SCORES))

    def validate(self) -> "Rules":
        if not 2 <= self.min_multikill <= 5:
            raise ValueError("min_multikill must be 2..5")
        if self.multikill_window_s < 0 or self.pre_roll_s < 0 or self.post_roll_s < 0:
            raise ValueError("time values must be >= 0")
        if self.tickrate <= 0:
            raise ValueError("tickrate must be > 0")
        if not 1 <= self.min_clutch_enemies <= 5:
            raise ValueError("min_clutch_enemies must be 1..5")
        if self.selectivity:
            if self.selectivity not in SELECTIVITY:
                raise ValueError("selectivity must be low/medium/high")
            self.min_score = SELECTIVITY[self.selectivity]
        return self

    def to_dict(self) -> dict:
        return asdict(self)


def rules_from_dict(d: dict | None) -> Rules:
    d = dict(d or {})
    unknown = set(d) - set(Rules.__dataclass_fields__)
    if unknown:
        raise ValueError(f"unknown rule keys: {sorted(unknown)}")
    scores = dict(DEFAULT_SCORES)
    scores.update(d.pop("scores", {}) or {})
    return Rules(**d, scores=scores).validate()


def load_rules(path: str | Path | None) -> Rules:
    if not path:
        return Rules()
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() in (".yml", ".yaml"):
        import yaml
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    return rules_from_dict(data)


def save_rules(rules: Rules, path: str | Path) -> None:
    Path(path).write_text(json.dumps(rules.to_dict(), indent=2), encoding="utf-8")
