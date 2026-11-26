'use strict';
/**
 * report.js - the month's car costs: totals, the refuels, and the trips grouped by street of departure and street
 * of arrival ("Viale X, Rivoli -> Via Y, Torino"), as a page (HTML, printable to PDF from the phone) and a CSV.
 *
 * The streets come from the phone (phone.js): the Shortcut "CarPlay si connette" sends "lat;lon;via;comune" (the
 * departure), "CarPlay si disconnette" sends "fine;lat;lon;via;comune" (the arrival). A trip without its own
 * arrival takes the next trip's departure (the car did not move in between).
 *
 *   build(diary, year, month, groupM) -> { key: 'AAAA-MM', title, html, csv, summary: { km, eur, trips, refuels, eurKm, kml } }
 *   placeTrips(diary, places) -> how many trips got a street (places: [{ time ms, end: bool, via, comune }])
 *
 * Places: the same street (and comune) within GROUP_M metres (setting, default 300) are one place, so the house
 * numbers near each other count together ("Corso Francia 120-145, Collegno"); far apart on a long street, two places.
 *
 * Pure functions. Node 8: no ?., ?? or object spread.
 */
const LOG = require('./fuellog');

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const START_BEFORE = 30 * 60000, START_AFTER = 10 * 60000, END_BEFORE = 5 * 60000, END_AFTER = 40 * 60000;

