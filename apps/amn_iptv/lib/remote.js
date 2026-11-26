'use strict';
/**
 * remote.js - the phone as the IPTV's remote: the phone browses the whole playlist itself (live TV, films, series;
 * extras/iptv_telecomando.js in Scriptable, straight from the Xtream server) and sends what to play here.
 *
 * Why a relay: the head unit's firewall drops every connection coming in, so the phone cannot reach the car. Both
 * talk to ntfy.sh over a private random topic made once on this car (<data>/telecomando.json, never in the repository):
 *   <topic>-cmd  phone -> car: one JSON message per command; the car keeps a streaming connection open on it, so a
 *                command arrives in about a second
 *   <topic>-ora  car -> phone: what is playing (name, kind, position, duration, state), on each change and every 15 s
 *                while something plays
 * Commands: { v: 1, op: 'live', id, name } | { v: 1, op: 'film', id, ext, name, duration } | { v: 1, op: 'episode', id,
 * ext, name, duration, series } | { v: 1, op: 'stop' | 'pause' | 'resume' | 'next' | 'prev' | 'next-now' | 'next-cancel' } |
 * { v: 1, op: 'seek', by: seconds }.
 *   <topic>-preferiti  car -> phone: the car's favourite channels { v: 1, at, favs: [[id, name, icon], ...] }, on each change
 *                and every 6 h, so the phone's remote shows the same ones; the phone adds or removes one with { op: 'fav' }
 * A command older than 60 s (a reconnect seeing an old one) is ignored. Whoever knows the topic can change the channel
 * and see the title playing: nothing else (the Xtream login never goes through it).
 *
 *   const r = createRemote({ dataDir, log, uplink, onCommand(cmd), status() -> object|null });
 *   r.topic, r.state() -> 'connected' | 'offline' | 'connecting', r.stop()
 *
 * Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const HOST = 'ntfy.sh', B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const MAX_AGE_S = 60, STATUS_MS = 15000, RETRY_MS = [2000, 5000, 15000, 30000, 60000];

function topicOf(dataDir) {
    const file = path.join(dataDir || '.', 'telecomando.json');
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && /^tv-[a-z2-7]{20}$/.test(j.topic)) return j.topic; } catch (e) { /* make one */ }
    const b = crypto.randomBytes(20);
    let id = '';
    for (let i = 0; i < 20; i++) id += B32[b[i] & 31];
    const topic = 'tv-' + id;
    try { fs.writeFileSync(file, JSON.stringify({ topic })); } catch (e) { /* a new one at the next start */ }
    return topic;
}

/** A command message from the phone -> the command, or null. */
function parseCommand(text) {
    let c;
    try { c = JSON.parse(String(text || '')); } catch (e) { return null; }
    if (!c || c.v !== 1 || typeof c.op !== 'string') return null;
    const id = (x) => (/^\d{1,12}$/.test(String(x)) ? String(x) : null);
    const name = String(c.name || '').slice(0, 120);
    const ext = /^[a-z0-9]{2,5}$/i.test(String(c.ext || '')) ? String(c.ext) : 'mp4';
    if (c.op === 'live') return id(c.id) ? { op: 'live', id: id(c.id), name } : null;
    if (c.op === 'film' || c.op === 'episode') return id(c.id) ? { op: c.op, id: id(c.id), ext, name, duration: Math.max(0, Number(c.duration) || 0), series: id(c.series) } : null;
    if (c.op === 'seek') { const by = Number(c.by); return isFinite(by) && Math.abs(by) <= 3600 ? { op: 'seek', by } : null; }
    if (c.op === 'fav') {
        const icon = /^https?:\/\/\S{1,300}$/.test(String(c.icon || '')) ? String(c.icon) : '';
        return id(c.id) ? { op: 'fav', id: id(c.id), name, icon, on: c.on === true } : null;
    }
    if (['stop', 'pause', 'resume', 'next', 'prev', 'next-now', 'next-cancel'].indexOf(c.op) >= 0) return { op: c.op };
    return null;
}

