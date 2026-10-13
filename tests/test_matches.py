import bz2, io, json
import pytest
from cs2clips import sharecode
from cs2clips.matches import next_code, walk_new_codes, download_demo, fetch_new_matches, ApiError, PasteUrlResolver
from cs2clips.secretstore import SecretStore, SecretStoreUnavailable, mask

# public example from the csgo-sharecode (akiver) README
CODE = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK"


def test_decode_known_public_example():
    i = sharecode.decode(CODE)
    assert (i.matchid, i.outcomeid, i.token) == (3230642215713767580, 3230647599455273103, 55788)


def test_encode_roundtrip_and_token_truncation():
    assert sharecode.encode(3230642215713767580, 3230647599455273103, 599906796) == CODE
    assert sharecode.decode(sharecode.encode(1, 2, 3)) == sharecode.MatchInfo(1, 2, 3)


@pytest.mark.parametrize("bad", ["", "CSGO-xxxx", "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x0", "GADqf-jjyJ8-cSP2r-smZRo-TO2xK"])
def test_invalid_codes(bad):
    with pytest.raises(ValueError):
        sharecode.decode(bad)


C = [sharecode.encode(100 + i, 200 + i, i) for i in range(4)]


class FakeApi:
    def __init__(self, chain, status=None):
        self.chain, self.status, self.urls = chain, status, []

    def __call__(self, url):
        self.urls.append(url)
        if self.status:
            return self.status, b""
        known = url.split("knowncode=")[1]
        i = self.chain.index(known)
        nxt = self.chain[i + 1] if i + 1 < len(self.chain) else "n/a"
        return 200, json.dumps({"result": {"nextcode": nxt}}).encode()


def test_walk_follows_chain_and_saves_progress():
    saved = []
    api = FakeApi(C)
    assert walk_new_codes("KEY", "765", "AUTH", C[0], saved.append, api) == C[1:]
    assert saved == C[1:]
    assert "key=KEY" in api.urls[0] and "steamidkey=AUTH" in api.urls[0] and "GetNextMatchSharingCode" in api.urls[0]


@pytest.mark.parametrize("status,ok", [(202, True), (403, False), (412, False), (500, False)])
def test_api_status_handling(status, ok):
    api = FakeApi(C, status)
    if ok:
        assert next_code("SECRETKEY", "1", "SECRETAUTH", C[0], api) is None
    else:
        with pytest.raises(ApiError) as e:
            next_code("SECRETKEY", "1", "SECRETAUTH", C[0], api)
        assert "SECRET" not in str(e.value)  # secrets never in error text


class FakeDpapi:
    def protect(self, b): return b"ENC" + b[::-1]
    def unprotect(self, b): assert b.startswith(b"ENC"); return b[3:][::-1]


def test_secret_store_encrypts_at_rest(tmp_path):
    s = SecretStore(tmp_path / "secrets.json", backend=FakeDpapi())
    s.set("steam_api_key", "ABCDEF123456")
    raw = (tmp_path / "secrets.json").read_text()
    assert "ABCDEF123456" not in raw and s.get("steam_api_key") == "ABCDEF123456"
    assert "ABCDEF" not in repr(s) and s.get("auth_code") == ""
    with pytest.raises(KeyError):
        s.set("password", "x")


def test_secret_store_keyring_fallback_and_refuse(tmp_path, monkeypatch):
    class KR:
        d = {}
        def set_password(self, svc, k, v): self.d[(svc, k)] = v
        def get_password(self, svc, k): return self.d.get((svc, k))
    s = SecretStore(tmp_path / "x.json", keyring_mod=KR())
    s.set("steamid64", "765"); assert s.get("steamid64") == "765" and not (tmp_path / "x.json").exists()
    import sys, builtins
    monkeypatch.setattr(sys, "platform", "linux")
    real = builtins.__import__
    monkeypatch.setattr(builtins, "__import__", lambda n, *a, **k: (_ for _ in ()).throw(ImportError()) if n == "keyring" else real(n, *a, **k))
    with pytest.raises(SecretStoreUnavailable):
        SecretStore(tmp_path / "y.json")


def test_mask():
    assert mask("ABCDEFGHIJKL").endswith("IJKL") and "ABCD" not in mask("ABCDEFGHIJKL")
    assert mask("") == "" and set(mask("abc")) == {"•"}


def _opener(payload):
    return lambda url: io.BytesIO(payload)


def test_download_decompresses_bz2(tmp_path):
    data = b"PBDEMS2\0" + b"x" * 300000
    p = download_demo("http://replay1.valve.net/730/003_1.dem.bz2", tmp_path, http_open=_opener(bz2.compress(data)), chunk=4096)
    assert p.name == "003_1.dem" and p.read_bytes() == data and not list(tmp_path.glob("*.part"))


def test_download_truncated_fails(tmp_path):
    with pytest.raises(ApiError):
        download_demo("http://h/a.dem.bz2", tmp_path, http_open=_opener(bz2.compress(b"y" * 10000)[:-20]))
    assert not list(tmp_path.iterdir())


def test_fetch_new_matches_end_to_end(tmp_path):
    s = SecretStore(tmp_path / "s.json", backend=FakeDpapi())
    for k, v in [("steam_api_key", "K"), ("steamid64", "765"), ("auth_code", "A"), ("last_sharecode", C[0])]:
        s.set(k, v)
    seen = []
    urls = iter(["http://h/m1.dem.bz2", None])
    demos = fetch_new_matches(s, PasteUrlResolver(lambda _: next(urls)), tmp_path / "replays", seen.append,
                              http=FakeApi(C), http_open=_opener(bz2.compress(b"DEMO")))
    assert [d.name for d in demos] == ["match_101.dem"] and seen == demos
    assert s.get("last_sharecode") == C[1]  # stopped at unresolved match 2, progress kept
