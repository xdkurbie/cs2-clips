import { useEffect, useState } from "react";
import { getJSON } from "./api.js";
import { FILTERS } from "./api.js";
import { ReplayViewer } from "./viewer/ReplayViewer.js";
import { downloadBlob, encodeMp4, mixAudio } from "./export/encode.js";

function load() {
  try { return JSON.parse(localStorage.getItem("cs2clips.montage") || "[]"); }
  catch { return []; }
}

export default function Montage({ i18n }) {
  const { t } = i18n;
  const [clips, setClips] = useState(load);
  const [music, setMusic] = useState(null);
  const [sfx, setSfx] = useState(true);
  const [bed, setBed] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => localStorage.setItem("cs2clips.montage", JSON.stringify(clips)), [clips]);

  function patch(id, part) {
    setClips((list) => list.map((c) => c.id === id ? { ...c, ...part } : c));
  }
  function move(id, dir) {
    setClips((list) => {
      const i = list.findIndex((c) => c.id === id);
      const j = i + dir;
      if (j < 0 || j >= list.length) return list;
      const next = list.slice();
      const [item] = next.splice(i, 1);
      next.splice(j, 0, item);
      return next;
    });
  }

  async function exportClips() {
    if (!clips.length) return;
    setStatus(t.exportMp4);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-9999px;top:0;width:1280px;height:720px";
    document.body.appendChild(host);
    const viewers = new Map();
    let glCanvas = null;
    async function prepare(matchId) {
      if (viewers.has(matchId)) return viewers.get(matchId);
      const [timeline, blockout] = await Promise.all([
        getJSON(`/api/matches/${matchId}/timeline`),
        getJSON(`/api/matches/${matchId}/blockout`),
      ]);
      const stage = document.createElement("div");
      stage.style.cssText = "width:1280px;height:720px";
      host.appendChild(stage);
      const viewer = new ReplayViewer({
        stage, teams: document.createElement("div"), timeline, blockout, matchId, low: true, labels: t,
      });
      viewer.resize();
      viewers.set(matchId, viewer);
      glCanvas = viewer.canvas;
      return viewer;
    }
    const fps = 30;
    const pieces = clips.map((c) => ({
      ...c,
      frames: Math.max(8, Math.min(10 * fps, Math.round(((c.endTick - c.startTick) / 64) * fps))),
    }));
    const frameCount = pieces.reduce((s, p) => s + p.frames, 0);
    let musicBuffer = null;
    if (music) musicBuffer = music;
    const audio = await mixAudio({ musicBuffer, duration: frameCount / fps, sfx, bed });
    await prepare(pieces[0].matchId);
    const look = { filter: pieces[0].filter, text: pieces[0].text || "" };
    const blob = await encodeMp4({
      canvas: viewers.get(pieces[0].matchId).canvas,
      fps,
      frameCount,
      audio,
      look,
      draw: async (i) => {
        let left = i;
        let piece = pieces[0];
        for (const p of pieces) {
          if (left < p.frames) { piece = p; break; }
          left -= p.frames;
        }
        look.filter = piece.filter || "none";
        look.text = piece.text || "";
        const v = await prepare(piece.matchId);
        const round = v.timeline.rounds.find((r) => piece.startTick <= r.endTick && piece.endTick >= r.startTick) || v.timeline.rounds[0];
        if (round) await v.ensureRound(round.number);
        const tick = piece.startTick + ((piece.endTick - piece.startTick) * left) / Math.max(1, piece.frames);
        v.renderAt(tick, { mode: piece.mode || "follow", steamid: piece.steamid });
        return left < 8 ? (piece.transition || "cut") : "cut";
      },
    });
    downloadBlob(blob, "montasje.mp4");
    for (const v of viewers.values()) v.dispose();
    host.remove();
    setStatus("");
    void glCanvas;
  }

  return (
    <main className="montage">
      <h1>{t.montage}</h1>
      <p className="note">{t.mapNote}</p>
      {clips.length === 0 ? <p>{t.none}</p> : null}
      <ol>
        {clips.map((c, i) => (
          <li key={c.id}>
            <strong>{i + 1}. {c.title}</strong>
            <label>{t.transition}
              <select value={c.transition} onChange={(e) => patch(c.id, { transition: e.target.value })}>
                <option value="cut">cut</option>
                <option value="crossfade">crossfade</option>
                <option value="whip">whip</option>
              </select>
            </label>
            <label>{t.filter}
              <select value={c.filter} onChange={(e) => patch(c.id, { filter: e.target.value })}>
                {Object.keys(FILTERS).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label>{t.text}<input value={c.text || ""} onChange={(e) => patch(c.id, { text: e.target.value })} /></label>
            <button type="button" onClick={() => move(c.id, -1)}>{t.up}</button>
            <button type="button" onClick={() => move(c.id, 1)}>{t.down}</button>
            <button type="button" onClick={() => setClips(clips.filter((x) => x.id !== c.id))}>{t.remove}</button>
          </li>
        ))}
      </ol>
      <label>{t.music}<input type="file" accept="audio/*" onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file) return setMusic(null);
        const ctx = new AudioContext();
        setMusic(await ctx.decodeAudioData(await file.arrayBuffer()));
      }} /></label>
      <label className="check"><input type="checkbox" checked={sfx} onChange={(e) => setSfx(e.target.checked)} />{t.sfx}</label>
      <label className="check"><input type="checkbox" checked={bed} onChange={(e) => setBed(e.target.checked)} />{t.bed}</label>
      <p className="note">SFX and the soft bed are original synthesis, released CC0. Upload your own music for the bed you want to keep.</p>
      <button type="button" disabled={clips.length < 1 || !!status} onClick={exportClips}>{t.exportMp4}</button>
      {status ? <em>{status}</em> : null}
    </main>
  );
}
