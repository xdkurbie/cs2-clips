"""Tkinter GUI (NO/EN)."""
from __future__ import annotations
import subprocess, threading, time, tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from . import __version__
from .config import Settings
from .demo import find_replays_dir, list_demos, load_demo
from .detect import detect_highlights, per_player, set_map
import webbrowser
from .rules import load_rules
from .record import make_cfg, cs2_launch_args, check_offline_safety, ffmpeg_gdigrab_cmd, clip_seconds, is_cs2_running
from .montage import build_montage_cmd
from .record import wait_for_cs2
from tkinter import simpledialog
from .config import config_dir
from .secretstore import SecretStore, SecretStoreUnavailable, mask, SECRET_KEYS
from .matches import fetch_new_matches, PasteUrlResolver, download_demo

try:
    from tkinterdnd2 import TkinterDnD, DND_FILES
    _Base = TkinterDnD.Tk
except Exception:  # tkinterdnd2 missing or tkdnd binary not loadable
    _Base, DND_FILES = tk.Tk, None

T = {
    "no": {"open": "Åpne demo…", "folder": "Replays-mappe…", "player": "Spiller (SteamID/navn):", "scan": "Finn høydepunkter",
           "record": "Ta opp valgte", "montage": "Lag montasje", "warn": "CS2 kjører allerede. Lukk spillet først – appen starter CS2 selv i offline demo-modus (-insecure).",
           "none": "Ingen høydepunkter funnet.", "fetch": "Hent nye kamper", "paste": "Lim inn demo-URL", "done": "Ferdig", "lang": "English"},
    "en": {"open": "Open demo…", "folder": "Replays folder…", "player": "Player (SteamID/name):", "scan": "Find highlights",
           "record": "Record selected", "montage": "Build montage", "warn": "CS2 is already running. Close the game first – the app launches CS2 itself in offline demo mode (-insecure).",
           "none": "No highlights found.", "fetch": "Fetch new matches", "paste": "Paste demo URL", "done": "Done", "lang": "Norsk"},
}


