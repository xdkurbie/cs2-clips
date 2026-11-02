import { useEffect, useState } from "react";
import { API_BASE, getJSON, needsBackend, sendJSON } from "./api.js";

export default function Me({ i18n }) {
  const { t } = i18n;
  const [me, setMe] = useState(null);
  const [matches, setMatches] = useState([]);
  const [authCode, setAuthCode] = useState("");
  const [shareCode, setShareCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const profile = await getJSON("/api/me");
    setMe(profile);
    const list = await getJSON("/api/me/matches");
    setMatches(list.matches || []);
  }

  useEffect(() => {
    if (needsBackend) return;
    load().catch((err) => setError(err.code || "signed_out"));
    const timer = setInterval(() => {
      getJSON("/api/me").then(setMe).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await sendJSON("/api/me/credentials", "POST", { authCode, shareCode });
      setAuthCode("");
      setShareCode("");
      await load();
    } catch (err) {
      setError(err.code || "bad_credentials");
    } finally {
      setBusy(false);
    }
  }

  async function removeCodes() {
    await sendJSON("/api/me/credentials", "DELETE");
    await load();
  }

  async function toggleChat(on) {
    await sendJSON("/api/me", "PATCH", { chatNotify: on });
    setMe((m) => ({ ...m, chatNotify: on }));
  }

  if (needsBackend) return <main className="home"><p className="err">{t.needsBackend}</p></main>;
  if (!me && error === "signed_out") {
    return (
      <main className="home">
        <h1>{t.myMatches}</h1>
        <a href={`${API_BASE}/api/auth/steam`}>{t.signIn}</a>
      </main>
    );
  }
  if (!me) return <main className="home"><p className="note">{t.parsing}</p></main>;

  return (
    <main className="home">
      <h1>{t.myMatches}</h1>
      <p className="who">
        {me.avatar ? <img src={me.avatar} alt="" width="36" height="36" /> : null}
        <span>{me.name}</span>
      </p>
      <section className="steam">
        <h2>{t.addBot}</h2>
        {me.bot?.url ? <a href={me.bot.url} target="_blank" rel="noreferrer">{me.bot.url}</a> : <p className="note">{t.botOffline}</p>}
        <p className={me.friend ? "ok" : "note"}>{me.friend ? t.friendOk : t.friendWait}</p>
        <p className="note">{t.limitedNote}</p>
      </section>
      <form className="steam" onSubmit={save}>
        <h2>{t.codes}</h2>
        {me.hasCredentials ? <p className="ok">{t.codesSaved}</p> : null}
        <label>{t.auth}<input value={authCode} autoComplete="off" spellCheck="false" onChange={(e) => setAuthCode(e.target.value)} placeholder="XXXX-XXXXX-XXXX" /></label>
        <label>{t.known}<input value={shareCode} onChange={(e) => setShareCode(e.target.value)} placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx" /></label>
        <button type="submit" disabled={busy || !me.friend}>{t.saveCodes}</button>
        {me.hasCredentials ? <button type="button" className="ghost" onClick={removeCodes}>{t.deleteCodes}</button> : null}
        <label className="check">
          <input type="checkbox" checked={!!me.chatNotify} onChange={(e) => toggleChat(e.target.checked)} />
          {t.chatToggle}
        </label>
        {error ? <p className="err">{error}</p> : null}
      </form>
      <section>
        <h2>{t.recent}</h2>
        {matches.length === 0 ? <p className="note">{t.emptyMine}</p> : null}
        <ul className="matches">
          {matches.map((m) => (
            <li key={m.id}>
              <a href={`#/m/${m.id}`}>
                <b>{(m.map || m.source || "").replace(/^de_/, "")}</b>
                <span>{m.source}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
