import { useEffect, useState } from "react";
import { API_BASE, getJSON, needsBackend, uploadDemo } from "./api.js";

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
  useEffect(() => {
    getJSON("/api/matches").then((d) => setMatches(d.matches || [])).catch(() => {});
  }, []);

  async function onFile(file) {
    if (!file) return;
    setBusy(t.parsing);
    setError("");
    try {
      const body = await uploadDemo(file, "", setProgress);
      location.hash = `#/m/${body.match.id}`;
    } catch (err) {
      setError(t[ERRORS[err.code]] || err.code || "parse");
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
      {needsBackend ? <p className="err">{t.needsBackend}</p> : (
        <section className="steam">
          <h2>{t.steam}</h2>
          <p>{t.signInHint}</p>
          <a href={`${API_BASE}/api/auth/steam`}>{t.signIn}</a>
          {error ? <p className="err">{error}</p> : null}
        </section>
      )}
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
