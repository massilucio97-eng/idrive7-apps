'use strict';
/**
 * trend.js - are the prices around you going up or down? From the app's own daily snapshots of the MIMIT
 * prices (the "prezzo alle 8" of every station it keeps), so no other source is needed.
 *
 * The idea: when a share of the stations around you raised their price since the day before, the others
 * usually follow within one to three days, so filling up today saves; when many lowered it, the others tend
 * to follow down, so waiting a day or two saves (if the range allows). The week's median gives the slower
 * drift when the day says nothing.
 *
 *   hist = { days: { 'AAAA-MM-GG': { <station id>: { <fuel><s|v>: price } } } }   (<data>/storico.json)
 *   record(hist, date, zone)            keeps the day's prices of the zone's stations (KEEP_DAYS days)
 *   compute(hist, zone, choice)         -> null (not enough data yet) or
 *       { kind: 'up' | 'down' | 'flat', up, down, n, avg (€/l of the moves that way), week (median change in 7 days or null),
 *         line (the app's line), short (a sentence for the notifications) }
 *
 * Pure functions. Node 8: no ?., ?? or object spread.
 */
const M = require('./mimit');

const KEEP_DAYS = 15;
const MOVE = 0.004;         // a change smaller than this (rounding, 1.799 -> 1.798) is no move
const MIN_N = 5;            // stations compared, at least
const SHARE = 0.2;          // a fifth of them moving one way, twice as many as the other way
const MAX_GAP_DAYS = 3;     // the day compared with: the latest before today, at most this old
const TANK_L = 40;          // the saving shown: on a typical fill

const fkey = (fuel, self) => fuel + (self ? 's' : 'v');
const dayMs = (d) => Date.parse(d + 'T00:00:00Z');
const cents = (x) => Math.round(Math.abs(x) * 1000) / 10;   // €/l -> cents, one decimal
const centsText = (x) => String(cents(x)).replace('.', ',') + ' cent';

function record(hist, date, zone) {
    if (!hist || !hist.days) hist = { days: {} };
    if (!date || !zone || !zone.prices) return hist;
    const day = hist.days[date] || {};
    Object.keys(zone.prices).forEach((id) => {
        const e = day[id] || {};
        zone.prices[id].forEach((p) => {
            if (!p[0]) return;
            const k = fkey(p[0], p[2]);
            if (!(k in e) || p[1] < e[k]) e[k] = p[1];
        });
        day[id] = e;
    });
    hist.days[date] = day;
    const keep = Object.keys(hist.days).sort().slice(-KEEP_DAYS);
    Object.keys(hist.days).forEach((d) => { if (keep.indexOf(d) < 0) delete hist.days[d]; });
    return hist;
}

/** The price of a station in one day's snapshot for the choice (self, servito or the cheaper of the two). */
function priceOf(snap, id, fuel, mode) {
    const e = snap && snap[id];
    if (!e) return null;
    const s = e[fkey(fuel, true)], v = e[fkey(fuel, false)];
    if (mode === 'self') return typeof s === 'number' ? s : null;
    if (mode === 'servito') return typeof v === 'number' ? v : null;
    const xs = [s, v].filter((x) => typeof x === 'number');
    return xs.length ? Math.min.apply(null, xs) : null;
}

