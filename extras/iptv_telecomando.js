// IPTV Telecomando - sfoglia sull'iPhone tutta la tua playlist Xtream (TV in diretta, film, serie) e la fai partire
// sullo schermo della BMW (app IPTV 0.5.0 o più nuova, pagina "Telefono"). App Scriptable, gratuita.
//
// Installazione:
//  1. Scriptable > + > incolla tutto questo file > chiamalo esattamente "IPTV Telecomando".
//  2. In auto: IPTV > Telefono. Inquadra il codice con la fotocamera dell'iPhone: si apre questo script già collegato
//     alla tua auto (oppure, la prima volta, scrivi a mano il canale "tv-..." che vedi sotto il codice).
//  3. La prima volta inserisci server, utente e password Xtream (gli stessi del tuo abbonamento): restano nel
//     Portachiavi di questo iPhone, non passano dall'auto né da altri servizi.
// Il telefono parla direttamente con il server IPTV per le liste; all'auto manda solo "guarda questo" attraverso il tuo
// canale privato ntfy.sh. L'immagine in auto resta visibile solo da fermo (o al passeggero se l'hai attivato in IPTV).
// Facoltativo: aggiungilo alla schermata Home (Scriptable > ... > Aggiungi a Home) e a Siri.

const K = { server: "iptv_server", user: "iptv_user", pass: "iptv_pass", topic: "iptv_topic" };
const fm = FileManager.local();
const dir = fm.joinPath(fm.documentsDirectory(), "iptv_telecomando");
if (!fm.fileExists(dir)) fm.createDirectory(dir);
const FAV_FILE = fm.joinPath(dir, "preferiti.json");

const kget = (k) => (Keychain.contains(k) ? Keychain.get(k) : "");
const qp = (args.queryParameters || {});
if (qp.topic && /^tv-[a-z2-7]{20}$/.test(qp.topic)) Keychain.set(K.topic, qp.topic);

/* ---------- setup ---------- */
async function setup(force) {
  let server = kget(K.server), user = kget(K.user), pass = kget(K.pass), topic = kget(K.topic);
  if (!force && server && user && pass && topic) return true;
  const a = new Alert();
  a.title = "IPTV Telecomando";
  a.message = "Server, utente e password del tuo abbonamento Xtream, e il canale dell'auto (IPTV > Telefono, inizia con tv-).";
  a.addTextField("http://server:porta", server);
  a.addTextField("utente", user);
  a.addSecureTextField("password", pass);
  a.addTextField("tv-...", topic);
  a.addAction("Salva");
  a.addCancelAction("Annulla");
  if ((await a.present()) < 0) return !!(server && user && pass && topic);
  server = a.textFieldValue(0).trim().replace(/\/+$/, "");
  if (server && !/^https?:\/\//i.test(server)) server = "http://" + server;
  user = a.textFieldValue(1).trim(); pass = a.textFieldValue(2); topic = a.textFieldValue(3).trim().toLowerCase();
  if (!/^tv-[a-z2-7]{20}$/.test(topic)) { await note("Il canale non è valido: deve essere come tv-xxxxxxxxxxxxxxxxxxxx."); return false; }
  Keychain.set(K.server, server); Keychain.set(K.user, user); Keychain.set(K.pass, pass); Keychain.set(K.topic, topic);
  for (const f of fm.listContents(dir)) if (f.startsWith("cache_")) fm.remove(fm.joinPath(dir, f));
  return true;
}
async function note(text) { const a = new Alert(); a.message = text; a.addAction("OK"); await a.present(); }

/* ---------- the Xtream server (cached on the phone) ---------- */
async function api(action, extra, cacheMin) {
  const q = "player_api.php?username=" + encodeURIComponent(kget(K.user)) + "&password=" + encodeURIComponent(kget(K.pass)) +
    "&action=" + action + (extra || "");
  const file = fm.joinPath(dir, "cache_" + (action + (extra || "")).replace(/[^a-z0-9_]/gi, "_") + ".json");
  if (cacheMin && fm.fileExists(file) && (Date.now() - fm.modificationDate(file).getTime()) < cacheMin * 60000) {
    try { return JSON.parse(fm.readString(file)); } catch (e) { /* load again */ }
  }
  const r = new Request(kget(K.server) + "/" + q);
  r.timeoutInterval = 60;
  const j = await r.loadJSON();
  if (cacheMin) fm.writeString(file, JSON.stringify(j));
  return j;
}
const b64 = (s) => { try { return Data.fromBase64String(s).toRawString(); } catch (e) { return s || ""; } };
const hm = (ts) => { const d = new Date(Number(ts) * 1000); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); };
const mins = (s) => (s ? Math.round(s / 60) + " min" : "");
const clock = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, x = t % 60; return (h ? h + ":" + ("0" + m).slice(-2) : m) + ":" + ("0" + x).slice(-2); };

