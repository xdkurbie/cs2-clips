import { useEffect, useState } from "react";
import { getJSON, uploadDemo } from "./api.js";

const ERRORS = {
  expired: "expired",
  gc_unconfigured: "gcOff",
  gc_unavailable: "gcOff",
  bad_demo: "empty",
};

export default function Home({ i18n }) {
  const { t } = i18n;
  const [matches, setMatches] = useState([]);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [found, setFound] = useState([]);
  const [form, setForm] = useState(() => ({
    steamid64: localStorage.getItem("cs2clips.steamid") || "",
    authCode: sessionStorage.getItem("cs2clips.auth") || "",
    knownCode: localStorage.getItem("cs2clips.known") || "",
  }));

  useEffect(() => {
    getJSON("/api/matches").then((d) => setMatches(d.matches || [])).catch(() => {});
  }, []);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === "steamid64") localStorage.setItem("cs2clips.steamid", value);
    if (key === "knownCode") localStorage.setItem("cs2clips.known", value);
    if (key === "authCode") sessionStorage.setItem("cs2clips.auth", value);
  }

  async function onFile(file) {
    if (!file) return;
    setBusy(t.parsing);
    setError("");
    try {
      const body = await uploadDemo(file, form.steamid64, setProgress);
      location.hash = `#/m/${body.match.id}`;
    } catch (err) {
      setError(t[ERRORS[err.code]] || err.code || "parse");
      setBusy("");
    }
  }

  async function fetchCodes(e) {
    e.preventDefault();
    setBusy(t.fetch);
    setError("");
    try {
      const res = await fetch("/api/steam/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) throw Object.assign(new Error(body.error), { code: body.error });
      setFound(body.matches || []);
      if (!body.matches?.length) setError(t.knownHint);
    } catch (err) {
      setError(t[ERRORS[err.code]] || err.code || "steam");
    } finally {
      setBusy("");
    }
  }

  async function download(code) {
    setBusy(t.parsing);
    setError("");
    try {
      const res = await fetch("/api/steam/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareCode: code, steamid64: form.steamid64 }),
      });
      const body = await res.json();
      if (!res.ok) throw Object.assign(new Error(body.error), { code: body.error });
      location.hash = `#/m/${body.match.id}`;
    } catch (err) {
      setError(t[ERRORS[err.code]] || t.expired);
      setBusy("");
    }
  }

  return (
    <main className="home">
      <section className="hero">
        <h1>{t.brand}</h1>
        <p>{t.tagline}</p>
        <p className="note">{t.mapNote}</p>
      </section>
      <section
        className="drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
      >
        <strong>{t.upload}</strong>
        <p>{t.drop}</p>
        <input type="file" accept=".dem,.bz2,.dem.bz2" onChange={(e) => onFile(e.target.files?.[0])} />
        {busy ? <em>{busy} {progress ? `${Math.round(progress * 100)}%` : ""}</em> : null}
      </section>
      <form className="steam" onSubmit={fetchCodes}>
        <h2>{t.steam}</h2>
        <label>{t.steamid}<input value={form.steamid64} inputMode="numeric" pattern="\d{17}" onChange={(e) => setField("steamid64", e.target.value)} placeholder="7656119…" /></label>
        <label>{t.auth}<input value={form.authCode} autoComplete="off" spellCheck="false" onChange={(e) => setField("authCode", e.target.value)} placeholder="XXXX-XXXXX-XXXX" /></label>
        <small>{t.authHint}</small>
        <label>{t.known}<input value={form.knownCode} onChange={(e) => setField("knownCode", e.target.value)} placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx" /></label>
        <small>{t.knownHint}</small>
        <button type="submit" disabled={!!busy}>{t.fetch}</button>
        {error ? <p className="err">{error}</p> : null}
        <ul className="codes">
          {found.map((m) => (
            <li key={m.code}>
              <code>{m.code}</code>
              <button type="button" onClick={() => download(m.code)}>{t.upload}</button>
            </li>
          ))}
        </ul>
      </form>
      <section>
        <h2>{t.recent}</h2>
        {matches.length === 0 ? <p className="note">{t.empty}</p> : null}
        <ul className="matches">
          {matches.map((m) => (
            <li key={m.id}>
              <a href={`#/m/${m.id}`}>
                <b>{(m.map || "").replace(/^de_/, "")}</b>
                <span>{m.roundCount} · {m.killCount} {t.kills}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
