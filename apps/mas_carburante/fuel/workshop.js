'use strict';
/**
 * workshop.js - Carburante's side of the "modalità officina" (officina.js holds the shared lock).
 *
 * On: from the screen OFFICINA ("Attiva la modalità officina") or from the phone ("officina on" posted to the car's
 * channel by a Siri Shortcut, read by phone.js). While on, the app records the trip from the car's signals (odometer,
 * tank level, speed: km, litres, top speed and when, minutes moving, minutes over the chosen speed) and hides the
 * diary and the phone's page; IPTV shows only its keypad.
 *
 * Off:
 *   - the PIN, in Carburante (the keypad on the screen OFFICINA) or in IPTV;
 *   - "officina off" from the phone;
 *   - by itself when the iPhone comes back: the mode is armed once the iPhone has gone (a "CarPlay si disconnette"
 *     message after the mode was turned on, or the car offline 5 minutes: the hotspot left with the phone), then the next
 *     "CarPlay si connette" turns it off. Turned on with the phone connected, it stays on while the phone stays.
 * Then the report goes to the phone (<topic>-avvisi), kept until it is sent (the car is offline while the phone is away).
 *
 * The car's GPS is not read (as in the rest of the app): there is no route, only what the car's signals give.
 * Node 8: no ?., ?? or object spread. Never throws out of a timer.
 */
const OF = require('./officina');