/* ---------- the car ---------- */
async function send(cmd) {
  const r = new Request("https://ntfy.sh/" + kget(K.topic) + "-cmd");
  r.method = "POST";
  r.body = JSON.stringify(Object.assign({ v: 1 }, cmd));
  r.timeoutInterval = 15;
  try { await r.load(); return true; } catch (e) { await note("Non riesco a mandare il comando: " + e.message); return false; }
}
async function nowPlaying() {
  try {
    const r = new Request("https://ntfy.sh/" + kget(K.topic) + "-ora/json?poll=1&since=15m");
    r.timeoutInterval = 10;
    const text = await r.loadString();
    let best = null;
    for (const line of text.split("\n")) {
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.event !== "message") continue;
      let s; try { s = JSON.parse(m.message); } catch (e) { continue; }
      if (s && s.v === 1 && (!best || s.at > best.at)) best = s;
    }
    return best;
  } catch (e) { return null; }
}

/* ---------- favourites ---------- */
function favs() { try { return JSON.parse(fm.readString(FAV_FILE)); } catch (e) { return []; } }
function isFav(t, id) { return favs().some((f) => f.t === t && String(f.id) === String(id)); }
function toggleFav(item) {
  let l = favs();
  if (l.some((f) => f.t === item.t && String(f.id) === String(item.id))) l = l.filter((f) => !(f.t === item.t && String(f.id) === String(item.id)));
  else l.unshift(item);
  fm.writeString(FAV_FILE, JSON.stringify(l.slice(0, 60)));
}

/* ---------- the screens ---------- */
const table = new UITable();
table.showSeparators = true;
const stack = [];
const PURPLE = new Color("#7F77DD"), GREY = Color.gray();

function header(title, sub) {
  const r = new UITableRow(); r.isHeader = true; r.height = sub ? 64 : 50;
  const c = r.addText(title, sub || null); c.titleFont = Font.boldSystemFont(22); if (sub) { c.subtitleFont = Font.systemFont(13); c.subtitleColor = GREY; }
  table.addRow(r);
}
function row(title, sub, onSelect, opts) {
  opts = opts || {};
  const r = new UITableRow(); r.height = opts.height || (sub ? 62 : 48); r.dismissOnSelect = false;
  if (opts.img) { const i = r.addImageAtURL(opts.img); i.widthWeight = 14; }
  else if (opts.icon) { const i = r.addImage(SFSymbol.named(opts.icon).image); i.widthWeight = 8; i.tintColor = opts.tint || PURPLE; }
  const c = r.addText(title, sub || null); c.widthWeight = 70; c.titleFont = Font.semiboldSystemFont(16);
  if (sub) { c.subtitleFont = Font.systemFont(13); c.subtitleColor = GREY; }
  if (opts.fav) { const b = r.addButton(isFav(opts.fav.t, opts.fav.id) ? "★" : "☆"); b.widthWeight = 10; b.onTap = () => { toggleFav(opts.fav); render(); }; }
  if (onSelect) r.onSelect = onSelect;
  table.addRow(r);
  return r;
}
function back() { if (stack.length > 1) { stack.pop(); render(); } }
function go(screen) { stack.push(screen); render(); }

async function render() {
  table.removeAllRows();
  const s = stack[stack.length - 1];
  if (stack.length > 1) row("‹ Indietro", null, back, { icon: "chevron.left" });
  try { await s(); } catch (e) { row("Errore: " + e.message, "Controlla server, utente e password (Impostazioni)", null, { icon: "exclamationmark.triangle", tint: Color.orange() }); }
  table.reload();
}

async function nowBar() {
  const s = await nowPlaying();
  if (!s || s.state === "idle" || !s.name) { row("In auto: niente in riproduzione", "Scegli qualcosa qui sotto", () => render(), { icon: "car" }); return; }
  const what = s.kind === "live" ? "TV" : s.kind === "episode" ? "Serie" : "Film";
  const tm = s.dur ? clock(s.pos) + " / " + clock(s.dur) : "";
  row("In auto: " + s.name, [what, s.state === "paused" ? "in pausa" : s.state === "playing" ? "in riproduzione" : s.state, tm, s.picture === false ? "immagine solo da fermo" : ""].filter(Boolean).join(" · "),
    () => render(), { icon: s.state === "paused" ? "pause.circle" : "play.circle" });
  const r = new UITableRow(); r.height = 46; r.dismissOnSelect = false;
  const btns = s.kind === "live"
    ? [["▲", { op: "prev" }], ["▼", { op: "next" }], ["⏹", { op: "stop" }]]
    : [["-30s", { op: "seek", by: -30 }], [s.state === "paused" ? "▶︎" : "⏸", { op: s.state === "paused" ? "resume" : "pause" }], ["+30s", { op: "seek", by: 30 }], ["⏹", { op: "stop" }]];
  btns.forEach((b) => { const x = r.addButton(b[0]); x.centerAligned(); x.onTap = async () => { await send(b[1]); setTimeout(render, 2500); }; });
  table.addRow(r);
}

