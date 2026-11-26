// Carburante - widget per la schermata Home dell'iPhone (app Scriptable, gratuita).
//
// Legge il riepilogo che l'app Carburante dell'auto pubblica sul tuo canale privato ntfy.sh (<canale>-stato) e mostra:
// autonomia, consumo reale in km/l, il distributore più economico vicino e (widget medio) il prezzo della benzina in
// zona negli ultimi 14 giorni, con la curva e il consiglio: arancio se sale, verde se scende, viola se è stabile.
//
// Installazione:
//  1. Scriptable > + > incolla tutto questo file > chiamalo "Carburante".
//  2. Schermata Home > tieni premuto > + > Scriptable > widget piccolo o medio.
//  3. Tieni premuto il widget > Modifica widget: Script = Carburante, Parametro = il nome del canale della tua auto
//     (in auto: Carburante > Collega iPhone, es. auto-xxxxxxxxxxxxxxxxxxxx), senza "-stato".
// Il widget si aggiorna quando iOS lo decide (di solito ogni 15-30 minuti); l'ultimo riepilogo ricevuto resta salvato,
// così il widget mostra qualcosa anche se il canale è vuoto (ntfy.sh tiene i messaggi circa 12 ore).
// Il grafico si riempie un giorno alla volta: completo dopo 14 giorni (serve Carburante 0.9.1 o più nuovo in auto).

const TOPIC = (args.widgetParameter || "").trim();     // oppure scrivilo qui tra le virgolette per provarlo nell'app
const fm = FileManager.local();
const cacheFile = fm.joinPath(fm.documentsDirectory(), "carburante_stato.json");

const BG = new Color("#1c1c1e"), WHITE = new Color("#f5f5f7"), GREY = new Color("#8e8e93"), GRID = new Color("#3a3a3c");
const PURPLE = new Color("#7F77DD"), ORANGE = new Color("#F0997B"), GREEN = new Color("#5DCAA5"), LILAC = new Color("#AFA9EC");

const eur = (x, d) => (x === null || x === undefined ? "–" : x.toFixed(d === undefined ? 2 : d).replace(".", ",") + " €");
const num = (x, d) => (x === null || x === undefined ? "–" : x.toFixed(d).replace(".", ","));
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? m + " min fa" : m < 1440 ? Math.round(m / 60) + " h fa" : Math.round(m / 1440) + " g fa";
};
// "2026-11-12" -> "12/11"
const dm = (d) => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d || ""); return m ? m[2] + "/" + m[1] : ""; };

async function loadState() {
  let state = null;
  if (/^[a-z0-9-]{20,64}$/.test(TOPIC)) {
    try {
      const r = new Request("https://ntfy.sh/" + TOPIC + "-stato/json?poll=1&since=24h");
      r.timeoutInterval = 15;
      const text = await r.loadString();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.event !== "message") continue;
        let s;
        try { s = JSON.parse(m.message); } catch (e) { continue; }
        if (s && s.v === 1 && (!state || s.at > state.at)) state = s;
      }
    } catch (e) { /* offline: the saved one */ }
  }
  if (state) fm.writeString(cacheFile, JSON.stringify(state));
  else if (fm.fileExists(cacheFile)) { try { state = JSON.parse(fm.readString(cacheFile)); } catch (e) { state = null; } }
  return state;
}

