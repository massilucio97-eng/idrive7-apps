'use strict';
/**
 * mimit.js - the MIMIT open data (Osservaprezzi carburanti, IODL 2.0), read line by line.
 *
 * Two files, published every morning, the field separator "|" since 10 February 2026, the first line
 * "Estrazione del AAAA-MM-GG", the second the column names:
 *   anagrafica_impianti_attivi.csv  idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine
 *   prezzo_alle_8.csv               idImpianto|descCarburante|prezzo|isSelf|dtComu
 * Some names hold a "|" themselves: the station line is read from both ends (the id first, the address, the
 * comune, the province and the coordinates last), the name is what is left in the middle.
 *
 * Pure functions: no network, no files (test: tools in the commit message). Node 8: no ?., ?? or spread.
 */

const FUELS = {
    benzina: /^benzina$/i,
    gasolio: /^gasolio$/i,
    gpl: /^gpl$/i,
    metano: /^metano$/i,
};
const KEEP_KM = 25;          // stations kept around the zone's centre (the largest radius is 20 km)

function num(s) {
    const n = parseFloat(String(s || '').trim().replace(',', '.'));
    return isFinite(n) ? n : null;
}
const inItaly = (lat, lon) => lat > 35 && lat < 48 && lon > 6 && lon < 19.5;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** One station line -> { id, name, brand, addr, comune, prov, lat, lon } or null (header, broken line, no coordinates). */
function station(line) {
    const f = String(line).split('|');
    if (f.length < 10 || !/^\d+$/.test(f[0].trim())) return null;
    const n = f.length;
    const lat = num(f[n - 2]), lon = num(f[n - 1]);
    if (lat === null || lon === null || !inItaly(lat, lon)) return null;
    return {
        id: f[0].trim(),
        brand: clean(f[2]),
        name: clean(f.slice(4, n - 5).join(' ')),
        addr: clean(f[n - 5]),
        comune: clean(f[n - 4]).toUpperCase(),
        prov: clean(f[n - 3]).toUpperCase(),
        lat: lat, lon: lon,
    };
}

/** One price line -> { id, fuel, price, self, at } or null. fuel: one of FUELS' keys, or null for any other. */
function price(line) {
    const f = String(line).split('|');
    if (f.length < 5 || !/^\d+$/.test(f[0].trim())) return null;
    const p = num(f[2]);
    if (p === null || p < 0.3 || p > 5) return null;           // a typo in the data (0.001, 1789)
    const desc = clean(f[1]);
    let fuel = null;
    Object.keys(FUELS).forEach((k) => { if (FUELS[k].test(desc)) fuel = k; });
    return { id: f[0].trim(), fuel: fuel, price: p, self: f[3].trim() === '1', at: clean(f[4]) };
}

/** "Estrazione del 2026-11-24" -> "2026-11-24" (or null) */
function extraction(line) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(String(line || ''));
    return m ? m[1] : null;
}

/** km between two points (haversine) */
function km(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The station file, a line at a time, for one zone: a comune's name (centre: the mean of its own stations) or a
 * point { lat, lon } (the phone's position: centre that point); done() -> { centre: {lat, lon, n}, stations:
 * {id: station + km} } with the stations within KEEP_KM.
 */
function zoneReader(where) {
    const point = where && typeof where === 'object' && isFinite(where.lat) && isFinite(where.lon) ? where : null;
    const want = point ? null : String(where).toUpperCase();
    const all = [];
    let sLat = 0, sLon = 0, n = 0, date = null, lines = 0;
    return {
        line(l) {
            lines++;
            if (lines === 1) { date = extraction(l); return; }
            const s = station(l);
            if (!s) return;
            all.push(s);
            if (want !== null && s.comune === want) { sLat += s.lat; sLon += s.lon; n++; }
        },
        done() {
            if (!point && !n) return { date: date, centre: null, stations: {}, total: all.length };
            const c = point ? { lat: point.lat, lon: point.lon, n: 0 } : { lat: sLat / n, lon: sLon / n, n: n };
            const out = {};
            all.forEach((s) => {
                const d = km(c.lat, c.lon, s.lat, s.lon);
                if (d <= KEEP_KM) { s.km = Math.round(d * 10) / 10; out[s.id] = s; }
            });
            return { date: date, centre: c, stations: out, total: all.length };
        },
    };
}

/** The price file, a line at a time, kept for the zone's stations only: done() -> { date, prices: {id: [[fuel, price, self, at], ...]} } */
function priceReader(stations) {
    const prices = {};
    let date = null, lines = 0;
    return {
        line(l) {
            lines++;
            if (lines === 1) { date = extraction(l); return; }
            const p = price(l);
            if (!p || !p.fuel || !stations[p.id]) return;
            (prices[p.id] = prices[p.id] || []).push([p.fuel, p.price, p.self, p.at]);
        },
        done() { return { date: date, prices: prices }; },
    };
}

/**
 * The cheapest stations for a choice: { fuel, mode ('self' | 'servito' | 'any'), radius (km), max, from } -> (from:
 * { lat, lon }, the distances measured again from there - the phone's newer position; else the zone's own)
 * [{ id, name, brand, addr, comune, km, price, self, at }], cheapest first (then nearest).
 */
function cheapest(zone, choice) {
    const out = [];
    const radius = Number(choice.radius) || 10, max = choice.max || 10;
    Object.keys(zone.prices || {}).forEach((id) => {
        const s = zone.stations[id];
        if (!s) return;
        const dkm = choice.from ? Math.round(km(choice.from.lat, choice.from.lon, s.lat, s.lon) * 10) / 10 : s.km;
        if (dkm > radius) return;
        let best = null;
        zone.prices[id].forEach((p) => {
            if (p[0] !== choice.fuel) return;
            if (choice.mode === 'self' && !p[2]) return;
            if (choice.mode === 'servito' && p[2]) return;
            if (!best || p[1] < best[1]) best = p;
        });
        if (best) out.push({ id: id, name: s.name, brand: s.brand, addr: s.addr, comune: s.comune, km: dkm, price: best[1], self: best[2], at: best[3] });
    });
    out.sort((a, b) => (a.price - b.price) || (a.km - b.km));
    return out.slice(0, max);
}

module.exports = { station, price, extraction, km, zoneReader, priceReader, cheapest, FUELS, KEEP_KM };
