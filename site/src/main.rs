use leptos::prelude::*;
use serde::Deserialize;

const REPO: &str = "https://github.com/xdkurbie/cs2-clips";
const REL: &str = "https://github.com/xdkurbie/cs2-clips/releases/tag/v0.2.0";
const WIN: &str = "https://github.com/xdkurbie/cs2-clips/releases/download/v0.2.0/CS2Clips-windows-x64.exe";
const WINZIP: &str = "https://github.com/xdkurbie/cs2-clips/releases/download/v0.2.0/CS2Clips-windows-x64.zip";
const MAC: &str = "https://github.com/xdkurbie/cs2-clips/releases/download/v0.2.0/CS2Clips-macos-universal.zip";

#[derive(Clone, Deserialize, PartialEq)]
struct Player { id: String, name: String, #[serde(default)] steam: String, #[serde(default)] bio: String, #[serde(default)] sample: bool }
#[derive(Clone, Deserialize, PartialEq)]
struct Clip { id: String, title: String, player: String, map: String, tags: Vec<String>, kills: u32, weapon: String, round: u32, date: String, #[serde(default)] youtube: String, #[serde(default)] video: String, #[serde(default)] sample: bool }
#[derive(Clone, Deserialize, PartialEq)]
struct Feed { players: Vec<Player>, clips: Vec<Clip> }

fn hash() -> String {
    let h = window().location().hash().unwrap_or_default();
    let h = h.trim_start_matches('#').to_string();
    if h.is_empty() { "/".into() } else { h }
}
fn site_url() -> String {
    let l = window().location();
    format!("{}{}", l.origin().unwrap_or_default(), l.pathname().unwrap_or_default())
}

fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(App);
}

#[component]
fn App() -> impl IntoView {
    let route = RwSignal::new(hash());
    let _h = window_event_listener(leptos::ev::hashchange, move |_| {
        route.set(hash());
        window().scroll_to_with_x_and_y(0.0, 0.0);
    });
    let feed = RwSignal::new(None::<Feed>);
    leptos::task::spawn_local(async move {
        if let Ok(r) = gloo_net::http::Request::get("public/clips.json").send().await {
            if let Ok(f) = r.json::<Feed>().await { feed.set(Some(f)); }
        }
    });
    provide_context(feed);
    view! {
        <Nav route/>
        <main>
        {move || {
            let r = route.get();
            let parts: Vec<String> = r.trim_matches('/').split('/').map(String::from).collect();
            match parts.as_slice() {
                [a] if a == "clips" => view!{<ClipsPage/>}.into_any(),
                [a, id] if a == "clip" => { let id = id.clone(); view!{<ClipPage id/>}.into_any() }
                [a, id] if a == "u" => { let id = id.clone(); view!{<ProfilePage id/>}.into_any() }
                [a] if a == "docs" => view!{<Docs/>}.into_any(),
                [a] if a == "download" => view!{<Download/>}.into_any(),
                [a] if a.is_empty() => view!{<Home/>}.into_any(),
                _ => view!{<section class="wrap pad"><h1>"404"</h1><p>"That page does not exist. "<a href="#/">"Go home"</a></p></section>}.into_any(),
            }
        }}
        </main>
        <Footer/>
    }
}

#[component]
fn Nav(route: RwSignal<String>) -> impl IntoView {
    let open = RwSignal::new(false);
    let cls = move |p: &'static str| move || {
        let r = route.get();
        if (p == "/" && r == "/") || (p != "/" && r.starts_with(p)) { "active" } else { "" }
    };
    view! {
        <header class="nav"><div class="wrap navin">
            <a class="brand" href="#/"><img src="public/logo.svg" alt="" width="30" height="30"/>"CS2 Clips"</a>
            <button class="burger" aria-label="Menu" on:click=move |_| open.update(|o| *o = !*o)>"☰"</button>
            <nav class:open=open on:click=move |_| open.set(false)>
                <a href="#/" class=cls("/")>"Home"</a>
                <a href="#/clips" class=cls("/clip")>"Clips"</a>
                <a href="#/u/rasu420" class=cls("/u/")>"Profile"</a>
                <a href="#/docs" class=cls("/docs")>"Docs"</a>
                <a href=REPO target="_blank" rel="noopener">"GitHub"</a>
                <a class="btn sm" href="#/download">"Download"</a>
            </nav>
        </div></header>
    }
}

