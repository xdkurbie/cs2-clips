"""ffmpeg montage command builder (xfade transitions, music with ducking, slow-mo)."""
from __future__ import annotations
from pathlib import Path


def build_montage_cmd(clips: list[Path], durations: list[float], out: Path, *, transition: str = "fade",
                      tdur: float = 0.5, music: Path | None = None, music_volume: float = 0.6,
                      duck: bool = True, slowmo: float = 1.0, clips_have_audio: bool = False, ffmpeg: str = "ffmpeg") -> list[str]:
    if not clips or len(clips) != len(durations):
        raise ValueError("need clips with matching durations")
    if not 0.1 <= slowmo <= 1.0:
        raise ValueError("slowmo factor must be 0.1..1.0 (1 = normal)")
    cmd = [ffmpeg, "-y"]
    for c in clips:
        cmd += ["-i", str(c)]
    if music:
        cmd += ["-stream_loop", "-1", "-i", str(music)]
    n = len(clips)
    f = []
    pts = 1.0 / slowmo
    durs = [d * pts for d in durations]
    for i in range(n):
        f.append(f"[{i}:v]setpts={pts:g}*PTS,fps=60,format=yuv420p,scale=1920:1080:force_original_aspect_ratio=decrease,"
                 f"pad=1920:1080:(ow-iw)/2:(oh-ih)/2,settb=AVTB[v{i}]")
        if not clips_have_audio:
            f.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{durs[i]:.3f}[a{i}]")
            continue
        f.append(f"[{i}:a]atempo={slowmo:g},aresample=48000[a{i}]" if slowmo >= 0.5 else
                 f"[{i}:a]atempo={max(slowmo*2,0.5):g},atempo=0.5,aresample=48000[a{i}]")
    vlast, alast, offset = "v0", "a0", 0.0
    for i in range(1, n):
        offset += durs[i - 1] - tdur
        f.append(f"[{vlast}][v{i}]xfade=transition={transition}:duration={tdur:g}:offset={offset:.3f}[vx{i}]")
        f.append(f"[{alast}][a{i}]acrossfade=d={tdur:g}[ax{i}]")
        vlast, alast = f"vx{i}", f"ax{i}"
    total = sum(durs) - tdur * (n - 1)
    if music:
        m = f"[{n}:a]volume={music_volume:g},atrim=0:{total:.3f},afade=t=out:st={max(total-2,0):.3f}:d=2[m]"
        f.append(m)
        if duck:
            f.append(f"[{alast}]asplit=2[g1][g2]")
            f.append("[m][g1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[md]")
            f.append("[g2][md]amix=inputs=2:duration=first:dropout_transition=0[aout]")
        else:
            f.append(f"[{alast}][m]amix=inputs=2:duration=first[aout]")
        alast = "aout"
    cmd += ["-filter_complex", ";".join(f), "-map", f"[{vlast}]", "-map", f"[{alast}]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", str(out)]
    return cmd
