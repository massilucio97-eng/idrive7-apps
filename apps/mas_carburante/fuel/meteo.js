'use strict';
/**
 * meteo.js - the weather for the welcome: Open-Meteo (open-meteo.com, free, no key, CC BY 4.0), the temperature
 * now and the next 12 hours, for a point (the phone's position or the zone's centre). Kept in <data>/meteo.json.
 *
 *   const m = METEO.start(http, dataDir, log);
 *   m.refresh({ lat, lon }, place)      at most every 30 min for the same place
 *   m.card() -> { icon, lab, val, sub } | null (nothing yet, or older than 3 h)
 *
 * Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');

const EVERY_MS = 30 * 60 * 1000, OLD_MS = 3 * 3600 * 1000, RAIN_P = 50;

/** WMO weather code -> [icon, text] */
function kindOf(code) {
    const c = Number(code);
    if (c === 0) return ['sun', 'sereno'];
    if (c === 1) return ['sun', 'poco nuvoloso'];
    if (c === 2) return ['cloud', 'parz. nuvoloso'];
    if (c === 3) return ['cloud', 'coperto'];
    if (c === 45 || c === 48) return ['cloud', 'nebbia'];
    if (c >= 51 && c <= 57) return ['rain', 'pioggerella'];
    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return ['rain', 'pioggia'];
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ['snow', 'neve'];
    if (c >= 95) return ['rain', 'temporale'];
    return ['cloud', ''];
}
const isSnow = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const isWet = (c) => (c >= 51 && c <= 67) || (c >= 71 && c <= 86) || c >= 95;

/** The card from an Open-Meteo answer, at time now. */
function cardOf(w, place, now) {
    if (!w || !w.current) return null;
    const cur = w.current, k = kindOf(cur.weather_code);
    const temp = Math.round(Number(cur.temperature_2m));
    let sub = k[1];
    const h = w.hourly || {}, times = h.time || [], pp = h.precipitation_probability || [], codes = h.weather_code || [];
    const nowH = new Date(now).getHours(), curC = Number(cur.weather_code);
    if (isWet(curC)) sub = isSnow(curC) ? 'nevica adesso' : 'piove adesso';
    else {
        for (let i = 0; i < times.length; i++) {
            const c = Number(codes[i]);
            if (!isWet(c) || (pp[i] !== undefined && pp[i] !== null && Number(pp[i]) < RAIN_P)) continue;
            const hh = Number(String(times[i]).slice(11, 13));
            sub = hh === nowH ? (isSnow(c) ? 'nevica adesso' : 'piove adesso') : (isSnow(c) ? 'neve' : 'pioggia') + ' dalle ' + ('0' + hh).slice(-2);
            break;
        }
    }
    return { icon: sub.indexOf('neve') >= 0 || sub.indexOf('nevica') >= 0 ? 'snow' : sub.indexOf('piov') >= 0 || sub.indexOf('pioggia') >= 0 ? 'rain' : k[0],
        lab: 'Meteo' + (place ? ' ' + place : ''), val: (isFinite(temp) ? temp : '?') + '°', sub: sub };
}

function start(http, dataDir, log) {
    const file = path.join(dataDir || '.', 'meteo.json');
    let kept = null, busy = false;
    try { kept = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { kept = null; }
    const key = (p) => p.lat.toFixed(2) + ',' + p.lon.toFixed(2);
    return {
        refresh(p, place) {
            if (!p || busy || !http.online()) return Promise.resolve();
            if (kept && kept.key === key(p) && Date.now() - kept.at < EVERY_MS) return Promise.resolve();
            busy = true;
            const q = '/v1/forecast?latitude=' + p.lat.toFixed(3) + '&longitude=' + p.lon.toFixed(3) +
                '&current=temperature_2m,weather_code&hourly=precipitation_probability,weather_code&forecast_hours=12&timezone=Europe%2FRome';
            let body = '';
            return http.lines(q, (l) => { if (body.length < 65536) body += l; }, 'api.open-meteo.com').then(() => {
                const w = JSON.parse(body);
                kept = { key: key(p), at: Date.now(), place: place || '', w: { current: w.current, hourly: w.hourly } };
                try { fs.writeFileSync(file, JSON.stringify(kept)); } catch (e) { /* kept in memory */ }
                log.info('meteo: ' + JSON.stringify(cardOf(kept.w, kept.place, Date.now())));
            }).catch((e) => log.warn('meteo: ' + (e.message || e))).then(() => { busy = false; });
        },
        card() { return kept && Date.now() - kept.at < OLD_MS ? cardOf(kept.w, kept.place, Date.now()) : null; },
    };
}

module.exports = { start, cardOf, kindOf };