function createRemote(o) {
    const log = o.log, topic = topicOf(o.dataDir);
    const lookupFor = o.uplink.resolver();
    let req = null, state = 'offline', tries = 0, stopped = false, timer = null, lastStatus = '', lastStatusAt = 0;
    const opts = (method, p, extra) => {
        const r = Object.assign({ method, host: HOST, port: 443, path: p, headers: { 'User-Agent': 'amn_iptv remote (iDrive 7)' } }, extra || {});
        const l = o.uplink.lease(o.dataDir), lookup = lookupFor(l);
        if (lookup) r.lookup = lookup;
        const ca = o.uplink.trustedCa(o.dataDir);
        if (ca) r.ca = ca;
        return r;
    };
    function again() {
        if (stopped || timer) return;
        const ms = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)];
        tries++;
        timer = setTimeout(() => { timer = null; listen(); }, ms);
    }
    // the streaming subscription: one JSON object per line, keepalives in between
    function listen() {
        if (stopped || req) return;
        if (!o.uplink.lease(o.dataDir)) { state = 'offline'; again(); return; }
        state = 'connecting';
        let rest = '';
        req = https.request(opts('GET', '/' + topic + '-cmd/json'), (res) => {
            if (res.statusCode !== 200) { res.resume(); req = null; state = 'offline'; log.warn('remote: HTTP ' + res.statusCode); again(); return; }
            state = 'connected'; tries = 0;
            log.info('remote: listening');
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                const parts = (rest + chunk).split('\n');
                rest = parts.pop();
                if (rest.length > 65536) rest = '';
                parts.forEach((line) => {
                    let m;
                    try { m = JSON.parse(line); } catch (e) { return; }
                    if (!m || m.event !== 'message') return;
                    if (Math.abs(Date.now() / 1000 - (m.time || 0)) > MAX_AGE_S) return;
                    const c = parseCommand(m.message);
                    if (!c) { log.info('remote: a message that is no command'); return; }
                    log.info('remote: ' + c.op + (c.name ? ' ' + c.name : ''));
                    try { o.onCommand(c); } catch (e) { log.warn('remote command: ' + e.message); }
                    setTimeout(publish, 1500);
                });
            });
            res.on('end', () => { req = null; state = 'offline'; again(); });
            res.on('error', () => { req = null; state = 'offline'; again(); });
        });
        // ntfy sends a keepalive every 45 s: nothing for 2 min is a dead connection
        req.setTimeout(120000, () => { if (req) req.abort(); });
        req.on('error', (e) => { req = null; state = 'offline'; log.info('remote: ' + e.message); again(); });
        req.end();
    }
    // what is playing, to the phone
    function publish() {
        if (stopped || !o.uplink.lease(o.dataDir)) return;
        let s = null;
        try { s = o.status(); } catch (e) { s = null; }
        const body = JSON.stringify(Object.assign({ v: 1, at: Date.now() }, s || { state: 'idle' }));
        const key = JSON.stringify(s);
        if (key === lastStatus && Date.now() - lastStatusAt < (s && s.state === 'playing' ? STATUS_MS : 10 * 60000)) return;
        lastStatus = key; lastStatusAt = Date.now();
        const data = Buffer.from(body, 'utf8');
        if (data.length > 3500) return;
        const r = https.request(opts('POST', '/' + topic + '-ora', { headers: { 'User-Agent': 'amn_iptv remote (iDrive 7)', 'Content-Length': data.length } }),
            (res) => { res.resume(); });
        r.setTimeout(20000, () => r.abort());
        r.on('error', () => {});
        r.end(data);
    }
    // the favourite channels, to the phone: when they change, and every 6 h so ntfy keeps them (it keeps 12 h)
    let lastFavs = '', lastFavsAt = 0;
    function publishFavs() {
        if (stopped || !o.favs || !o.uplink.lease(o.dataDir)) return;
        let list = [];
        try { list = (o.favs() || []).slice(0, 60).map((c) => [String(c.id), String(c.name || '').slice(0, 60), String(c.icon || '')]); } catch (e) { return; }
        const key = JSON.stringify(list);
        if (key === lastFavs && Date.now() - lastFavsAt < 6 * 3600000) return;
        let body = JSON.stringify({ v: 1, at: Date.now(), favs: list });
        if (Buffer.byteLength(body) > 3800) body = JSON.stringify({ v: 1, at: Date.now(), favs: list.map((x) => [x[0], x[1], '']) });
        if (Buffer.byteLength(body) > 3800) return;
        const data = Buffer.from(body, 'utf8');
        const r = https.request(opts('POST', '/' + topic + '-preferiti', { headers: { 'User-Agent': 'amn_iptv remote (iDrive 7)', 'Content-Length': data.length } }),
            (res) => { res.resume(); if (res.statusCode === 200) { lastFavs = key; lastFavsAt = Date.now(); } });
        r.setTimeout(20000, () => r.abort());
        r.on('error', () => {});
        r.end(data);
    }
    const pub = setInterval(() => { publish(); publishFavs(); }, 5000);
    setTimeout(listen, 3000);
    return {
        topic,
        state: () => state,
        publish,
        publishFavs,
        stop() { stopped = true; clearInterval(pub); if (timer) clearTimeout(timer); if (req) req.abort(); },
    };
}

module.exports = { createRemote, parseCommand, topicOf };