const ARM_OFFLINE_MS = 5 * 60 * 1000, CMD_MAX_AGE_MS = 10 * 60 * 1000;
const hm = (ms) => { const d = new Date(ms); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
const num1 = (x) => x.toFixed(1).replace('.', ',');
const kmInt = (k) => String(Math.round(k)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * create({ dataDir, log, http, topic, notifier, phone, settings, car: { km(), level(), speed() }, changed() })
 *   on(), state(), activate(how), deactivate(how), setPin(pin), tryPin(pin), tick()
 */
function create(o) {
    const { dataDir, log, http, notifier, settings } = o;
    let st = OF.read(dataDir), seenEvents = Date.now(), offlineSince = null, lastSave = 0;
    // the trip is counted here every second and written with the rest every 30 s: the copy in memory is the newest
    let trip = st.on ? st.trip : null;
    const cur = () => { st = OF.read(dataDir); if (trip && st.on) st.trip = trip; return st; };
    const thr = () => Number(settings.get('officinaSpeed')) || 90;
    const save = () => { if (trip && st.on) st.trip = trip; st = OF.write(dataDir, st); lastSave = Date.now(); };

    function activate(how) {
        cur();
        if (st.on) return false;
        const km = o.car.km(), level = o.car.level();
        st.on = true; st.since = Date.now(); st.how = how; st.armedAt = 0; st.bad = 0; st.lockUntil = 0; st.off = null;
        st.trip = trip = { km0: km, level0: level, km: km, level: level, vmax: 0, vmaxAt: 0, moving: 0, over: 0, overFirst: 0, thr: thr() };
        OF.event(st, 'on', how);
        save();
        log.info('officina on (' + how + ')' + (st.pin ? '' : ', no PIN set'));
        notifier.alert('Modalità officina attiva', hm(st.since) + (km !== null ? ' · ' + kmInt(km) + ' km' : '') +
            '. Si disattiva da sola quando il tuo iPhone si ricollega' + (st.pin ? ', oppure con il PIN.' : ' (nessun PIN impostato: altrimenti dal telefono, "officina off").') +
            ' Ricorda il profilo Ospite dell\'iDrive.', ['wrench'], 3);
        o.changed();
        return true;
    }

    /** The report of the trip: { title, message, priority } */
    function report(s) {
        const t = s.trip || {}, off = s.off || { at: Date.now(), how: '' };
        const km = typeof t.km0 === 'number' && typeof t.km === 'number' ? Math.max(0, t.km - t.km0) : null;
        const lit = typeof t.level0 === 'number' && typeof t.level === 'number' && t.level0 - t.level > 0.1 ? t.level0 - t.level : null;
        const bad = (s.events || []).filter((e) => e.at >= s.since && e.kind === 'pin-bad');
        const parts = [hm(s.since) + '–' + hm(off.at)];
        parts.push(km !== null ? num1(km) + ' km' : 'km non letti');
        if (t.vmax) parts.push('velocità max ' + Math.round(t.vmax) + ' km/h alle ' + hm(t.vmaxAt));
        parts.push('in movimento ' + Math.round((t.moving || 0) / 60) + ' min');
        if (t.over) parts.push('sopra i ' + t.thr + ' km/h per ' + Math.max(1, Math.round(t.over / 60)) + ' min (dalle ' + hm(t.overFirst) + ')');
        if (lit !== null) parts.push('carburante −' + num1(lit) + ' l');
        let msg = parts.join(' · ') + '.';
        if (bad.length) msg += ' PIN errati: ' + bad.length + ' (' + bad.map((e) => hm(e.at) + (e.by ? ' ' + e.by : '')).join(', ') + ').';
        msg += ' Sbloccata: ' + (off.how || '?') + '.';
        return { title: 'Resoconto officina', message: msg, priority: t.over || bad.length ? 4 : 3, tags: t.over || bad.length ? ['wrench', 'warning'] : ['wrench'] };
    }

    /** After the mode went off (here or in IPTV): the report, kept in the state until it is sent. */
    function finish() {
        if (trip) st.trip = trip;
        if (!st.trip) return;
        st.report = report(st);
        st.report.at = Date.now();
        st.trip = trip = null;
        save();
        log.info('officina off (' + (st.off && st.off.how) + '): ' + st.report.message);
        sendReport();
        o.changed();
    }
    let sending = false;
    function sendReport() {
        if (sending || !st.report || !http.online() || settings.get('notify') === false) return;
        sending = true;
        const r = st.report;
        http.post('/', JSON.stringify({ topic: o.topic + '-avvisi', title: r.title, message: r.message, tags: r.tags, priority: r.priority }))
            .then((code) => {
                if (code >= 200 && code < 300 || (code >= 400 && code < 500 && code !== 429)) {
                    st = OF.read(dataDir);
                    if (st.report && st.report.at === r.at) { st.report = null; save(); }
                }
            }, (e) => log.warn('officina report: ' + (e.message || e))).then(() => { sending = false; }, () => { sending = false; });
    }

    function deactivate(how) {
        cur();
        if (!st.on) return false;
        OF.off(st, how);
        save();
        finish();
        return true;
    }

    /** The commands from the phone (phone.js): only new ones (under 10 minutes old, newer than the last one done). */
    function command(cmd, time) {
        cur();
        if (time <= (st.cmdAt || 0) || Date.now() - time > CMD_MAX_AGE_MS) return;
        st.cmdAt = time; save();
        log.info('officina: "' + cmd + '" from the phone');
        if (cmd === 'on') activate('dal telefono');
        else deactivate('dal telefono');
    }

    /** Every second: the trip, the shared file (IPTV's PIN), the iPhone coming back. */
    let lastSpeedAt = Date.now(), phoneCheck = 0;
    function tick() {
        const was = st.on;
        cur();
        // IPTV's events: the PIN wrong (to the phone at once, when online), the mode off by its PIN
        (st.events || []).filter((e) => e.at > seenEvents).forEach((e) => {
            if (e.kind === 'pin-bad') notifier.alert('PIN errato in auto', 'Modalità officina, ' + (e.by || 'app') + ' alle ' + hm(e.at) + '.', ['warning'], 4);
            if (e.kind === 'pin-locked') notifier.alert('3 PIN errati', 'Tastierino bloccato 5 minuti. Per sbloccarla dal telefono: "officina off".', ['rotating_light'], 5);
        });
        if (st.events && st.events.length) seenEvents = Math.max(seenEvents, st.events[st.events.length - 1].at);
        if (was && !st.on && (trip || st.trip)) { finish(); return; }
        if (st.report) sendReport();
        if (!st.on) { offlineSince = null; return; }
        // the trip
        const t = trip || (trip = st.trip || { km0: null, level0: null, km: null, level: null, vmax: 0, vmaxAt: 0, moving: 0, over: 0, overFirst: 0, thr: thr() });
        const km = o.car.km(), level = o.car.level(), v = o.car.speed(), now = Date.now(), dt = Math.min(5, (now - lastSpeedAt) / 1000);
        lastSpeedAt = now;
        if (km !== null) { if (t.km0 === null) t.km0 = km; t.km = km; }
        if (level !== null) { if (t.level0 === null) t.level0 = level; t.level = level; }
        if (v !== null && v > 3) {
            t.moving += dt;
            if (v > t.vmax) { t.vmax = v; t.vmaxAt = now; }
            if (v > t.thr) { if (!t.over) t.overFirst = now; t.over += dt; }
        }
        // the iPhone: gone (disconnected after the mode went on, or the car offline 5 min), then back (connected)
        if (settings.get('officinaAuto') !== false && now - phoneCheck > 5000) {
            phoneCheck = now;
            if (!http.online()) { if (!offlineSince) offlineSince = now; }
            else offlineSince = null;
            const cp = o.phone.carplay();
            if (!st.armedAt) {
                const gone = cp.filter((e) => e.end && e.time > st.since).map((e) => e.time);
                if (gone.length) { st.armedAt = Math.max.apply(null, gone); log.info('officina: armed (the iPhone disconnected at ' + hm(st.armedAt) + ')'); save(); }
                else if (offlineSince && now - Math.max(offlineSince, st.since) > ARM_OFFLINE_MS) {
                    st.armedAt = Math.max(offlineSince, st.since); log.info('officina: armed (the car offline since ' + hm(st.armedAt) + ')'); save();
                }
            }
            if (st.armedAt && cp.some((e) => !e.end && e.time > st.armedAt)) { deactivate('il tuo iPhone si è ricollegato'); return; }
        }
        if (now - lastSave > 30000) save();
    }
    setInterval(() => { try { tick(); } catch (e) { log.warn('officina: ' + (e && e.message || e)); } }, 1000);

    return {
        on: () => !!st.on,
        state: () => st,
        activate, deactivate, command,
        setPin: (pin) => { if (trip) save(); const ok = OF.setPin(dataDir, pin); cur(); return ok; },
        tryPin: (pin) => {
            if (trip) save();       // the trip so far into the file, before officina.js changes it
            const r = OF.tryPin(dataDir, pin, 'Carburante');
            st = OF.read(dataDir);
            if (r.ok && (trip || st.trip)) finish(); else if (!r.ok) tick();
            return r;
        },
        /** "Attiva dalle 9:12 · 14,6 km · max 112 km/h · si disattiva quando il tuo iPhone si ricollega" */
        line() {
            if (!st.on) return st.report ? 'Resoconto dell\'ultima officina in attesa di internet per il telefono' : st.off ? 'Ultima volta: ' + hm(st.off.at) + ', ' + st.off.how : 'Non attiva';
            const t = trip || st.trip || {}, km = typeof t.km0 === 'number' && typeof t.km === 'number' ? t.km - t.km0 : null;
            return 'Attiva dalle ' + hm(st.since) + (km !== null ? ' · ' + num1(km) + ' km' : '') + (t.vmax ? ' · max ' + Math.round(t.vmax) + ' km/h' : '') +
                (settings.get('officinaAuto') === false ? '' : st.armedAt ? ' · si disattiva quando il tuo iPhone si ricollega' : ' · si disattiverà quando il tuo iPhone si scollega e si ricollega');
        },
    };
}

module.exports = { create };
