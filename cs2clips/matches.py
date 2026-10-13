"""Official Steam Web API share-code walking + demo download.
Secrets are passed in, never logged; errors redact them."""
from __future__ import annotations
import bz2, json, urllib.error, urllib.parse, urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol
from .sharecode import is_valid, decode, MatchInfo

API = "https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1"


class ApiError(RuntimeError):
    pass


def _http_get(url: str, timeout: float = 20) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


def next_code(api_key: str, steamid: str, auth_code: str, known: str, http=_http_get) -> str | None:
    """Return the next share code after `known`, or None when there are no newer matches."""
    q = urllib.parse.urlencode({"key": api_key, "steamid": steamid, "steamidkey": auth_code, "knowncode": known})
    status, body = http(f"{API}?{q}")
    if status == 202:
        return None
    if status == 403:
        raise ApiError("Steam rejected the API key / auth code (403)")
    if status == 412:
        raise ApiError("Steam says the known share code is invalid for this account (412)")
    if status != 200:
        raise ApiError(f"Steam API error (HTTP {status})")
    code = json.loads(body or b"{}").get("result", {}).get("nextcode", "n/a")
    if code in ("n/a", "", None):
        return None
    if not is_valid(code):
        raise ApiError("Steam returned an unexpected share code format")
    return code


def walk_new_codes(api_key, steamid, auth_code, last_code, save_progress: Callable[[str], None],
                   http=_http_get, limit: int = 50) -> list[str]:
    """Follow the chain from last_code, calling save_progress(code) after each one."""
    out, cur = [], last_code
    for _ in range(limit):
        nxt = next_code(api_key, steamid, auth_code, cur, http)
        if not nxt:
            break
        out.append(nxt)
        save_progress(nxt)
        cur = nxt
    return out


class DemoResolver(Protocol):
    name: str

    def resolve(self, info: MatchInfo) -> str | None: ...


@dataclass
class PasteUrlResolver:
    """Fallback: the user pastes the demo URL (e.g. from the CS2 'Watch' tab / Leetify / csstats)."""
    ask: Callable[[str], str | None]
    name: str = "paste"

    def resolve(self, info: MatchInfo) -> str | None:
        url = (self.ask(f"Demo-URL for match {info.matchid}:") or "").strip()
        return url or None


class GameCoordinatorResolver:
    """EXPERIMENTAL. Uses ValvePython `steam` + `csgo` to ask the CS2 Game Coordinator for the replay URL.
    The user logs in interactively (password/Steam Guard typed into the prompt, never stored).
    Those libraries were written for CS:GO; CS2 GC compatibility is not guaranteed."""
    name = "gc-experimental"

    def __init__(self, timeout: float = 30):
        try:
            from steam.client import SteamClient  # noqa
            from csgo.client import CSGOClient    # noqa
        except ImportError as e:
            raise RuntimeError("Install 'steam[client]' and 'csgo' to use the experimental GC resolver") from e
        self.timeout = timeout
        self._client = None

    def _login(self):
        from steam.client import SteamClient
        from csgo.client import CSGOClient
        sc = SteamClient()
        sc.cli_login()  # interactive; nothing persisted by us
        cs = CSGOClient(sc)
        cs.launch()
        cs.wait_event("ready", timeout=self.timeout, raises=True)
        self._client = cs

    def resolve(self, info: MatchInfo) -> str | None:
        if self._client is None:
            self._login()
        cs = self._client
        cs.request_full_match_info(info.matchid, info.outcomeid, info.token)
        resp = cs.wait_event("full_match_info", timeout=self.timeout)
        if not resp:
            return None
        msg = resp[0]
        for m in getattr(msg, "matches", []):
            for rs in getattr(m, "roundstatsall", []):
                if getattr(rs, "map", ""):
                    return rs.map  # last round stats carry the replay .dem.bz2 URL
        return None


def download_demo(url: str, replays_dir: Path, name: str | None = None, http_open=urllib.request.urlopen,
                  chunk: int = 1 << 20) -> Path:
    """Stream-download a .dem.bz2 (or .dem) and write the decompressed .dem into replays_dir."""
    if not url.startswith(("http://", "https://")):
        raise ValueError("demo URL must be http(s)")
    replays_dir = Path(replays_dir); replays_dir.mkdir(parents=True, exist_ok=True)
    base = name or Path(urllib.parse.urlparse(url).path).name.removesuffix(".bz2").removesuffix(".dem")
    out = replays_dir / f"{base}.dem"
    tmp = out.with_suffix(".part")
    dec = bz2.BZ2Decompressor() if url.endswith(".bz2") else None
    with http_open(url) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(chunk)
            if not b:
                break
            f.write(dec.decompress(b) if dec else b)
    if dec and not dec.eof:
        tmp.unlink(missing_ok=True)
        raise ApiError("download incomplete (bz2 stream truncated)")
    tmp.replace(out)
    return out


def fetch_new_matches(store, resolver: DemoResolver, replays_dir: Path, on_demo: Callable[[Path], None],
                      http=_http_get, http_open=urllib.request.urlopen) -> list[Path]:
    key, sid, auth, last = (store.get(k) for k in ("steam_api_key", "steamid64", "auth_code", "last_sharecode"))
    if not (key and sid and auth and is_valid(last)):
        raise ApiError("Missing Steam API key, SteamID64, auth code or a valid latest share code")
    pending = walk_new_codes(key, sid, auth, last, lambda c: None, http)
    demos = []
    for code in pending:
        info = decode(code)
        url = resolver.resolve(info)
        if not url:
            break  # unresolved: keep progress here so the user can retry later
        p = download_demo(url, replays_dir, f"match_{info.matchid}", http_open)
        demos.append(p)
        on_demo(p)
        store.set("last_sharecode", code)  # progress saved only after the match is handled
    return demos
