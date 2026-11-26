'use strict';
/**
 * phone.js - the iPhone's position for "distributori vicino a me", through a private ntfy.sh topic.
 *
 * Why a relay: the head unit's firewall drops every connection coming in (M850i-amn's IPTV service, root, has to
 * open a hole with nft for its sign-in page; an app cannot), so the phone cannot reach the car directly even on
 * its own hotspot. The phone (an iOS Shortcuts automation "when CarPlay connects": Get current location, then
 * POST "lat;lon" to https://ntfy.sh/<topic>) publishes; the car reads the topic over HTTPS.
 *
 * The topic is random, made once on this car (<data>/ponte.json, never in the repository) and shown on the app's
 * "Collega iPhone" page: whoever knows it can read what is posted there, and ntfy.sh keeps a message about 12 hours.
 * The Shortcut sends the position rounded to 3 decimals (about 100 m): enough for fuel stations.
 *
 * Without a fresh position (none, or older than FRESH_MS) main.js uses the zone chosen in the settings, as before.
 * Node 8: no ?., ?? or object spread. Never throws.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLL_MS = 30000, FRESH_MS = 60 * 60 * 1000, HOST = 'ntfy.sh', SINCE = '12h';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** "45.071;7.515", "45,071;7,515", "45.071, 7.515", "45.071 7.515", {"lat":..,"lon":..} -> { lat, lon } or null */
function parsePos(text) {
    // brackets or quotes around the numbers ("[45.071];[7.515]") are dropped
    const t = String(text || '').replace(/[\[\]()"']/g, '').trim();
    let a = null, b = null;
    if (/^\{/.test(t)) {
        try { const j = JSON.parse(t); a = j.lat !== undefined ? j.lat : j.latitude; b = j.lon !== undefined ? j.lon : j.lng !== undefined ? j.lng : j.longitude; } catch (e) { return null; }
    } else {
        let parts = t.split(/\s*[;|]\s*|\s+/).filter(Boolean);
        if (parts.length === 1 && (t.match(/,/g) || []).length === 1) parts = t.split(',');      // "45.071,7.515"
        if (parts.length !== 2) return null;
        a = parts[0]; b = parts[1];
    }
    const lat = parseFloat(String(a).replace(',', '.')), lon = parseFloat(String(b).replace(',', '.'));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (!(lat > 35 && lat < 48 && lon > 6 && lon < 19.5)) return null;     // MIMIT's stations are in Italy
    return { lat: lat, lon: lon };
}

/**
 * One message: "lat;lon", "lat;lon;via;comune" (departure: the Shortcut "CarPlay si connette"), "fine;lat;lon;via;comune"
 * (arrival: "CarPlay si disconnette") -> { pos: { lat, lon } | null, end: bool, via, comune } or null.
 */
function parseMsg(text) {
    const t = String(text || '').replace(/[\[\]()"']/g, '').trim();
    if (t.indexOf(';') < 0) { const p = parsePos(t); return p ? { pos: p, end: false, via: '', comune: '' } : null; }
    const parts = t.split(';').map((x) => x.trim());
    let end = false;
    if (/^fine$/i.test(parts[0])) { end = true; parts.shift(); }
    if (parts.length < 2) return null;
    const p = parsePos(parts[0] + ';' + parts[1]);
    if (!p) return null;
    const clip = (x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    // the street without its house number ("Viale San Giovanni Bosco 12" -> "Viale San Giovanni Bosco"): trips from
    // the same street group together, and the exact address is not kept
    const street = clip(parts[2]).replace(/(?:[\s,]+(?:n\.?\s*)?\d+\s*[A-Za-z]?(?:\s*\/\s*[A-Za-z0-9]+)?)+$/i, '').trim();
    return { pos: p, end: end, via: street, comune: clip(parts[3]) };
}

/** "nome Massimo" (the welcome's name, sent from the ntfy web page or app) -> 'Massimo'; "nome -" or "nome" -> ''; else null. */
function parseName(text) {
    const m = /^\s*nome\b[\s:=]*(.*)$/i.exec(String(text || ''));
    if (!m) return null;
    const n = m[1].replace(/[^A-Za-zÀ-ÖØ-öø-ÿ' .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    return n === '-' ? '' : n;
}

/** The car's topic, made once: { topic } */
function topicFile(dataDir) {
    const file = path.join(dataDir || '.', 'ponte.json');
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && /^[a-z0-9-]{20,64}$/.test(j.topic)) return j; } catch (e) { /* make one */ }
    const bytes = crypto.randomBytes(20);
    let id = '';
    for (let i = 0; i < 20; i++) id += B32[bytes[i] & 31];
    const j = { topic: 'auto-' + id };
    try { fs.writeFileSync(file, JSON.stringify(j)); } catch (e) { /* read-only: a new one next start */ }
    return j;
}

/**
 * start(http, dataDir, log, enabled(), onName) -> { position() ({ lat, lon, at } fresh, or null), topic, status() }.
 * onName(name, timeMs): the newest "nome ..." message on the topic (main.js keeps it if newer than the one it has).
 * http: fuel_http's client (lines(path, fn, host)).
 */
function start(http, dataDir, log, enabled, onName) {
    const t = topicFile(dataDir);
    let pos = null, busy = false, error = null, lastLogged = 0, places = [];
    function poll() {
        if (busy || !enabled() || !http.online()) return;
        busy = true;
        let best = null, name = null;
        const got = [];
        http.lines('/' + t.topic + '/json?poll=1&since=' + SINCE, (line) => {
            let m;
            try { m = JSON.parse(line); } catch (e) { return; }
            if (!m || m.event !== 'message') return;
            const nm = parseName(m.message);
            if (nm !== null && (!name || m.time >= name.time)) name = { name: nm, time: m.time };
            const g = parseMsg(m.message);
            if (!g) return;
            const p = g.pos;
            if (g.via || g.comune || g.end) got.push({ time: m.time * 1000, end: g.end, via: g.via, comune: g.comune });
            if (p && (!best || m.time >= best.time)) best = { lat: p.lat, lon: p.lon, time: m.time };
        }, HOST).then(() => {
            error = null;
            places = got;
            if (name && onName) { try { onName(name.name, name.time * 1000); } catch (e) { log.warn('phone: name: ' + e.message); } }
            if (best) {
                const at = best.time * 1000;
                if (!pos || at !== pos.at) { pos = { lat: best.lat, lon: best.lon, at: at }; if (at !== lastLogged) { lastLogged = at; log.info('phone: position from ' + new Date(at).toISOString()); } }
            }
        }, (e) => { error = e.message || String(e); }).then(() => { busy = false; }, () => { busy = false; });
    }
    setTimeout(poll, 2000);
    setInterval(poll, POLL_MS);
    return {
        topic: t.topic,
        position: () => (pos && Date.now() - pos.at < FRESH_MS ? pos : null),
        /** The departures and arrivals with their street, from the last 12 hours: [{ time ms, end, via, comune }] */
        places: () => places,
        poll: poll,
        status: () => {
            if (!enabled()) return 'posizione dall\'iPhone spenta';
            if (error) return 'iPhone: canale non letto (' + error + ')';
            if (!pos) return 'iPhone: nessuna posizione ricevuta';
            const min = Math.round((Date.now() - pos.at) / 60000);
            return Date.now() - pos.at < FRESH_MS ? 'posizione dall\'iPhone di ' + min + ' min fa' : 'posizione dall\'iPhone vecchia (' + min + ' min)';
        },
    };
}

module.exports = { start, parsePos, parseMsg, parseName, topicFile, FRESH_MS };
