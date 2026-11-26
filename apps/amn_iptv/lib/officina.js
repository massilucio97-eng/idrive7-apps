'use strict';
/**
 * officina.js - the "modalità officina" lock shared by our apps (Carburante owns it, IPTV obeys it).
 * The same file is in apps/mas_carburante/fuel/ and apps/amn_iptv/lib/: keep the two copies equal.
 *
 * While the mode is on, our apps show a PIN page instead of their content (Carburante hides the diary and the phone's
 * page, IPTV stops playing and shows only the keypad). The car's own menus are not touched: for them, BMW's Guest
 * profile. It is a privacy lock between our apps, not an anti-theft: whoever disables the apps in mgu-store gets past it.
 *
 * The state is one small JSON:
 *   /dev/shm/mgu-officina.json   what the apps read and write now (tmpfs: gone when the head unit restarts)
 *   <data>/officina.json         each app's own copy, so the lock is back after a restart before anyone writes the shm
 * The newest wins (seq). The PIN is never kept: only salt + PBKDF2 of it (4 digits are few: it keeps it out of sight,
 * it does not make it uncrackable).
 *
 * state = { v: 1, seq, on, since, how, pin: { salt, hash } | null, bad, lockUntil, events: [{ at, kind, by }],
 *           armedAt, trip: {...} (Carburante's), off: { at, how } }
 * Node 8: no ?., ?? or object spread. Never throws.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHM = process.env.MGU_OFFICINA_FILE || '/dev/shm/mgu-officina.json';
const MAX_BAD = 3, LOCK_MS = 5 * 60 * 1000, MAX_EVENTS = 40;

function empty() { return { v: 1, seq: 0, on: false, since: 0, how: '', pin: null, bad: 0, lockUntil: 0, events: [], armedAt: 0, trip: null, off: null }; }
function readJson(f) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && j.v === 1 ? j : null; } catch (e) { return null; } }
// the apps may run as different users: the shared file is made writable by all (0666), and when the rename over a file
// of another app is refused (/dev/shm is sticky) it is written in place
function writeJson(f, j) {
    const s = JSON.stringify(j);
    try { fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); try { fs.chmodSync(f, 438); } catch (e) { /* not ours */ } return true; }
    catch (e) {
        try { fs.unlinkSync(f + '.tmp'); } catch (e2) { /* none */ }
        try { fs.writeFileSync(f, s); return true; } catch (e3) { return false; }
    }
}
const own = (dataDir) => path.join(dataDir || '.', 'officina.json');

/** The current state: the newest of the shared file and this app's copy (the copy is updated when the shared is newer). */
function read(dataDir) {
    const a = readJson(SHM), b = readJson(own(dataDir));
    if (a && (!b || a.seq >= b.seq)) { if (!b || a.seq > b.seq) writeJson(own(dataDir), a); return a; }
    if (b) { writeJson(SHM, b); return b; }
    return empty();
}

/** Write a changed state (seq + 1) to both. */
function write(dataDir, st) {
    st.seq = (Number(st.seq) || 0) + 1;
    writeJson(SHM, st);
    writeJson(own(dataDir), st);
    return st;
}

function event(st, kind, by) {
    st.events = (st.events || []).concat([{ at: Date.now(), kind: kind, by: by || '' }]).slice(-MAX_EVENTS);
}

function hashOf(pin, salt) { return crypto.pbkdf2Sync(String(pin), salt, 20000, 32, 'sha256').toString('hex'); }

function setPin(dataDir, pin) {
    if (!/^\d{4}$/.test(String(pin))) return false;
    const st = read(dataDir), salt = crypto.randomBytes(16).toString('hex');
    st.pin = { salt: salt, hash: hashOf(pin, salt) };
    event(st, 'pin-set', '');
    write(dataDir, st);
    return true;
}

/**
 * A PIN typed in an app (by: 'Carburante', 'IPTV'): { ok, left (tries before the pause), wait (ms of the pause) }.
 * Right: the mode goes off. Wrong 3 times: no more tries for 5 minutes. Each try is an event (Carburante tells the phone).
 */
function tryPin(dataDir, pin, by) {
    const st = read(dataDir);
    if (!st.on) return { ok: true, left: MAX_BAD, wait: 0 };
    if (Date.now() < (st.lockUntil || 0)) return { ok: false, left: 0, wait: st.lockUntil - Date.now() };
    if (st.pin && hashOf(pin, st.pin.salt) === st.pin.hash) {
        off(st, 'PIN ' + (by || ''));
        write(dataDir, st);
        return { ok: true, left: MAX_BAD, wait: 0 };
    }
    st.bad = (st.bad || 0) + 1;
    event(st, 'pin-bad', by);
    if (st.bad >= MAX_BAD) { st.bad = 0; st.lockUntil = Date.now() + LOCK_MS; event(st, 'pin-locked', by); }
    write(dataDir, st);
    return { ok: false, left: st.lockUntil > Date.now() ? 0 : MAX_BAD - st.bad, wait: Math.max(0, (st.lockUntil || 0) - Date.now()) };
}

function off(st, how) {
    st.on = false; st.bad = 0; st.lockUntil = 0; st.armedAt = 0;
    st.off = { at: Date.now(), how: how };
    event(st, 'off', how);
}

/** A light reader for the apps that only obey: on() re-reads the files at most every 2 s. */
function watcher(dataDir) {
    let st = read(dataDir), at = Date.now();
    const get = () => { if (Date.now() - at > 2000) { st = read(dataDir); at = Date.now(); } return st; };
    return { state: get, on: () => !!get().on, refresh: () => { at = 0; return get(); } };
}

module.exports = { read, write, event, setPin, tryPin, off, watcher, empty, MAX_BAD, LOCK_MS, SHM };