function median(xs) {
    if (!xs.length) return null;
    const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** The stations within the choice's radius (from the phone's position when given, else the zone's centre). */
function inRadius(zone, choice) {
    const r = Number(choice.radius) || 10, out = [];
    Object.keys(zone.stations || {}).forEach((id) => {
        const s = zone.stations[id];
        const d = choice.from ? M.km(choice.from.lat, choice.from.lon, s.lat, s.lon) : s.km;
        if (d <= r) out.push(id);
    });
    return out;
}

function compute(hist, zone, choice) {
    if (!hist || !hist.days || !zone || !zone.pricesDate) return null;
    const today = zone.pricesDate, days = Object.keys(hist.days).sort();
    const snapT = hist.days[today];
    if (!snapT) return null;
    const before = days.filter((d) => d < today && dayMs(today) - dayMs(d) <= MAX_GAP_DAYS * 86400000);
    if (!before.length) return null;
    const prev = before[before.length - 1], snapP = hist.days[prev];
    const ids = inRadius(zone, choice);
    let up = 0, down = 0, n = 0, sumUp = 0, sumDown = 0;
    ids.forEach((id) => {
        const a = priceOf(snapP, id, choice.fuel, choice.mode), b = priceOf(snapT, id, choice.fuel, choice.mode);
        if (a === null || b === null) return;
        n++;
        const d = b - a;
        if (d > MOVE) { up++; sumUp += d; } else if (d < -MOVE) { down++; sumDown += d; }
    });
    if (n < MIN_N) return null;

    // the week: the median of today against the median of the day closest to 7 days before (5 to 9 days back)
    let week = null;
    const wk = days.filter((d) => { const g = (dayMs(today) - dayMs(d)) / 86400000; return g >= 5 && g <= 9; });
    if (wk.length) {
        const snapW = hist.days[wk[wk.length - 1]];
        const pt = [], pw = [];
        ids.forEach((id) => {
            const a = priceOf(snapW, id, choice.fuel, choice.mode), b = priceOf(snapT, id, choice.fuel, choice.mode);
            if (a !== null && b !== null) { pw.push(a); pt.push(b); }
        });
        if (pt.length >= MIN_N) week = median(pt) - median(pw);
    }

    const r = { up: up, down: down, n: n, week: week, since: prev, kind: 'flat', avg: 0, line: '', short: '' };
    const weekText = week === null ? '' : Math.abs(week) < 0.005 ? ' · in 7 giorni stabili'
        : ' · in 7 giorni ' + (week > 0 ? '+' : '−') + centsText(week);
    if (up / n >= SHARE && up >= 2 * down) {
        r.kind = 'up'; r.avg = sumUp / up;
        const save = (r.avg * TANK_L).toFixed(2).replace('.', ',');
        r.line = 'Prezzi in salita: ' + up + ' distributori su ' + n + ' hanno aumentato da ieri (+' + centsText(r.avg) + ' in media). ' +
            'Conviene fare il pieno oggi dove non hanno ancora aumentato (circa ' + save + ' € su ' + TANK_L + ' l)' + weekText;
        r.short = 'Prezzi in salita in zona (' + up + ' su ' + n + ' hanno aumentato): conviene fare il pieno oggi.';
    } else if (down / n >= SHARE && down >= 2 * up) {
        r.kind = 'down'; r.avg = -sumDown / down;
        r.line = 'Prezzi in calo: ' + down + ' distributori su ' + n + ' hanno abbassato da ieri (−' + centsText(r.avg) + ' in media). ' +
            'Se hai autonomia, aspetta 1-2 giorni' + weekText;
        r.short = 'Prezzi in calo in zona (' + down + ' su ' + n + ' hanno abbassato): se hai autonomia, aspetta 1-2 giorni.';
    } else if (week !== null && Math.abs(week) >= 0.02) {
        r.kind = week > 0 ? 'up' : 'down'; r.avg = Math.abs(week);
        r.line = week > 0 ? 'Prezzi in lenta salita: +' + centsText(week) + ' in 7 giorni, meglio non rimandare il pieno'
            : 'Prezzi in lento calo: −' + centsText(week) + ' in 7 giorni, se hai autonomia puoi aspettare';
        r.short = r.line + '.';
    } else {
        r.line = 'Prezzi stabili in zona (' + n + ' distributori confrontati con ieri: ' + up + ' su, ' + down + ' giù)' + weekText;
        r.short = 'Prezzi stabili in zona.';
    }
    return r;
}

/** The median price around (the choice's radius) of each kept day, oldest first, at most `days`: [['AAAA-MM-GG', €/l], ...]
 * (a day with fewer than MIN_N stations is left out). For the phone widget's chart. */
function series(hist, zone, choice, days) {
    if (!hist || !hist.days || !zone || !zone.stations) return [];
    const ids = inRadius(zone, choice), out = [];
    Object.keys(hist.days).sort().slice(-(days || 14)).forEach((d) => {
        const ps = [];
        ids.forEach((id) => { const p = priceOf(hist.days[d], id, choice.fuel, choice.mode); if (p !== null) ps.push(p); });
        if (ps.length >= MIN_N) out.push([d, Math.round(median(ps) * 1000) / 1000]);
    });
    return out;
}

module.exports = { record, compute, priceOf, series, KEEP_DAYS };