class App(_Base):
    def __init__(self):
        super().__init__()
        self.s = Settings.load()
        self.title(f"CS2 Clips {__version__}")
        self.geometry("900x560")
        self.demo: Path | None = None
        self.hl = []
        self.clips: list[Path] = []
        self._build()
        if DND_FILES:
            try:
                self.drop_target_register(DND_FILES)
                self.dnd_bind("<<Drop>>", self._on_drop)
            except Exception:
                pass
        self.refresh_demos()
        if not self.s.onboarded:
            self.after(300, self.onboarding)

    def onboarding(self):
        no = self.s.language == "no"
        w = tk.Toplevel(self); w.title("Kom i gang" if no else "Getting started")
        steps = [
            ("1. Spillernavn" if no else "1. Player name", f"{self.s.player_name}", None),
            ("2. Replays-mappe" if no else "2. Replays folder", str(self.folder or "?"), self.pick_folder),
            ("3. (Valgfritt) Steam-nedlasting" if no else "3. (Optional) Steam download", "API key / auth code", self.steam_settings),
        ]
        for r, (a, b, cmd) in enumerate(steps):
            ttk.Label(w, text=a, font=("", 10, "bold")).grid(row=r, column=0, sticky="w", padx=8, pady=4)
            ttk.Label(w, text=b).grid(row=r, column=1, sticky="w")
            if cmd: ttk.Button(w, text="…", command=cmd).grid(row=r, column=2, padx=6)
        ttk.Button(w, text="Steam API key ↗", command=lambda: webbrowser.open("https://steamcommunity.com/dev/apikey")).grid(row=3, column=0, pady=6)
        ttk.Button(w, text="Auth code ↗", command=lambda: webbrowser.open(
            "https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128")).grid(row=3, column=1)
        def done():
            self.s.onboarded = True; self.s.save(); w.destroy()
        ttk.Button(w, text="Ferdig" if no else "Done", command=done).grid(row=4, column=1, pady=8)

    def _on_drop(self, e):
        files = [Path(f) for f in self.tk.splitlist(e.data) if f.lower().endswith(".dem")]
        if files:
            self.set_demo(files[0])

    def t(self, k): return T[self.s.language][k]

    def _build(self):
        for w in self.winfo_children(): w.destroy()
        top = ttk.Frame(self); top.pack(fill="x", padx=8, pady=6)
        ttk.Button(top, text=self.t("open"), command=self.pick_demo).pack(side="left")
        ttk.Button(top, text=self.t("folder"), command=self.pick_folder).pack(side="left", padx=4)
        ttk.Label(top, text=self.t("player")).pack(side="left", padx=(12, 2))
        self.player = tk.StringVar(value=self.s.player_name)
        ttk.Entry(top, textvariable=self.player, width=24).pack(side="left")
        ttk.Button(top, text=self.t("lang"), command=self.toggle_lang).pack(side="right")
        mid = ttk.PanedWindow(self, orient="horizontal"); mid.pack(fill="both", expand=True, padx=8)
        self.demos = tk.Listbox(mid, width=40); mid.add(self.demos, weight=1)
        self.demos.bind("<<ListboxSelect>>", lambda e: self._sel_demo())
        self.tree = ttk.Treeview(mid, columns=("score",), selectmode="extended"); mid.add(self.tree, weight=3)
        self.tree.heading("#0", text="Highlight"); self.tree.heading("score", text="Score")
        bot = ttk.Frame(self); bot.pack(fill="x", padx=8, pady=6)
        ttk.Button(bot, text=self.t("scan"), command=self.scan).pack(side="left")
        ttk.Button(bot, text=self.t("record"), command=self.record).pack(side="left", padx=4)
        ttk.Button(bot, text=self.t("montage"), command=self.montage).pack(side="left")
        ttk.Button(bot, text="Steam…", command=self.steam_settings).pack(side="left", padx=4)
        ttk.Button(bot, text=self.t("fetch"), command=self.fetch_matches).pack(side="left")
        ttk.Button(bot, text=self.t("paste"), command=self.paste_url).pack(side="left", padx=4)
        self.status = tk.StringVar(); ttk.Label(bot, textvariable=self.status).pack(side="right")

    def toggle_lang(self):
        self.s.language = "en" if self.s.language == "no" else "no"; self.s.save(); self._build(); self.refresh_demos()

    def refresh_demos(self):
        self.folder = find_replays_dir(self.s.replays_dir or None)
        self.demo_files = list_demos(self.folder)
        self.demos.delete(0, "end")
        for d in self.demo_files: self.demos.insert("end", d.name)
        self.status.set(str(self.folder or "replays: ?"))

    def _sel_demo(self):
        i = self.demos.curselection()
        if i: self.set_demo(self.demo_files[i[0]])

    def pick_demo(self):
        f = filedialog.askopenfilename(filetypes=[("CS2 demo", "*.dem")])
        if f: self.set_demo(Path(f))

    def pick_folder(self):
        d = filedialog.askdirectory()
        if d: self.s.replays_dir = d; self.s.save(); self.refresh_demos()

    def set_demo(self, p: Path):
        self.demo = p; self.status.set(p.name)

    def scan(self):
        if not self.demo: return
        nm = self.player.get().strip()
        if nm.lower() != self.s.player_name.lower():
            self.s.player_name, self.s.player_steamid = nm, ""
        self.s.save()
        self.status.set("…")
        def work():
            try:
                kills, rounds, roster, header = load_demo(self.demo)
                if self.s.resolve_player(roster) or self.s.resolve_player(kills):
                    self.s.save()
                rules = load_rules(self.s.rules_file or None)
                if not self.s.rules_file and self.s.selectivity:
                    rules.selectivity = self.s.selectivity; rules.validate()
                self.hl = detect_highlights(kills, rounds, roster, rules, self.s.player or None)
                set_map(self.hl, header.get("map_name", ""))
                self.after(0, self._show)
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e)))
        threading.Thread(target=work, daemon=True).start()

    def _show(self):
        self.tree.delete(*self.tree.get_children())
        for pl, items in per_player(self.hl).items():
            node = self.tree.insert("", "end", text=pl, open=True)
            for h in items:
                self.tree.insert(node, "end", iid=str(self.hl.index(h)), text=h.label, values=(h.score,))
                self.tree.item(str(self.hl.index(h)), text=f"{h.label}   [{' · '.join(h.chips)}]")
        self.status.set(f"{len(self.hl)}" if self.hl else self.t("none"))

    def selected(self):
        return [self.hl[int(i)] for i in self.tree.selection() if i.isdigit()]

    def store(self):
        try:
            return SecretStore(config_dir() / "secrets.json")
        except SecretStoreUnavailable as e:
            messagebox.showerror("Steam", str(e)); return None

    def steam_settings(self):
        st = self.store()
        if not st: return
        win = tk.Toplevel(self); win.title("Steam")
        labels = {"steam_api_key": "Steam Web API key", "steamid64": "SteamID64",
                  "auth_code": "Game Authentication Code", "last_sharecode": "Latest share code (CSGO-…)"}
        vars_ = {}
        for r, k in enumerate(SECRET_KEYS):
            ttk.Label(win, text=labels[k]).grid(row=r, column=0, sticky="w", padx=6, pady=3)
            v = tk.StringVar(); vars_[k] = v
            ttk.Entry(win, textvariable=v, show="•", width=44).grid(row=r, column=1, padx=6)
            ttk.Label(win, text=mask(st.get(k))).grid(row=r, column=2, padx=6)  # masked current value
        def save():
            for k, v in vars_.items():
                if v.get().strip(): st.set(k, v.get().strip())
            win.destroy()
        ttk.Button(win, text="OK", command=save).grid(row=len(SECRET_KEYS), column=1, pady=6)

    def _after_download(self, p):
        self.after(0, lambda: (self.refresh_demos(), self.set_demo(p), self.scan()))

    def fetch_matches(self):
        st = self.store()
        if not st: return
        def ask(prompt):
            res = {}
            ev = threading.Event()
            self.after(0, lambda: (res.setdefault("v", simpledialog.askstring("Demo", prompt, parent=self)), ev.set()))
            ev.wait(); return res.get("v")
        def work():
            try:
                demos = fetch_new_matches(st, PasteUrlResolver(ask), self.folder or Path.home() / "cs2-replays", self._after_download)
                self.after(0, lambda: self.status.set(f"{len(demos)} new demo(s)"))
            except Exception as e:
                self.after(0, lambda e=e: messagebox.showerror("Steam", str(e)))
        threading.Thread(target=work, daemon=True).start()

    def paste_url(self):
        url = simpledialog.askstring("Demo", "Demo URL (.dem / .dem.bz2):", parent=self)
        if not url: return
        threading.Thread(target=lambda: self._after_download(download_demo(url.strip(), self.folder or Path.home() / "cs2-replays")), daemon=True).start()

    def cfg_dir(self) -> Path:
        if self.s.cs2_cfg_dir: return Path(self.s.cs2_cfg_dir)
        return (self.folder or Path(".")).parent / "cfg"

    def record(self):
        items = self.selected()
        if not items or not self.demo: return
        if is_cs2_running():
            messagebox.showwarning("CS2", self.t("warn")); return
        out_dir = Path(self.s.output_dir or Path.home() / "Videos" / "cs2-clips"); out_dir.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._record_all, args=(items, out_dir), daemon=True).start()

    def _record_all(self, items, out_dir):
        demo_rel = f"replays/{self.demo.stem}" if self.folder and self.demo.parent == self.folder else str(self.demo)
        for n, h in enumerate(items):
            cfg = self.cfg_dir() / "cs2clips_rec.cfg"
            cfg.write_text(make_cfg(demo_rel, h), encoding="utf-8")
            args = cs2_launch_args(self.s.steam_exe, "cs2clips_rec")
            check_offline_safety(args)
            subprocess.Popen(args)
            self.after(0, lambda n=n: self.status.set(f"REC {n+1}/{len(items)} – wait for CS2…"))
            if not wait_for_cs2(timeout_s=120, settle_s=15):
                self.after(0, lambda: messagebox.showerror("CS2", "CS2 did not start within 120 s"))
                return
            out = out_dir / f"{self.demo.stem}_r{h.round}_{h.kind.replace(' ', '')}_{n}.mp4"
            secs = clip_seconds(h)
            if self.s.capture == "obs":
                from .record import ObsRecorder
                r = ObsRecorder(self.s.obs_host, self.s.obs_port, self.s.obs_password); r.start(); time.sleep(secs); out = Path(r.stop())
            else:
                subprocess.run(ffmpeg_gdigrab_cmd(out, secs))
            self.clips.append(out)
            subprocess.run(["taskkill", "/IM", "cs2.exe", "/F"], capture_output=True)
            time.sleep(5)
        self.after(0, lambda: self.status.set(self.t("done")))

    def montage(self):
        if not self.clips: return
        out = filedialog.asksaveasfilename(defaultextension=".mp4")
        if not out: return
        durs = [clip_seconds(h) for h in self.selected()] or [6.0] * len(self.clips)
        durs = (durs + [6.0] * len(self.clips))[:len(self.clips)]
        cmd = build_montage_cmd(self.clips, durs, Path(out), music=Path(self.s.music) if self.s.music else None, slowmo=self.s.slowmo)
        threading.Thread(target=lambda: (subprocess.run(cmd), self.after(0, lambda: self.status.set(self.t("done")))), daemon=True).start()


def main():
    App().mainloop()


if __name__ == "__main__":
    main()