#[component]
fn Home() -> impl IntoView {
    view! {
        <section class="hero"><div class="wrap herogrid">
            <div>
                <span class="pill">"v0.2.0 · now in Rust · free & open source"</span>
                <h1>"Your best CS2 rounds,"<br/><span class="grad">"clipped automatically."</span></h1>
                <p class="lead">"CS2 Clips reads your match demos, finds the aces, clutches and noscopes, and renders clips and montages on your own PC. No account, no cloud, no watermark."</p>
                <div class="ctas">
                    <a class="btn" href=WIN>"⬇ Download for Windows"</a>
                    <a class="btn ghost" href=MAC>" Download for macOS"</a>
                </div>
                <p class="muted small">"Windows x64 .exe · macOS universal .zip · "<a href=REL>"all release files"</a></p>
            </div>
            <div class="mock">
                <div class="mockbar"><i></i><i></i><i></i><span>"CS2 Clips — Highlights"</span></div>
                <div class="mockbody">
                    <div class="side"><b>"Matches"</b><b class="on">"Highlights"</b><b>"Clips"</b><b>"Montage"</b><b>"Settings"</b></div>
                    <div class="rows">
                        <div class="row"><span class="tag ace">"ACE"</span>"Mirage · R17 · AK-47"<em>"5K"</em></div>
                        <div class="row"><span class="tag clutch">"CLUTCH"</span>"Inferno · R22 · 1v3"<em>"3K"</em></div>
                        <div class="row"><span class="tag ns">"NOSCOPE"</span>"Dust II · R4 · AWP"<em>"1K"</em></div>
                        <div class="row"><span class="tag">"4K"</span>"Ancient · R9 · AK-47"<em>"4K"</em></div>
                        <div class="render"><div class="bar"></div>"Rendering montage… 64%"</div>
                    </div>
                </div>
                <p class="cap">"Illustration of the app UI"</p>
            </div>
        </div></section>

        <section class="wrap pad" id="features">
            <h2>"Everything happens on your machine"</h2>
            <div class="grid3">
                <Feature icon="🎯" title="Smart highlight detection" text="Parses .dem files and flags multikills, aces, clutches, noscopes and more. Tune the multikill window in Settings."/>
                <Feature icon="🎬" title="Clips & montages" text="Records the moments in CS2 (Windows) and stitches montages with ffmpeg — transitions included."/>
                <Feature icon="🔗" title="Match fetching" text="Uses your Steam Web API key, match auth code and latest share code to pull new matches automatically."/>
                <Feature icon="⚡" title="Native & fast" text="Rewritten in Rust for v0.2.0. Small, quick and no background bloat."/>
                <Feature icon="🔒" title="Private by default" text="No sign-up, no telemetry, no uploads unless you choose to share a clip."/>
                <Feature icon="🧩" title="Open source" text="MIT-licensed on GitHub. Read the code, file issues, send PRs."/>
            </div>
        </section>

        <section class="wrap pad" id="how">
            <h2>"How it works"</h2>
            <ol class="steps">
                <li><b>"1 · Connect"</b><p>"Paste your Steam API key, auth code and a share code. "<a href="#/docs">"Where do I find these?"</a></p></li>
                <li><b>"2 · Play"</b><p>"Play CS2 as usual. New matches are picked up and their demos are analysed."</p></li>
                <li><b>"3 · Clip & share"</b><p>"Pick highlights, render clips or a montage, then upload to YouTube and share the link here."</p></li>
            </ol>
        </section>

        <section class="wrap pad">
            <div class="rowhead"><h2>"Latest clips"</h2><a href="#/clips">"See all →"</a></div>
            <ClipGrid limit=3 player=None/>
        </section>

        <section class="wrap pad"><div class="cta-band">
            <h2>"Ready for your highlight reel?"</h2>
            <a class="btn" href="#/download">"Get CS2 Clips v0.2.0"</a>
        </div></section>
    }
}

#[component]
fn Feature(icon: &'static str, title: &'static str, text: &'static str) -> impl IntoView {
    view! { <div class="card feat"><div class="ic">{icon}</div><h3>{title}</h3><p>{text}</p></div> }
}