function label(stack, text, size, color, bold) {
  const t = stack.addText(text);
  t.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color || WHITE;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

/** The trend's look: colour, arrow, advice. */
function look(s) {
  const k = s.trend ? s.trend.kind : null;
  if (k === "up") return { c: ORANGE, arrow: "arrow.up.right", tip: "In salita: fai il pieno oggi" };
  if (k === "down") return { c: GREEN, arrow: "arrow.down.right", tip: "In calo: puoi aspettare 1-2 giorni" };
  if (k === "flat") return { c: LILAC, arrow: "arrow.right", tip: "Prezzi stabili in zona" };
  return { c: LILAC, arrow: "arrow.right", tip: "Andamento: dati in arrivo" };
}

/** The 14 days' curve as an image (w x h points, drawn at 3x). */
function chart(series, color, w, h) {
  const k = 3, dc = new DrawContext();
  dc.size = new Size(w * k, h * k);
  dc.opaque = false;
  dc.respectScreenScale = false;
  const ps = series.map((x) => x[1]);
  let lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
  if (hi - lo < 0.01) { const m = (hi + lo) / 2; lo = m - 0.005; hi = m + 0.005; }       // a flat line stays in the middle
  const padT = 6 * k, padB = 14 * k, padX = 4 * k;
  const X = (i) => padX + (series.length < 2 ? (w * k - 2 * padX) : i * (w * k - 2 * padX) / (series.length - 1));
  const Y = (p) => padT + (hi - p) / (hi - lo) * (h * k - padT - padB);
  // the base line and the middle price, dashed
  dc.setFillColor(GRID); dc.fillRect(new Rect(0, h * k - padB, w * k, k));
  const mid = (hi + lo) / 2, ym = Y(mid);
  dc.setFillColor(new Color("#2c2c2e"));
  for (let x = 0; x < w * k; x += 5 * k) dc.fillRect(new Rect(x, ym, 2 * k, k));
  dc.setTextColor(GREY); dc.setFont(Font.systemFont(9 * k)); dc.setTextAlignedRight();
  dc.drawTextInRect(num(mid, 2), new Rect(0, ym - 12 * k, w * k - 2 * k, 11 * k));
  // the curve
  const path = new Path();
  series.forEach((x, i) => { const pt = new Point(X(i), Y(x[1])); if (i) path.addLine(pt); else path.move(pt); });
  dc.addPath(path); dc.setStrokeColor(color); dc.setLineWidth(2.2 * k); dc.strokePath();
  const last = series.length - 1;
  dc.setFillColor(color);
  dc.fillEllipse(new Rect(X(last) - 3.5 * k, Y(series[last][1]) - 3.5 * k, 7 * k, 7 * k));
  // the first day and today
  dc.setTextColor(GREY); dc.setFont(Font.systemFont(9 * k));
  dc.setTextAlignedLeft(); dc.drawTextInRect(dm(series[0][0]), new Rect(0, h * k - 12 * k, 60 * k, 11 * k));
  dc.setTextAlignedRight(); dc.drawTextInRect("oggi", new Rect(w * k - 60 * k, h * k - 12 * k, 60 * k, 11 * k));
  return dc.getImage();
}

async function build() {
  const s = await loadState();
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.setPadding(14, 16, 14, 16);
  const family = config.widgetFamily || "medium";

  if (!TOPIC) { label(w, "Imposta il canale nel parametro del widget", 12, GREY); return w; }
  if (!s) { label(w, "Nessun dato ancora: accendi l'auto con l'hotspot attivo", 12, GREY); return w; }
  const kml = s.kml || (s.l100 ? 100 / s.l100 : null);
  const lk = look(s);

  const row = w.addStack();
  // ---------- left: range, km/l, the cheapest station ----------
  const left = row.addStack();
  left.layoutVertically();
  left.size = family === "small" ? new Size(0, 0) : new Size(118, 0);
  const head = left.addStack();
  label(head, "⛽ Carburante", 12, PURPLE, true);
  left.addSpacer();
  label(left, s.range ? s.range + " km" : "– km", 26, s.range && s.range < 80 ? ORANGE : WHITE, true);
  label(left, kml ? num(kml, 1) + " km/l reali" : "km/l dopo 2 pieni", 12, GREY);
  left.addSpacer();
  if (s.best) {
    label(left, eur(s.best.price, 3) + " · " + s.best.brand, 12, WHITE, true);
    label(left, (s.best.addr || "") + " · " + num(s.best.km, 1) + " km", 11, GREY);
  } else label(left, "Prezzi non ancora scaricati", 11, GREY);
  if (family === "small") { label(left, ago(s.at), 9, GREY); return w; }

  row.addSpacer(12);
  // ---------- right: the price around, 14 days ----------
  const right = row.addStack();
  right.layoutVertically();
  label(right, "Benzina in zona · 14 gg", 12, GREY);
  const series = (s.series || []).filter((x) => x && typeof x[1] === "number");
  const pr = right.addStack();
  pr.centerAlignContent();
  if (series.length) {
    const today = series[series.length - 1][1], first = series[0][1], dc = (today - first) * 100;
    label(pr, eur(today, 3), 17, WHITE, true);
    pr.addSpacer(6);
    const ic = pr.addImage(SFSymbol.named(lk.arrow).image);
    ic.imageSize = new Size(11, 11); ic.tintColor = lk.c;
    pr.addSpacer(2);
    label(pr, Math.abs(dc) < 0.05 ? "stabili" : (dc > 0 ? "+" : "−") + num(Math.abs(dc), 1) + " cent", 12, lk.c);
  } else label(pr, "in arrivo", 17, WHITE, true);
  right.addSpacer(2);
  if (series.length >= 2) {
    const img = right.addImage(chart(series, lk.c, 180, 64));
    img.imageSize = new Size(180, 64);
  } else {
    right.addSpacer();
    label(right, "Il grafico si riempie un giorno alla volta", 11, GREY);
    right.addSpacer();
  }
  label(right, lk.tip, 12, lk.c);
  w.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