// home
async function home() {
  header("IPTV in auto", "Scegli e guarda sullo schermo della BMW");
  await nowBar();
  row("TV in diretta", "Canali per categoria, con il programma in onda", () => go(() => cats("live")), { icon: "dot.radiowaves.left.and.right" });
  row("Film", "Per categoria, con trama e durata", () => go(() => cats("vod")), { icon: "film" });
  row("Serie TV", "Stagioni ed episodi", () => go(() => cats("series")), { icon: "tv" });
  row("Cerca", "In canali, film e serie", () => doSearch(), { icon: "magnifyingglass" });
  const fv = favs();
  row("Preferiti", fv.length ? fv.length + " salvati" : "Tocca ☆ accanto a un canale, film o serie", () => go(favScreen), { icon: "star" });
  row("Impostazioni", "Server, utente, password, canale dell'auto", async () => { if (await setup(true)) render(); }, { icon: "gearshape", tint: GREY });
}
const ACT = { live: ["get_live_categories", "get_live_streams"], vod: ["get_vod_categories", "get_vod_streams"], series: ["get_series_categories", "get_series"] };
const TITLE = { live: "TV in diretta", vod: "Film", series: "Serie TV" };
async function cats(kind) {
  header(TITLE[kind]);
  const l = await api(ACT[kind][0], "", 360);
  (l || []).forEach((c) => row(c.category_name, null, () => go(() => items(kind, c.category_id, c.category_name)), { icon: "folder" }));
}
async function items(kind, cat, name) {
  header(name);
  const l = await api(ACT[kind][1], "&category_id=" + encodeURIComponent(cat), kind === "live" ? 120 : 360);
  if (kind === "live") {
    // what is on now, for the first channels (the guide is asked once per channel)
    const first = (l || []).slice(0, 40);
    const epg = {};
    await Promise.all(first.map(async (c) => {
      try { const e = await api("get_short_epg", "&stream_id=" + c.stream_id + "&limit=1", 20); const x = (e.epg_listings || [])[0]; if (x) epg[c.stream_id] = b64(x.title) + " · " + hm(x.start_timestamp) + "-" + hm(x.stop_timestamp); } catch (e) { /* no guide */ }
    }));
    (l || []).forEach((c) => liveRow(c, epg[c.stream_id]));
  } else if (kind === "vod") (l || []).forEach((f) => filmRow(f));
  else (l || []).forEach((sr) => seriesRow(sr));
}
function liveRow(c, now) {
  row(c.name, now || "Tocca per guardare in auto", async () => { if (await send({ op: "live", id: String(c.stream_id), name: c.name })) { await note("In auto: " + c.name); render(); } },
    { img: c.stream_icon || null, icon: c.stream_icon ? null : "tv", fav: { t: "live", id: c.stream_id, name: c.name, icon: c.stream_icon || "", ext: "" } });
}
function filmRow(f) {
  row(f.name, [f.rating ? "★ " + f.rating : "", f.year || ""].filter(Boolean).join(" · ") || "Tocca per i dettagli", () => go(() => film(f)),
    { img: f.stream_icon || null, icon: f.stream_icon ? null : "film", height: 72, fav: { t: "vod", id: f.stream_id, name: f.name, icon: f.stream_icon || "", ext: f.container_extension || "mp4" } });
}
function seriesRow(sr) {
  row(sr.name, [sr.rating ? "★ " + sr.rating : "", sr.releaseDate ? String(sr.releaseDate).slice(0, 4) : ""].filter(Boolean).join(" · ") || "Tocca per le stagioni", () => go(() => series(sr)),
    { img: sr.cover || null, icon: sr.cover ? null : "tv", height: 72, fav: { t: "series", id: sr.series_id, name: sr.name, icon: sr.cover || "", ext: "" } });
}
async function film(f) {
  const d = await api("get_vod_info", "&vod_id=" + f.stream_id, 720);
  const info = (d && d.info) || {}, md = (d && d.movie_data) || {};
  const dur = Number(info.duration_secs) || 0;
  header(f.name, [info.releasedate ? String(info.releasedate).slice(0, 4) : "", info.genre || "", mins(dur), info.rating ? "★ " + info.rating : ""].filter(Boolean).join(" · "));
  if (info.movie_image) { const r = new UITableRow(); r.height = 220; const i = r.addImageAtURL(info.movie_image); i.centerAligned(); table.addRow(r); }
  row("▶︎  Guarda in auto", "Riprende da dove eri rimasto, se l'avevi iniziato in auto", async () => {
    if (await send({ op: "film", id: String(md.stream_id || f.stream_id), ext: md.container_extension || f.container_extension || "mp4", name: f.name, duration: dur })) { await note("In auto: " + f.name); stack.splice(1); render(); }
  }, { icon: "play.fill" });
  row(isFav("vod", f.stream_id) ? "★  Nei preferiti" : "☆  Aggiungi ai preferiti", null, () => { toggleFav({ t: "vod", id: f.stream_id, name: f.name, icon: f.stream_icon || "", ext: f.container_extension || "mp4" }); render(); }, { icon: "star" });
  if (info.plot) { const r = new UITableRow(); r.height = Math.min(260, 40 + info.plot.length / 2); const c = r.addText(info.plot); c.titleFont = Font.systemFont(14); table.addRow(r); }
  if (info.cast) row("Cast", info.cast, null, { icon: "person.2", tint: GREY, height: 70 });
  if (info.director) row("Regia", info.director, null, { icon: "megaphone", tint: GREY });
}
async function series(sr) {
  const d = await api("get_series_info", "&series_id=" + sr.series_id, 360);
  const eps = (d && d.episodes) || {};
  const seasons = Object.keys(eps).sort((a, b) => Number(a) - Number(b));
  header(sr.name, seasons.length + (seasons.length === 1 ? " stagione" : " stagioni") + (sr.rating ? " · ★ " + sr.rating : ""));
  row(isFav("series", sr.series_id) ? "★  Nei preferiti" : "☆  Aggiungi ai preferiti", null, () => { toggleFav({ t: "series", id: sr.series_id, name: sr.name, icon: sr.cover || "", ext: "" }); render(); }, { icon: "star" });
  seasons.forEach((n) => row("Stagione " + n, (eps[n] || []).length + " episodi", () => go(() => episodes(sr, n, eps[n] || [])), { icon: "list.number" }));
}
async function episodes(sr, n, list) {
  header(sr.name, "Stagione " + n);
  list.forEach((e, i) => {
    const num = e.episode_num || i + 1, dur = Number(e.info && e.info.duration_secs) || 0;
    row(num + ". " + (e.title || "Episodio " + num), [mins(dur), "tocca per guardare in auto"].filter(Boolean).join(" · "), async () => {
      const name = sr.name + "  S" + n + " E" + num;
      if (await send({ op: "episode", id: String(e.id), ext: e.container_extension || "mp4", name, duration: dur })) { await note("In auto: " + name); stack.splice(1); render(); }
    }, { img: (e.info && e.info.movie_image) || null, icon: (e.info && e.info.movie_image) ? null : "play.rectangle", height: 66 });
  });
}
async function favScreen() {
  header("Preferiti");
  const l = favs();
  if (!l.length) { row("Nessun preferito", "Tocca ☆ accanto a un canale, un film o una serie", null, { icon: "star" }); return; }
  l.forEach((f) => {
    if (f.t === "live") liveRow({ stream_id: f.id, name: f.name, stream_icon: f.icon });
    else if (f.t === "vod") filmRow({ stream_id: f.id, name: f.name, stream_icon: f.icon, container_extension: f.ext });
    else seriesRow({ series_id: f.id, name: f.name, cover: f.icon });
  });
}
async function doSearch() {
  const a = new Alert(); a.title = "Cerca"; a.addTextField("nome del canale, film o serie"); a.addAction("Cerca"); a.addCancelAction("Annulla");
  if ((await a.present()) < 0) return;
  const q = a.textFieldValue(0).trim().toLowerCase();
  if (q.length < 2) return;
  go(async () => {
    header("Cerca: " + q);
    const [lv, vd, sr] = await Promise.all([api("get_live_streams", "", 360), api("get_vod_streams", "", 720), api("get_series", "", 720)]);
    const hit = (n) => String(n || "").toLowerCase().indexOf(q) >= 0;
    const L = (lv || []).filter((c) => hit(c.name)).slice(0, 30), V = (vd || []).filter((f) => hit(f.name)).slice(0, 30), S = (sr || []).filter((x) => hit(x.name)).slice(0, 30);
    if (!L.length && !V.length && !S.length) { row("Nessun risultato", null, null, { icon: "magnifyingglass" }); return; }
    if (L.length) { header("TV in diretta"); L.forEach((c) => liveRow(c)); }
    if (V.length) { header("Film"); V.forEach((f) => filmRow(f)); }
    if (S.length) { header("Serie TV"); S.forEach((x) => seriesRow(x)); }
  });
}

/* ---------- start ---------- */
if (await setup(false)) {
  stack.push(home);
  await render();
  await table.present(true);
} else await note("Senza server, utente, password e canale dell'auto il telecomando non può funzionare. Riaprilo per inserirli.");
Script.complete();