#[component]
fn Download() -> impl IntoView {
    view! {
        <section class="wrap pad">
            <h1>"Download CS2 Clips v0.2.0"</h1>
            <div class="grid2">
                <div class="card"><h3>"Windows (x64)"</h3><p>"Full feature set including in-game recording."</p>
                    <a class="btn" href=WIN>"CS2Clips-windows-x64.exe"</a>" "<a class="btn ghost" href=WINZIP>".zip"</a>
                    <p class="muted small">"SmartScreen may warn because the build is unsigned: More info → Run anyway."</p></div>
                <div class="card"><h3>"macOS (universal)"</h3><p>"Browse matches, find highlights and build montages. Recording CS2 requires Windows."</p>
                    <a class="btn" href=MAC>"CS2Clips-macos-universal.zip"</a>
                    <p class="muted small">"First launch: right-click the app → Open."</p></div>
            </div>
            <p>"Checksums, CLI builds and changelog: "<a href=REL>"GitHub release v0.2.0"</a>". Next: "<a href="#/docs">"setup guide"</a>"."</p>
        </section>
    }
}

fn thumb(c: &Clip) -> impl IntoView {
    let hue = c.map.bytes().fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32)) % 360;
    let style = format!("--h:{hue}");
    view! {
        <div class="thumb" style=style>
            <span class="map">{c.map.clone()}</span>
            <span class="k">{format!("{}K", c.kills)}</span>
            {c.sample.then(|| view!{<span class="sample">"SAMPLE"</span>})}
        </div>
    }
}

#[component]
fn ClipGrid(limit: usize, player: Option<String>) -> impl IntoView {
    let feed = expect_context::<RwSignal<Option<Feed>>>();
    let filter = RwSignal::new(String::new());
    let show_filters = limit > 3;
    view! {
        {show_filters.then(|| view!{
            <div class="chips">
                {["", "ace", "clutch", "noscope", "4k", "3k"].into_iter().map(|t| view!{
                    <button class="chip" class:on=move || filter.get() == t on:click=move |_| filter.set(t.to_string())>
                        {if t.is_empty() { "All".to_string() } else { t.to_string() }}</button>
                }).collect_view()}
            </div>
        })}
        <div class="grid3">
        {move || match feed.get() {
            None => view!{<p class="muted">"Loading clips…"</p>}.into_any(),
            Some(f) => {
                let ft = filter.get();
                f.clips.into_iter()
                    .filter(|c| player.as_ref().map_or(true, |p| &c.player == p))
                    .filter(|c| ft.is_empty() || c.tags.iter().any(|t| *t == ft))
                    .take(limit)
                    .map(|c| { let href = format!("#/clip/{}", c.id); let ph = format!("#/u/{}", c.player); view!{
                        <article class="card clip">
                            <a href=href.clone()>{thumb(&c)}</a>
                            <div class="cb"><a href=href class="t">{c.title.clone()}</a>
                            <div class="meta"><a href=ph>{c.player.clone()}</a>" · "{c.weapon.clone()}" · "{c.date.clone()}</div>
                            <div class="tags">{c.tags.iter().map(|t| view!{<span class="tag">{t.clone()}</span>}).collect_view()}</div></div>
                        </article>}})
                    .collect_view().into_any()
            }
        }}
        </div>
    }
}

#[component]
fn ClipsPage() -> impl IntoView {
    view! {
        <section class="wrap pad">
            <h1>"Clips"</h1>
            <div class="notice">"Demo feed: the clips below are sample entries. Real community clips are listed from "<code>"site/public/clips.json"</code>" in the GitHub repo — "<a href="#/docs">"see how to add yours"</a>"."</div>
            <ClipGrid limit=100 player=None/>
        </section>
    }
}

