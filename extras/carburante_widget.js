// Carburante - widget per la schermata Home dell'iPhone (app Scriptable, gratuita).
//
// Legge il riepilogo che l'app Carburante dell'auto pubblica sul tuo canale privato ntfy.sh (<canale>-stato) e mostra:
// il distributore più economico vicino, il consumo reale, il costo al km, la spesa del mese e l'ultimo viaggio.
//
// Installazione:
//  1. Scriptable > + > incolla tutto questo file > chiamalo "Carburante".
//  2. Schermata Home > tieni premuto > + > Scriptable > widget piccolo o medio.
//  3. Tieni premuto il widget > Modifica widget: Script = Carburante, Parametro = il nome del canale della tua auto
//     (in auto: Carburante > Collega iPhone, es. auto-xxxxxxxxxxxxxxxxxxxx), senza "-stato".
// Il widget si aggiorna quando iOS lo decide (di solito ogni 15-30 minuti); l'ultimo riepilogo ricevuto resta salvato,
// così il widget mostra qualcosa anche se il canale è vuoto (ntfy.sh tiene i messaggi circa 12 ore).

const TOPIC = (args.widgetParameter || "").trim();     // oppure scrivilo qui tra le virgolette per provarlo nell'app
const fm = FileManager.local();
const cacheFile = fm.joinPath(fm.documentsDirectory(), "carburante_stato.json");

const eur = (x, d) => (x === null || x === undefined ? "–" : x.toFixed(d === undefined ? 2 : d).replace(".", ",") + " €");
const num = (x, d) => (x === null || x === undefined ? "–" : x.toFixed(d).replace(".", ","));
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? m + " min fa" : m < 1440 ? Math.round(m / 60) + " h fa" : Math.round(m / 1440) + " g fa";
};

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
  t.textColor = color || Color.white();
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

async function build() {
  const s = await loadState();
  const w = new ListWidget();
  w.backgroundColor = new Color("#101418");
  w.setPadding(12, 14, 12, 14);
  const grey = new Color("#9aa0a6"), blue = new Color("#2f7df6");
  const family = config.widgetFamily || "medium";

  const head = w.addStack();
  label(head, "⛽ Carburante", 13, blue, true);
  head.addSpacer();
  if (s) label(head, ago(s.at), 10, grey);
  w.addSpacer(6);

  if (!TOPIC) { label(w, "Imposta il canale nel parametro del widget", 12, grey); return w; }
  if (!s) { label(w, "Nessun dato ancora: accendi l'auto con l'hotspot attivo", 12, grey); return w; }

  const row = w.addStack();
  const left = row.addStack();
  left.layoutVertically();
  if (s.best) {
    label(left, eur(s.best.price, 3), family === "small" ? 22 : 26, Color.white(), true);
    label(left, s.best.brand + " · " + num(s.best.km, 1) + " km", 11, grey);
    if (family !== "small") label(left, s.best.addr, 11, grey);
  } else label(left, "Prezzi non ancora scaricati", 12, grey);
  if (family === "small") {
    w.addSpacer(4);
    label(w, "Mese " + eur(s.month ? s.month.eur : null) + (s.l100 ? " · " + num(s.l100, 1) + " l/100" : ""), 11, Color.white());
    return w;
  }
  row.addSpacer();
  const right = row.addStack();
  right.layoutVertically();
  label(right, s.l100 ? num(s.l100, 1) + " l/100 km" : "Consumo: dopo 2 pieni", 12, Color.white(), true);
  label(right, s.eurKm ? num(s.eurKm, 3) + " €/km" : "€/km: dopo 2 pieni", 11, grey);
  label(right, "Mese " + eur(s.month ? s.month.eur : null) + " · " + (s.month ? s.month.trips : 0) + " viaggi", 11, grey);
  if (s.lastTrip) label(right, "Ultimo: " + num(s.lastTrip.km, 0) + " km · " + eur(s.lastTrip.eur), 11, grey);
  if (s.range) label(right, "Autonomia " + s.range + " km", 11, s.range < 80 ? new Color("#ff9f0a") : grey);
  w.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
