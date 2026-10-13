import json, subprocess, shutil
import pandas as pd, pytest
from pathlib import Path
from cs2clips.detect import detect_highlights, per_player
from cs2clips.rules import Rules, rules_from_dict, load_rules
from cs2clips.record import make_cfg, cs2_launch_args, check_offline_safety, ffmpeg_gdigrab_cmd
from cs2clips.montage import build_montage_cmd
from cs2clips.config import Settings

A = "76561198000000001"
CT = [A] + [f"7656119800000000{i}" for i in range(2, 6)]
T_ = [f"7656119800000001{i}" for i in range(0, 5)]
NAMES = {s: ("rasu420" if s == A else f"p{s[-2:]}") for s in CT + T_}


def kill(tick, rnd, att, vic, hs=False, pen=0, ns=False, w="ak47"):
    return dict(tick=tick, round=rnd, attacker_steamid=att, attacker_name=NAMES[att], attacker_team=3 if att in CT else 2,
                user_steamid=vic, user_name=NAMES[vic], user_team=3 if vic in CT else 2,
                headshot=hs, penetrated=pen, noscope=ns, weapon=w)


def roster(rnd):
    return pd.DataFrame([dict(round=rnd, steamid=s, name=NAMES[s], team=3 if s in CT else 2) for s in CT + T_])


def test_ace_and_all_hs():
    k = pd.DataFrame([kill(1000 + i * 64, 1, A, T_[i], hs=True) for i in range(5)])
    hl = detect_highlights(k, roster=roster(1))
    assert [h.kind for h in hl] == ["ace"] and "all HS" in hl[0].tags and hl[0].kills == 5


@pytest.mark.parametrize("n,kind", [(2, "2k"), (3, "3k"), (4, "4k")])
def test_multikills(n, kind):
    k = pd.DataFrame([kill(1000 + i * 64, 1, A, T_[i]) for i in range(n)])
    assert detect_highlights(k)[0].kind == kind


def test_time_window_splits_chain():
    k = pd.DataFrame([kill(1000, 1, A, T_[0]), kill(1064, 1, A, T_[1]), kill(1000 + 64 * 30, 1, A, T_[2])])
    hl = detect_highlights(k, rules=Rules(multikill_window_s=5))
    assert [h.kind for h in hl] == ["2k"]
    assert detect_highlights(k)[0].kind == "3k"


def test_wallbang_noscope_and_ignores_teamkill():
    k = pd.DataFrame([kill(500, 2, A, T_[0], pen=1), kill(5000, 2, A, T_[1], ns=True, w="awp"), kill(9000, 2, A, CT[1])])
    kinds = sorted(h.kind for h in detect_highlights(k))
    assert kinds == ["2k", "noscope", "wallbang"]  # teamkill not counted (else 3k)


def test_clutch_1v5():
    # A's 4 teammates die, 3 T alive -> A kills all 3, CT wins
    k = [kill(100 + i, 3, T_[0], CT[i + 1]) for i in range(2)] + [kill(110, 3, T_[1], CT[3]), kill(120, 3, T_[3], CT[4]),
         kill(130, 3, A, T_[4])]
    k += [kill(200 + i * 64, 3, A, T_[i]) for i in range(3)]
    rounds = pd.DataFrame([dict(round=3, start_tick=0, end_tick=1000, winner=3)])
    r = roster(3)
    hl = detect_highlights(pd.DataFrame(k), rounds, r)
    cl = [h for h in hl if h.kind.startswith("clutch")]
    assert cl and cl[0].kind == "clutch 1v5" and cl[0].steamid == A
    rounds.loc[0, "winner"] = 2
    assert not [h for h in detect_highlights(pd.DataFrame(k), rounds, r) if h.kind.startswith("clutch")]


def test_player_filter_name_case_insensitive_and_steamid():
    k = pd.DataFrame([kill(1, 1, A, T_[0]), kill(2, 1, A, T_[1]), kill(3, 1, T_[2], CT[1]), kill(4, 1, T_[2], CT[2])])
    assert {h.steamid for h in detect_highlights(k, player="RASU420")} == {A}
    assert {h.steamid for h in detect_highlights(k, player=A)} == {A}
    assert len(per_player(detect_highlights(k))) == 2