#[component]
fn ClipPage(id: String) -> impl IntoView {
    let feed = expect_context::<RwSignal<Option<Feed>>>();
    let copied = RwSignal::new(false);
    view! {
        <section class="wrap pad">
        {move || {
            let Some(f) = feed.get() else { return view!{<p class="muted">"Loading…"</p>}.into_any() };
            let Some(c) = f.clips.into_iter().find(|c| c.id == id) else {
                return view!{<h1>"Clip not found"</h1><a href="#/clips">"Back to clips"</a>}.into_any()
            };
            let link = format!("{}#/clip/{}", site_url(), c.id);
            let enc = js_sys_encode(&link);
            let txt = js_sys_encode(&format!("{} — CS2 Clips", c.title));
            let embed = if !c.youtube.is_empty() {
                format!("<iframe width=\"560\" height=\"315\" src=\"https://www.youtube-nocookie.com/embed/{}\" allowfullscreen></iframe>", c.youtube)
            } else { format!("<a href=\"{link}\">{} on CS2 Clips</a>", c.title) };
            let player_view = if !c.youtube.is_empty() {
                let src = format!("https://www.youtube-nocookie.com/embed/{}", c.youtube);
                view!{<div class="player"><iframe src=src allowfullscreen title="clip"></iframe></div>}.into_any()
            } else if !c.video.is_empty() {
                view!{<div class="player"><video src=c.video.clone() controls preload="metadata"></video></div>}.into_any()
            } else {
                view!{<div class="player">{thumb(&c)}<p class="ov">"Sample clip — no video attached"</p></div>}.into_any()
            };
            let l2 = link.clone();
            view!{
                <a href="#/clips" class="muted">"← All clips"</a>
                <div class="clipgrid">
                    <div>{player_view}<h1>{c.title.clone()}</h1>
                        <div class="meta"><a href=format!("#/u/{}", c.player)>{c.player.clone()}</a>" · "{c.map.clone()}" · round "{c.round}" · "{c.weapon.clone()}" · "{c.date.clone()}</div>
                        <div class="tags">{c.tags.iter().map(|t| view!{<span class="tag">{t.clone()}</span>}).collect_view()}</div>
                    </div>
                    <aside class="card">
                        <h3>"Share"</h3>
                        <div class="copy"><input readonly value=link.clone()/>
                        <button class="btn sm" on:click=move |_| { let _ = window().navigator().clipboard().write_text(&l2); copied.set(true); }>
                            {move || if copied.get() { "Copied!" } else { "Copy" }}</button></div>
                        <div class="share">
                            <a href=format!("https://twitter.com/intent/tweet?url={enc}&text={txt}") target="_blank" rel="noopener">"X / Twitter"</a>
                            <a href=format!("https://www.reddit.com/submit?url={enc}&title={txt}") target="_blank" rel="noopener">"Reddit"</a>
                            <a href=format!("https://wa.me/?text={txt}%20{enc}") target="_blank" rel="noopener">"WhatsApp"</a>
                        </div>
                        <h3>"Embed"</h3>
                        <textarea readonly rows="4">{embed}</textarea>
                    </aside>
                </div>
            }.into_any()
        }}
        </section>
    }
}

fn js_sys_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { o.push(b as char) } else { o.push_str(&format!("%{b:02X}")) }
    }
    o
}

#[component]
fn ProfilePage(id: String) -> impl IntoView {
    let feed = expect_context::<RwSignal<Option<Feed>>>();
    view! {
        <section class="wrap pad">
        {move || {
            let Some(f) = feed.get() else { return view!{<p class="muted">"Loading…"</p>}.into_any() };
            let p = f.players.iter().find(|p| p.id == id).cloned();
            let mine: Vec<&Clip> = f.clips.iter().filter(|c| c.player == id).collect();
            let kills: u32 = mine.iter().map(|c| c.kills).sum();
            let aces = mine.iter().filter(|c| c.tags.iter().any(|t| t == "ace")).count();
            let Some(p) = p else { return view!{<h1>"Player not found"</h1>}.into_any() };
            let initial = p.name.chars().next().unwrap_or('?').to_ascii_uppercase().to_string();
            view!{
                <div class="profile">
                    <div class="avatar">{initial}</div>
                    <div><h1>{p.name.clone()}{p.sample.then(|| view!{<span class="sample inline">"SAMPLE PROFILE"</span>})}</h1><p class="muted">{p.bio.clone()}</p>
                    {(!p.steam.is_empty()).then(|| view!{<a href=format!("https://steamcommunity.com/profiles/{}", p.steam) target="_blank">"Steam profile"</a>})}</div>
                </div>
                <div class="stats"><div><b>{mine.len()}</b>"clips"</div><div><b>{kills}</b>"kills clipped"</div><div><b>{aces}</b>"aces"</div></div>
                <div class="notice">"“Sign in through Steam” and personal profiles need a small backend (Steam OpenID verification). It is not live yet — see "<a href="#/docs">"Docs → Roadmap"</a>"."
                    <button class="btn sm ghost" disabled>"Sign in through Steam (coming soon)"</button></div>
                <h2>"Clips"</h2>
                <ClipGrid limit=100 player=Some(id.clone())/>
            }.into_any()
        }}
        </section>
    }
}