const n2 = (x) => x.toFixed(2).replace('.', ',');
const n1 = (x) => x.toFixed(1).replace('.', ',');
const n3 = (x) => x.toFixed(3).replace('.', ',');
const eur = (x) => n2(x) + ' €';
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const csvCell = (s) => { const t = String(s === null || s === undefined ? '' : s); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const two = (x) => ('0' + x).slice(-2);
const dayText = (ms) => { const d = new Date(ms); return two(d.getDate()) + '/' + two(d.getMonth() + 1); };
const timeText = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
const placeText = (p) => (p ? [[p.via, p.civ].filter(Boolean).join(' '), p.comune].filter(Boolean).join(', ') || 'posizione senza via' : 'sconosciuta');
const M = require('./mimit');
const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
const civNum = (c) => { const n = parseInt(c, 10); return isFinite(n) ? n : null; };

/** Places into groups: same street and comune, within groupM metres of the group's first place. */
function grouper(groupM) {
    const groups = [];
    return {
        of(p) {
            if (!p) return null;
            const k = norm(p.via) + '|' + norm(p.comune);
            let g = null;
            for (let i = 0; i < groups.length && !g; i++) {
                const h = groups[i];
                if (h.k !== k) continue;
                const near = typeof p.lat === 'number' && typeof h.lat === 'number' ? M.km(p.lat, p.lon, h.lat, h.lon) * 1000 <= groupM
                    : (p.civ || '') === (h.civs[0] || '');
                if (near) g = h;
            }
            if (!g) { g = { k: k, via: p.via, comune: p.comune, lat: p.lat, lon: p.lon, civs: [] }; groups.push(g); }
            if (p.civ && g.civs.indexOf(p.civ) < 0) g.civs.push(p.civ);
            return g;
        },
        label(g) {
            if (!g) return 'sconosciuta';
            const ns = g.civs.map(civNum).filter((n) => n !== null).sort((a, b) => a - b);
            const civ = !g.civs.length ? '' : g.civs.length === 1 ? g.civs[0] : ns.length ? ns[0] + (ns[ns.length - 1] !== ns[0] ? '-' + ns[ns.length - 1] : '') : g.civs[0];
            return placeText({ via: g.via, civ: civ, comune: g.comune });
        },
    };
}

/** Streets onto the trips that have none yet, from the phone's messages. */
function placeTrips(diary, places) {
    let n = 0;
    const trips = diary.trips || [];
    const starts = places.filter((p) => !p.end), ends = places.filter((p) => p.end);
    trips.forEach((t) => {
        if (!t.from) {
            let best = null;
            starts.forEach((p) => { if (p.time >= t.start - START_BEFORE && p.time <= t.start + START_AFTER && (!best || p.time > best.time)) best = p; });
            if (best) { t.from = { via: best.via || '', civ: best.civ || '', comune: best.comune || '', lat: best.lat, lon: best.lon }; n++; }
        }
        if (!t.to) {
            let best = null;
            ends.forEach((p) => { if (p.time >= t.end - END_BEFORE && p.time <= t.end + END_AFTER && (!best || p.time < best.time)) best = p; });
            if (best) { t.to = { via: best.via || '', civ: best.civ || '', comune: best.comune || '', lat: best.lat, lon: best.lon }; n++; }
        }
    });
    return n;
}

function build(diary, year, month, groupM) {
    const G = grouper(Number(groupM) || 300);
    const inMonth = (ms) => { const d = new Date(ms); return d.getFullYear() === year && d.getMonth() === month; };
    const all = diary.trips || [];
    const trips = [];
    all.forEach((t, i) => {
        if (!inMonth(t.start)) return;
        const next = all[i + 1];
        const to = t.to || (next && next.from && next.start - t.end < 7 * 86400000 ? next.from : null);
        trips.push({ t: t, gf: G.of(t.from), gt: G.of(to) });
    });
    // labels once every place is in: a group's numbers as a range
    trips.forEach((x) => { x.from = G.label(x.gf); x.to = G.label(x.gt); });
    // grouped by departure and arrival
    const groups = {};
    trips.forEach((x) => {
        const k = x.from + ' → ' + x.to;
        const g = groups[k] || (groups[k] = { from: x.from, to: x.to, n: 0, km: 0, eur: 0, withEur: 0, min: 0 });
        g.n++; g.km += x.t.km; g.min += Math.max(0, (x.t.end - x.t.start) / 60000);
        if (typeof x.t.eur === 'number') { g.eur += x.t.eur; g.withEur++; }
    });
    const rows = Object.keys(groups).map((k) => groups[k]).sort((a, b) => b.n - a.n || b.km - a.km);
    const refuels = (diary.refuels || []).filter((r) => inMonth(r.at));
    const fuelEur = refuels.reduce((s, r) => s + (r.price ? r.litres * r.price : 0), 0);
    const km = trips.reduce((s, x) => s + x.t.km, 0);
    const tripsEur = trips.reduce((s, x) => s + (typeof x.t.eur === 'number' ? x.t.eur : 0), 0);
    const sm = LOG.summary(diary, Date.now());
    const kml = sm.l100 ? 100 / sm.l100 : null;
    const eurKm = km > 0 && tripsEur > 0 ? tripsEur / km : sm.eurKm;
    const key = year + '-' + two(month + 1), title = 'Spese auto · ' + MONTHS[month] + ' ' + year;
    const summary = { km: Math.round(km), eur: Math.round(fuelEur * 100) / 100, tripsEur: Math.round(tripsEur * 100) / 100, trips: trips.length,
        refuels: refuels.length, eurKm: eurKm, kml: kml, routes: rows.length };

    /* ---------- CSV (Excel, Numbers: ";" and "," decimals, as Italian spreadsheets read them) ---------- */
    const L = [];
    L.push(['Percorso: partenza', 'Arrivo', 'Viaggi', 'Km totali', 'Km medi', 'Minuti medi', 'Costo totale €'].join(';'));
    rows.forEach((g) => L.push([csvCell(g.from), csvCell(g.to), g.n, n1(g.km), n1(g.km / g.n), Math.round(g.min / g.n), g.withEur ? n2(g.eur) : ''].join(';')));
    L.push('');
    L.push(['Viaggio: data', 'Ora', 'Partenza', 'Arrivo', 'Km', 'Minuti', 'Litri', 'Costo €'].join(';'));
    trips.forEach((x) => L.push([dayText(x.t.start), timeText(x.t.start), csvCell(x.from), csvCell(x.to), n1(x.t.km),
        Math.round(Math.max(0, (x.t.end - x.t.start) / 60000)), typeof x.t.litres === 'number' ? n2(x.t.litres) : '', typeof x.t.eur === 'number' ? n2(x.t.eur) : ''].join(';')));
    L.push('');
    L.push(['Rifornimento: data', 'Distributore', 'Km', 'Litri', 'Prezzo €/l', 'Totale €'].join(';'));
    refuels.forEach((r) => L.push([dayText(r.at), csvCell(r.where || ''), Math.round(r.km), n1(r.litres), r.price ? n3(r.price) : '', r.price ? n2(r.litres * r.price) : ''].join(';')));
    const csv = '﻿' + L.join('\r\n') + '\r\n';

    /* ---------- the page ---------- */
    const metric = (lab, val) => '<div class="m"><div class="l">' + esc(lab) + '</div><div class="v">' + esc(val) + '</div></div>';
    const h = [];
    h.push('<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>');
    h.push('<style>body{font-family:-apple-system,system-ui,sans-serif;margin:16px;color:#1d1d1f;background:#fff}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:22px 0 8px}' +
        '.s{color:#6e6e73;font-size:13px}.g{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:12px}.m{background:#f2f2f7;border-radius:10px;padding:10px}' +
        '.l{font-size:12px;color:#6e6e73}.v{font-size:20px;font-weight:600}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#6e6e73;font-weight:500}' +
        'th,td{padding:6px 4px;border-bottom:1px solid #e5e5ea;vertical-align:top}td.r,th.r{text-align:right;white-space:nowrap}.a{color:#6e6e73}' +
        '@media print{body{margin:0}.np{display:none}}@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}.m{background:#1c1c1e}th,td{border-color:#2c2c2e}}</style></head><body>');
    h.push('<h1>' + esc(title) + '</h1><div class="s">BMW 118i · generato dall\'auto il ' + dayText(Date.now()) + ' alle ' + timeText(Date.now()) + '</div>');
    h.push('<div class="g">' + metric('Carburante', eur(fuelEur)) + metric('Km percorsi', String(Math.round(km))) +
        metric('Costo al km', eurKm ? n3(eurKm) + ' €' : '—') + metric('Consumo reale', kml ? n1(kml) + ' km/l' : '—') + '</div>');
    h.push('<h2>Percorsi (partenza → arrivo)</h2>');
    if (rows.length) {
        h.push('<table><tr><th>Percorso</th><th class="r">Viaggi</th><th class="r">Km</th><th class="r">Costo</th></tr>');
        rows.forEach((g) => h.push('<tr><td>' + esc(g.from) + '<br><span class="a">→ ' + esc(g.to) + '</span><br><span class="a">' + n1(g.km / g.n) + ' km · ' +
            Math.round(g.min / g.n) + ' min in media</span></td><td class="r">' + g.n + '</td><td class="r">' + n1(g.km) + '</td><td class="r">' + (g.withEur ? eur(g.eur) : '—') + '</td></tr>'));
        h.push('</table>');
    } else h.push('<p class="s">Nessun viaggio registrato questo mese.</p>');
    h.push('<h2>Rifornimenti</h2>');
    if (refuels.length) {
        h.push('<table><tr><th>Data</th><th>Distributore</th><th class="r">Litri</th><th class="r">Totale</th></tr>');
        refuels.forEach((r) => h.push('<tr><td>' + dayText(r.at) + '</td><td>' + esc(r.where || 'non indicato') + (r.price ? '<br><span class="a">' + n3(r.price) + ' €/l</span>' : '') +
            '</td><td class="r">' + n1(r.litres) + '</td><td class="r">' + (r.price ? eur(r.litres * r.price) : '—') + '</td></tr>'));
        h.push('</table>');
    } else h.push('<p class="s">Nessun rifornimento questo mese.</p>');
    h.push('<h2>Tutti i viaggi</h2><table><tr><th>Quando</th><th>Partenza → arrivo</th><th class="r">Km</th><th class="r">Costo</th></tr>');
    trips.forEach((x) => h.push('<tr><td>' + dayText(x.t.start) + '<br><span class="a">' + timeText(x.t.start) + '</span></td><td>' + esc(x.from) + '<br><span class="a">→ ' + esc(x.to) +
        '</span></td><td class="r">' + n1(x.t.km) + '</td><td class="r">' + (typeof x.t.eur === 'number' ? eur(x.t.eur) : '—') + '</td></tr>'));
    h.push('</table><p class="s">Costi dei viaggi stimati dal consumo reale e dall\'ultimo prezzo pagato. Vie dal telefono (Comandi Rapidi); "sconosciuta" quando il telefono non l\'ha mandata.</p>');
    h.push('<p class="s np">Per il PDF: Condividi → Stampa → Salva come PDF (o Condividi → Salva in File). Per l\'email: Condividi → Mail.</p></body></html>');
    return { key: key, title: title, html: h.join(''), csv: csv, summary: summary };
}

module.exports = { build, placeTrips, placeText, MONTHS };
