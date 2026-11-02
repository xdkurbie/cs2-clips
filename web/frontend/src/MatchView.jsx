import { useEffect, useRef, useState } from "react";
import { getJSON } from "./api.js";
import { titleOf } from "./i18n.js";
import { ReplayViewer, SPEEDS } from "./viewer/ReplayViewer.js";
import { downloadBlob, encodeMp4, mixAudio } from "./export/encode.js";

export default function MatchView({ id, q, i18n }) {
  const { t } = i18n;
  const stageRef = useRef(null);
  const teamsRef = useRef(null);
  const scrubRef = useRef(null);
  const scoreRef = useRef(null);
  const fpsRef = useRef(null);
  const viewerRef = useRef(null);
  const [meta, setMeta] = useState(null);
  const [highs, setHighs] = useState([]);
  const [focus, setFocus] = useState(q.get("steamid") || "");
  const [who, setWho] = useState("");
  const [kind, setKind] = useState("all");
  const [mode, setMode] = useState(q.get("mode") || "orbit");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [padBefore, setPadBefore] = useState(2);
  const [padAfter, setPadAfter] = useState(3);
  const [low, setLow] = useState(localStorage.getItem("cs2clips.low") === "1");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [rounds, setRounds] = useState([]);

  useEffect(() => {
    let dead = false;
    let viewer;
    (async () => {
      try {
        const [timeline, blockout, highlightBody, metaBody] = await Promise.all([
          getJSON(`/api/matches/${id}/timeline`),
          getJSON(`/api/matches/${id}/blockout`),
          getJSON(`/api/matches/${id}/highlights`),
          getJSON(`/api/matches/${id}`),
        ]);
        if (dead) return;
        setMeta(metaBody);
        setRounds(timeline.rounds || []);
        setHighs(highlightBody.highlights || []);
        const initialFocus = q.get("steamid") || metaBody.focus || timeline.players[0]?.steamid || "";
        setFocus(initialFocus);
        const roundN = Number(q.get("round") || 1);
        const round = timeline.rounds.find((r) => r.number === roundN) || timeline.rounds[0];
        const tick = Number(q.get("tick") || round?.startTick || 0);
        viewer = new ReplayViewer({
          stage: stageRef.current,
          teams: teamsRef.current,
          scrub: scrubRef.current,
          scoreLine: scoreRef.current,
          fps: fpsRef.current,
          timeline,
          blockout,
          matchId: id,
          labels: t,
          focus: initialFocus,
          mode: q.get("mode") || "orbit",
          tick,
          low,
          onPlaying: setPlaying,
        });
        viewerRef.current = viewer;
        window.__viewer = viewer;
        await viewer.ensureRound(round?.number || 1);
        viewer.start();
        viewer.seek(tick);
      } catch (err) {
        if (!dead) setError(err.code || err.message || "load");
      }
    })();
    return () => { dead = true; viewer?.dispose(); viewerRef.current = null; };
  }, [id]);

  useEffect(() => { viewerRef.current?.setLabels(t); }, [t]);

  const shown = highs.filter((h) => (!who || h.steamid === who) && (kind === "all" || h.kind === kind || (kind === "multikill" && (h.kind === "multikill" || h.kind === "ace"))));

  function playHighlight(h) {
    const v = viewerRef.current;
    if (!v) return;
    setFocus(h.steamid);
    v.setFocus(h.steamid, "follow");
    setMode("follow");
    v.seek(Math.max(0, (h.eventStart ?? h.startTick) - padBefore * (meta?.tickrate || 64)));
    v.setPlaying(true);
    setPlaying(true);
  }

  function addClip(h) {
    const rate = meta?.tickrate || 64;
    const clip = {
      id: `${h.id}-${Date.now()}`,
      matchId: id,
      title: titleOf(h, t),
      startTick: Math.max(0, (h.eventStart ?? h.startTick) - padBefore * rate),
      endTick: (h.eventEnd ?? h.endTick) + padAfter * rate,
      steamid: h.steamid,
      mode: "follow",
      filter: "none",
      text: titleOf(h, t),
      transition: "cut",
    };
    const cur = JSON.parse(localStorage.getItem("cs2clips.montage") || "[]");
    cur.push(clip);
    localStorage.setItem("cs2clips.montage", JSON.stringify(cur));
    setStatus(t.addMontage);
  }

  async function exportHighlight(h) {
    const v = viewerRef.current;
    if (!v) return;
    const rate = meta?.tickrate || 64;
    const start = Math.max(0, (h.eventStart ?? h.startTick) - padBefore * rate);
    const end = (h.eventEnd ?? h.endTick) + padAfter * rate;
    const fps = 30;
    const frameCount = Math.max(8, Math.min(20 * fps, Math.round(((end - start) / rate) * fps)));
    setStatus(t.exportClip);
    v.setPlaying(false);
    const round = (await getJSON(`/api/matches/${id}/timeline`)).rounds.find((r) => start >= r.startTick && start <= r.endTick);
    if (round) await v.ensureRound(round.number);
    const audio = await mixAudio({ duration: frameCount / fps, sfx: true, bed: true });
    const blob = await encodeMp4({
      canvas: v.canvas,
      fps,
      frameCount,
      filter: "none",
      text: titleOf(h, t),
      audio,
      draw: async (i) => {
        const tick = start + ((end - start) * i) / frameCount;
        v.renderAt(tick, { mode: "follow", steamid: h.steamid });
        return "cut";
      },
    });
    downloadBlob(blob, `${titleOf(h, t).replace(/\s+/g, "-")}.mp4`);
    setStatus("");
  }

  return (
    <div className="replay">
      <div className="chips">
        {rounds.map((r) => (
          <button
            key={r.number}
            type="button"
            className={`chip ${r.winner === "CT" ? "ct" : r.winner === "T" ? "t" : ""}`}
            onClick={() => viewerRef.current?.seek(r.startTick)}
            title={t[r.reason] || r.reason}
          >{r.number}</button>
        ))}
        <span className="scoreline" ref={scoreRef} />
        <span className="fps" ref={fpsRef} />
      </div>
      <div className="stage" ref={stageRef} />
      <aside className="side">
        <div className="teams" ref={teamsRef} />
        <div className="highs">
          <header>
            <h2>{t.highlights}</h2>
            <select value={who} onChange={(e) => { setWho(e.target.value); if (e.target.value) { setFocus(e.target.value); viewerRef.current?.setFocus(e.target.value, "follow"); setMode("follow"); } }}>
              <option value="">{t.all}</option>
              {(meta?.players || []).map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}
            </select>
          </header>
          <div className="kinds">
            {["all", "ace", "clutch", "multikill", "entry", "headshotStreak"].map((k) => (
              <button key={k} type="button" className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{k === "all" ? t.all : t[k]}</button>
            ))}
          </div>
          {shown.length === 0 ? <p className="note">{t.none}</p> : null}
          <ul>
            {shown.slice(0, 40).map((h) => (
              <li key={h.id}>
                <button type="button" className="hname" onClick={() => playHighlight(h)}>{titleOf(h, t)}</button>
                <small>{t.round} {h.round}{h.tags?.length ? ` · ${h.tags.join(" ")}` : ""}</small>
                <span>
                  <button type="button" onClick={() => exportHighlight(h)}>{t.exportClip}</button>
                  <button type="button" onClick={() => addClip(h)}>{t.addMontage}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <footer className="transport">
        <button type="button" onClick={() => { const v = viewerRef.current; v?.toggle(); setPlaying(v?.playing); }}>{playing ? t.pause : t.play}</button>
        <div className="speeds">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={speed === s ? "on" : ""} onClick={() => { setSpeed(s); viewerRef.current?.setSpeed(s); }}>{s}×</button>
          ))}
        </div>
        <canvas className="scrub" ref={scrubRef} />
        <div className="modes">
          {["orbit", "follow", "pov", "top"].map((m) => (
            <button key={m} type="button" className={mode === m ? "on" : ""} onClick={() => { setMode(m); viewerRef.current?.setMode(m); }}>{t[m]}</button>
          ))}
        </div>
        <button type="button" onClick={() => viewerRef.current?.zoom(1)}>+</button>
        <button type="button" onClick={() => viewerRef.current?.zoom(-1)}>−</button>
        <label className="pad">{t.padding}
          <input type="number" min="0" max="8" value={padBefore} onChange={(e) => setPadBefore(Number(e.target.value))} />
          <input type="number" min="0" max="8" value={padAfter} onChange={(e) => setPadAfter(Number(e.target.value))} />
        </label>
        <label className="check"><input type="checkbox" checked={low} onChange={(e) => { setLow(e.target.checked); localStorage.setItem("cs2clips.low", e.target.checked ? "1" : "0"); viewerRef.current?.setLow(e.target.checked); }} />{t.low}</label>
        <button type="button" onClick={() => { navigator.clipboard?.writeText(location.href); setStatus(t.share); }}>{t.share}</button>
        {status ? <em>{status}</em> : null}
        {error ? <em className="err">{error}</em> : null}
      </footer>
    </div>
  );
}