#[component]
fn Docs() -> impl IntoView {
    view! {
        <section class="wrap pad docs">
            <h1>"Setup guide"</h1>
            <h2>"1. Install"</h2>
            <p>"Download from the "<a href="#/download">"download page"</a>". Windows: run the .exe. macOS: unzip, move to Applications, right-click → Open the first time."</p>
            <h2>"2. Steam Web API key"</h2>
            <p>"Go to "<a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener">"steamcommunity.com/dev/apikey"</a>", register any domain name (e.g. localhost) and copy the key into Settings → Steam API key. Keep it private."</p>
            <h2>"3. Match history auth code & share code"</h2>
            <p>"Open "<a href="https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128" target="_blank" rel="noopener">"Steam Help → CS2 → match history"</a>". Create an authentication code (format "<code>"AAAA-AAAAA-AAAA"</code>") and copy your most recent match share code ("<code>"CSGO-xxxxx-…"</code>"). Paste both into Settings."</p>
            <h2>"4. CS2 path"</h2>
            <p>"Usually "<code>"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive"</code>". Use Settings → Browse if your library is elsewhere. Demos land in "<code>"game\\csgo\\replays"</code>"."</p>
            <h2>"5. ffmpeg"</h2>
            <p>"Montages use ffmpeg. Windows: "<code>"winget install Gyan.FFmpeg"</code>". macOS: "<code>"brew install ffmpeg"</code>". Then restart CS2 Clips (or set the path in Settings)."</p>
            <h2>"Share a clip on this site"</h2>
            <p>"Upload your rendered clip to YouTube (or attach the .mp4 to a GitHub release), then open a pull request adding an entry to "<a href=format!("{REPO}/blob/main/site/public/clips.json")>"site/public/clips.json"</a>" with "<code>"youtube"</code>" (video id) or "<code>"video"</code>" (direct .mp4 URL). It appears in the feed after the site rebuilds."</p>
            <h2 id="roadmap">"Roadmap: what needs a backend"</h2>
            <ul>
                <li><b>"Sign in through Steam"</b>" — Steam OpenID must be verified server-side (check_authentication). Planned as a free Cloudflare Worker written in Rust (workers-rs)."</li>
                <li><b>"One-click upload from the app"</b>" — needs storage (e.g. Cloudflare R2) and an authenticated upload endpoint."</li>
                <li><b>"Likes, follows, comments"</b>" — needs a database (e.g. Cloudflare D1)."</li>
            </ul>
            <p class="muted">"Until then everything on this site is static and the clip feed is a JSON file in the repo."</p>
        </section>
    }
}

#[component]
fn Footer() -> impl IntoView {
    view! {
        <footer><div class="wrap foot">
            <div><a class="brand" href="#/"><img src="public/logo.svg" alt="" width="24" height="24"/>"CS2 Clips"</a>
            <p class="muted small">"Fan-made, open source. Not affiliated with Valve. Counter-Strike is a trademark of Valve Corporation."</p></div>
            <div class="cols">
                <div><b>"Product"</b><a href="#/download">"Download"</a><a href="#/clips">"Clips"</a><a href="#/docs">"Docs"</a></div>
                <div><b>"Project"</b><a href=REPO>"GitHub"</a><a href=format!("{REPO}/issues")>"Issues"</a><a href=format!("{REPO}/blob/main/LICENSE")>"MIT License"</a></div>
                <div><b>"Author"</b><a href="https://xdkurbie.github.io/">"xdkurbie"</a></div>
            </div>
        </div></footer>
    }
}
