'use strict';
/**
 * route_info.js - what is left of the phone's route, for the arrival line on the cluster.
 *
 * Source (proven by cauliflowermossgrape's Redline on a G21 with CarPlay, 2026-11-09; the request's shape is
 * Redline's navlog.js, MIT): while CarPlay guides, BMW lists the phone's route events in
 * de.bmw.infotainment.navigation.guiding.GuidanceEventList, read with queryContent once a second; every event
 * carries distanceToDestination (metres). That gives the km left. A time to the destination or an arrival time
 * is not proven yet: any numeric field in the reply whose name says so (timeToDestination, remainingTime,
 * travelTime, arrival...) is used when present and logged, and probe() lists the car's own catalog entries that
 * could carry one (Diagnostica page), so the next version can read the right field.
 *
 * Node 8: no ?., ?? or object spread. Never throws.
 */
const fs = require('fs');

const EVENT_LIST = { iface: 'de.bmw.infotainment.navigation.guiding.GuidanceEventList', inst: 'Main_Instance', method: 'queryContent' };
const CARPLAY = { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', inst: 'CarPlayManagerInst1' };
const QUERY_MS = 1000, STALE_MS = 4000, RETRY_MS = 30000;
const TIME_KEY = /^(timeToDestination|remainingTime|remainingTravelTime|travelTime|timeToGo|durationToDestination)$/i;
const ARRIVAL_KEY = /^(arrivalTime|estimatedTimeOfArrival|eta|timeOfArrival)$/i;
const CATALOG = '/etc/oap/someip/someip-interfaces.json';

function eventQuery() {
    return { viewConfigs: [{
        viewport: { startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] }, maxElementCount: 6, endPoints: [],
            includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_DESTINATIONS'] },
        options: [], minimumUpdateIntervalMs: 1000, segmentItemRasterLength: 100,
    }] };
}

/** Walk a value: fn(key, value) for every key; depth-limited. */
function walk(v, fn, depth) {
    if (depth > 14 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.slice(0, 40).forEach((x) => walk(x, fn, depth + 1)); return; }
    Object.keys(v).forEach((k) => { fn(k, v[k]); walk(v[k], fn, depth + 1); });
}

/** A reply -> { metres, seconds, arrival, keys } (null where none). metres: the smallest distanceToDestination. */
function parse(reply) {
    let metres = null, seconds = null, arrival = null;
    const keys = {};
    walk(reply, (k, v) => {
        const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
        if (k === 'distanceToDestination' && n !== null && n >= 0 && n < 5e6 && (metres === null || n < metres)) metres = n;
        if (TIME_KEY.test(k) && n !== null && n >= 0 && n < 360000) { seconds = n; keys[k] = n; }
        if (ARRIVAL_KEY.test(k)) { arrival = v; keys[k] = v; }
    }, 0);
    return { metres: metres, seconds: seconds, arrival: arrival, keys: keys };
}

/** The arrival line as Waze writes it: "14:55 arrivo · 7 min · 1,5 km" (what is known of it). now: ms. */
function line(info, now) {
    if (!info || info.metres === null) return null;
    const parts = [];
    if (info.seconds !== null) {
        const t = new Date(now + info.seconds * 1000);
        parts.push(('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ' arrivo');
        parts.push(Math.max(1, Math.round(info.seconds / 60)) + ' min');
    }
    const km = info.metres / 1000;
    parts.push((km < 10 ? km.toFixed(1) : String(Math.round(km))).replace('.', ',') + ' km' + (info.seconds === null ? ' all\'arrivo' : ''));
    return parts.join('  ·  ');
}

/**
 * start(ctx, log) -> { info() (the last parse, null when stale or no route), status() }. Asks only while CarPlay
 * says it guides.
 */
function start(ctx, log) {
    let guiding = false, proxy = null, busy = false, last = null, lastAt = 0, failAt = 0, fails = 0, error = null, loggedKeys = '';
    if (!ctx.signals || !ctx.signals.watch) return { info: () => null, status: () => 'segnali dell\'auto non disponibili' };
    ctx.signals.watch(CARPLAY.iface, CARPLAY.inst, {
        projectedGuidanceActive: (v) => {
            const on = v === true || v === 1 || (v && typeof v === 'object' && Object.keys(v).some((k) => v[k] === true || v[k] === 1));
            if (on !== guiding) log.info('route: CarPlay guidance ' + (on ? 'on' : 'off'));
            guiding = on;
        },
    }, log, { pollMs: 5000 }).then((s) => log.info('route: CarPlayManager ' + (s && s.error ? s.error : 'watching')), (e) => log.warn('route: ' + e.message));

    setInterval(() => {
        if (!guiding || busy || (fails >= 3 && Date.now() - failAt < RETRY_MS)) return;
        busy = true;
        Promise.resolve().then(() => proxy || ctx.signals.proxy(EVENT_LIST.iface, EVENT_LIST.inst).then((p) => { proxy = p; return p; }))
            .then((p) => ctx.signals.call(p, EVENT_LIST.method, eventQuery(), 900))
            .then((reply) => {
                const r = parse(reply);
                fails = 0; error = null;
                if (r.metres !== null) { last = r; lastAt = Date.now(); }
                const k = Object.keys(r.keys).sort().join(',');
                if (k !== loggedKeys) { loggedKeys = k; log.info('route: time fields in the reply: ' + (k || 'none')); }
            }, (e) => {
                fails++; failAt = Date.now(); error = e.message || String(e);
                if (fails === 1 || fails === 3) log.warn('route: queryContent ' + error);
                if (fails >= 5) proxy = null;
            })
            .then(() => { busy = false; }, () => { busy = false; });
    }, QUERY_MS);

    return {
        info: () => (guiding && last && Date.now() - lastAt < STALE_MS ? last : null),
        status: () => (!guiding ? 'nessun percorso CarPlay attivo' : error ? 'dati del percorso non letti: ' + error : last ? 'percorso letto' : 'leggo il percorso...'),
        guiding: () => guiding,
    };
}

/**
 * The car's catalog entries that could carry the time to the destination: [ 'interface: name', ... ] (at most
 * max). Read only, once, when asked (Diagnostica page).
 */
function probe(max) {
    let cat;
    try { cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch (e) { return ['catalogo non leggibile: ' + e.message]; }
    const out = [], seen = {};
    const want = /(time|arrival|eta\b|remaining|duration).*(dest|arriv|goal|target|route)|(dest|route).*(time|duration|arrival)/i;
    function visit(v, iface, depth) {
        if (out.length >= (max || 40) || depth > 12 || !v || typeof v !== 'object') return;
        if (Array.isArray(v)) { v.forEach((x) => visit(x, iface, depth + 1)); return; }
        const name = typeof v.name === 'string' ? v.name : null;
        const here = name && /^de\.bmw\.|^com\.harman\./.test(name) ? name : iface;
        Object.keys(v).forEach((k) => {
            const x = v[k];
            [k, typeof x === 'string' ? x : null].forEach((s) => {
                if (s && here && /navigation|guiding|projected|carplay/i.test(here) && want.test(s)) {
                    const id = here + ': ' + s;
                    if (!seen[id] && out.length < (max || 40)) { seen[id] = 1; out.push(id); }
                }
            });
            visit(x, here, depth + 1);
        });
    }
    visit(cat, null, 0);
    return out.length ? out : ['nessun campo del tempo all\'arrivo trovato nel catalogo'];
}

module.exports = { start, parse, line, probe, eventQuery };
