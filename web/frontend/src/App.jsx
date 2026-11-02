import { useEffect, useState } from "react";
import { useI18n } from "./i18n.js";
import Home from "./Home.jsx";
import MatchView from "./MatchView.jsx";
import Montage from "./Montage.jsx";

function route() {
  const raw = (location.hash || "#/").slice(1);
  const [path, query = ""] = raw.split("?");
  const q = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "m" && parts[1]) return { name: "match", id: parts[1], q };
  if (parts[0] === "montage") return { name: "montage", q };
  return { name: "home", q };
}

export default function App() {
  const i18n = useI18n();
  const [where, setWhere] = useState(route);
  useEffect(() => {
    const on = () => setWhere(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">
          <span className="mark" aria-hidden="true" />
          {i18n.t.brand}
        </a>
        <nav>
          <a href="#/">{i18n.t.back}</a>
          <a href="#/montage">{i18n.t.montage}</a>
          <button type="button" className="ghost" onClick={i18n.toggle}>{i18n.t.lang}</button>
        </nav>
      </header>
      {where.name === "match" ? <MatchView id={where.id} q={where.q} i18n={i18n} /> : null}
      {where.name === "montage" ? <Montage i18n={i18n} /> : null}
      {where.name === "home" ? <Home i18n={i18n} /> : null}
    </div>
  );
}