def test_default_player_resolves_steamid_and_persists(tmp_path):
    s = Settings()
    assert s.player_name == "rasu420" and s.player == "rasu420"
    assert s.resolve_player(pd.DataFrame({"name": ["Someone", "Rasu420"], "steamid": ["1", A]}))
    assert s.player_steamid == A and s.player == A
    s.save(tmp_path / "s.json")
    s2 = Settings.load(tmp_path / "s.json")
    assert s2.player_steamid == A and not s2.resolve_player(pd.DataFrame({"name": ["rasu420"], "steamid": ["9"]}))


def test_rules_config(tmp_path):
    r = rules_from_dict({"min_multikill": 3, "scores": {"ace": 500}})
    assert r.min_multikill == 3 and r.scores["ace"] == 500 and r.scores["2k"] == 20
    with pytest.raises(ValueError): rules_from_dict({"bogus": 1})
    with pytest.raises(ValueError): rules_from_dict({"min_multikill": 7})
    (tmp_path / "r.json").write_text(json.dumps({"pre_roll_s": 1}))
    assert load_rules(tmp_path / "r.json").pre_roll_s == 1
    (tmp_path / "r.yaml").write_text("min_score: 50\n")
    assert load_rules(tmp_path / "r.yaml").min_score == 50
    assert load_rules(Path(__file__).parents[1] / "rules.example.yaml").scores["ace"] == 120


def test_min_score():
    k = pd.DataFrame([kill(1, 1, A, T_[0]), kill(2, 1, A, T_[1])])
    assert detect_highlights(k, rules=Rules(min_score=100)) == []


def test_cfg_and_launch():
    k = pd.DataFrame([kill(1000, 1, A, T_[0]), kill(1064, 1, A, T_[1])])
    h = detect_highlights(k)[0]
    cfg = make_cfg("replays/match1", h)
    assert 'playdemo "replays/match1"' in cfg and f"demo_gototick {h.start_tick}" in cfg and f"spec_player {A}" in cfg
    assert h.start_tick == 1000 - 4 * 64
    args = cs2_launch_args("steam.exe", "cs2clips_rec")
    assert "-insecure" in args and args[-2:] == ["+exec", "cs2clips_rec"]
    check_offline_safety(args)
    with pytest.raises(RuntimeError): check_offline_safety([a for a in args if a != "-insecure"])
    with pytest.raises(RuntimeError): check_offline_safety(args + ["+connect", "1.2.3.4"])


def test_ffmpeg_cmds():
    c = ffmpeg_gdigrab_cmd(Path("o.mp4"), 6.5)
    assert c[c.index("-f") + 1] == "gdigrab" and "title=Counter-Strike 2" in c and "6.50" in c
    m = build_montage_cmd([Path("a.mp4"), Path("b.mp4")], [5, 6], Path("o.mp4"), music=Path("m.mp3"), slowmo=0.5)
    fc = m[m.index("-filter_complex") + 1]
    assert "xfade=transition=fade:duration=0.5:offset=9.500" in fc and "sidechaincompress" in fc and "setpts=2*PTS" in fc
    with pytest.raises(ValueError): build_montage_cmd([Path("a")], [1, 2], Path("o"))


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg missing")
def test_montage_runs_with_ffmpeg(tmp_path):
    clips = []
    for i in range(2):
        p = tmp_path / f"c{i}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2",
                        "-pix_fmt", "yuv420p", str(p)], check=True)
        clips.append(p)
    music = tmp_path / "m.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:duration=3", str(music)], check=True)
    out = tmp_path / "out.mp4"
    subprocess.run(build_montage_cmd(clips, [2, 2], out, music=music, slowmo=0.5) + ["-loglevel", "error"], check=True)
    assert out.stat().st_size > 1000
