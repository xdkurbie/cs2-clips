"""Pure-Python CS2/CS:GO match share code codec (format is public; written from the spec)."""
from __future__ import annotations
import re
from dataclasses import dataclass

ALPHABET = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789"
PATTERN = re.compile(r"^CSGO(-[%s]{5}){5}$" % ALPHABET)


@dataclass(frozen=True)
class MatchInfo:
    matchid: int
    outcomeid: int
    token: int


def is_valid(code: str) -> bool:
    return bool(PATTERN.match(code or ""))


def decode(code: str) -> MatchInfo:
    if not is_valid(code):
        raise ValueError("invalid share code")
    n = 0
    for c in reversed(code[5:].replace("-", "")):
        n = n * len(ALPHABET) + ALPHABET.index(c)
    b = n.to_bytes(18, "big")
    return MatchInfo(int.from_bytes(b[0:8], "little"), int.from_bytes(b[8:16], "little"),
                     int.from_bytes(b[16:18], "little"))


def encode(matchid: int, outcomeid: int, token: int) -> str:
    b = matchid.to_bytes(8, "little") + outcomeid.to_bytes(8, "little") + (token & 0xFFFF).to_bytes(2, "little")
    n = int.from_bytes(b, "big")
    s = ""
    for _ in range(25):
        n, r = divmod(n, len(ALPHABET))
        s += ALPHABET[r]
    return "CSGO-" + "-".join(s[i:i + 5] for i in range(0, 25, 5))
