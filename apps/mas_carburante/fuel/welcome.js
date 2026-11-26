'use strict';
/**
 * welcome.js - the welcome on the centre screen when you get in: a bar (greeting, day and time) and four large
 * cards (weather, range with the real km/l, the fuel prices around, the last trip), for 8 s over the whole
 * screen, then back to what was there. A tap or the controller closes it at once. With something to tell (prices
 * rising, range low) the ambient light flashes orange twice (Ambient config's flash file, its setting "Redline
 * shift flash" lets other apps' flashes through).
 *
 * The screen is a layer of its own over the full 1920 x 720 output (fullview.js, from IPTV), drawn at 960 x 360
 * logical px (scale 2).
 *
 *   const w = createWelcome({ ctx, log, RenderClient, Recorder });
 *   w.show(cards, { alert })    cards: [{ icon: 'sun'|'cloud'|'rain'|'snow'|'pump'|'up'|'down'|'flat'|'route', lab, val, sub, accent }]
 *   w.busy()                    true while it waits for the renderer or shows
 *
 * Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const { createFullView } = require('./fullview');

const W = 960;
const SHOW_MS = 8000, FADE_MS = 600, WAIT_MS = 20000, FRAME_MS = 50;
const BG = '#0b0d12', CARD = '#171b24', TEXT = '#e8eaf0', MUTED = '#8a92a6', PURPLE = '#7F77DD', ORANGE = '#F0997B', GREEN = '#5DCAA5';
const FLASH_FILE = process.env.MGU_AMBIENT_FLASH || '/dev/shm/mgu-ambient-flash.json';
const FLASH_RGB = [255, 110, 40];

const DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const ease = (x) => { x = Math.max(0, Math.min(1, x)); return 1 - Math.pow(1 - x, 3); };

function greeting(d) {
    const h = d.getHours();
    return h >= 5 && h < 12 ? 'Buongiorno' : h >= 12 && h < 18 ? 'Buon pomeriggio' : 'Buonasera';
}
function dateLine(d) {
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' · ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

/* ---------- the icons: simple shapes, 40 x 40 at (x, y) ---------- */
function icon(rec, kind, x, y, c) {
    if (kind === 'sun') {
        rec.circle(x + 20, y + 20, 9, c);
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            rec.line(x + 20 + Math.cos(a) * 13, y + 20 + Math.sin(a) * 13, x + 20 + Math.cos(a) * 18, y + 20 + Math.sin(a) * 18, 3, c);
        }
    } else if (kind === 'cloud' || kind === 'rain' || kind === 'snow') {
        rec.circle(x + 13, y + 18, 8, c); rec.circle(x + 23, y + 13, 11, c); rec.circle(x + 31, y + 19, 7, c);
        rec.roundRect(x + 5, y + 18, 33, 9, 4, c);
        if (kind === 'rain') [10, 20, 30].forEach((dx) => rec.line(x + dx, y + 31, x + dx - 3, y + 39, 3, c));
        if (kind === 'snow') [10, 20, 30].forEach((dx) => rec.circle(x + dx, y + 35, 2.5, c));
    } else if (kind === 'pump') {
        rec.roundRect(x + 6, y + 4, 20, 34, 3, c);
        rec.roundRect(x + 10, y + 9, 12, 9, 2, CARD);
        rec.polyline([[x + 26, y + 14], [x + 33, y + 18], [x + 33, y + 32], [x + 36, y + 32]], 3, c);
    } else if (kind === 'up' || kind === 'down' || kind === 'flat') {
        const pts = kind === 'up' ? [[x + 2, y + 32], [x + 14, y + 20], [x + 22, y + 26], [x + 37, y + 10]]
            : kind === 'down' ? [[x + 2, y + 10], [x + 14, y + 22], [x + 22, y + 16], [x + 37, y + 32]] : [[x + 2, y + 21], [x + 37, y + 21]];
        rec.polyline(pts, 4, c);
        const e = pts[pts.length - 1];
        if (kind === 'up') { rec.line(e[0], e[1], e[0] - 10, e[1], 4, c); rec.line(e[0], e[1], e[0], e[1] + 10, 4, c); }
        else if (kind === 'down') { rec.line(e[0], e[1], e[0] - 10, e[1], 4, c); rec.line(e[0], e[1], e[0], e[1] - 10, 4, c); }
        else { rec.line(e[0], e[1], e[0] - 8, e[1] - 7, 4, c); rec.line(e[0], e[1], e[0] - 8, e[1] + 7, 4, c); }
    } else {   // route
        rec.polyline([[x + 6, y + 34], [x + 6, y + 22], [x + 30, y + 18], [x + 30, y + 6]], 3, c);
        rec.circle(x + 6, y + 34, 4.5, c); rec.circle(x + 30, y + 6, 4.5, c);
    }
}

/** The text at size, smaller until it fits w. */
function fitText(rec, s, x, y, size, c, w, font) {
    let sz = size;
    while (sz > 14 && rec.textWidth(s, sz, { literal: true, font: font }) > w) sz -= 2;
    rec.text(s, x, y, sz, c, { literal: true, font: font });
}

function paint(rec, H, t, cards, now) {
    const tOut = SHOW_MS, k = t < FADE_MS ? ease(t / FADE_MS) : t > tOut ? 1 - ease((t - tOut) / FADE_MS) : 1;
    rec.clear([0, 0, 0, 0]);
    rec.alpha(k);
    rec.fillRect(0, 0, W, H, BG);
    // the bar
    rec.text(greeting(now), 36, 62, 30, TEXT, { literal: true, font: 'bold' });
    rec.text(dateLine(now), W - 36, 62, 22, MUTED, { literal: true, align: 'right' });
    // the cards: in one after the other, sliding up
    const gap = 14, cw = (W - 72 - gap * 3) / 4, ch = Math.min(206, H - 130), top = 110;
    cards.slice(0, 4).forEach((cd, i) => {
        const ci = ease((t - 300 - i * 350) / 500);
        if (ci <= 0) return;
        rec.alpha(k * ci);
        const x = 36 + i * (cw + gap), y = top + (1 - ci) * 16;
        rec.roundRect(x, y, cw, ch, 20, CARD);
        const ac = cd.accent || PURPLE;
        icon(rec, cd.icon, x + 22, y + 20, ac);
        fitText(rec, cd.lab || '', x + 22, y + 90, 20, MUTED, cw - 44);
        fitText(rec, cd.val || '—', x + 22, y + ch - 44, 36, cd.accent && cd.accent !== PURPLE ? cd.accent : TEXT, cw - 44, 'bold');
        fitText(rec, cd.sub || '', x + 22, y + ch - 16, 19, MUTED, cw - 44);
    });
    rec.alpha(1);
}

function flash(log) {
    try { fs.writeFileSync(FLASH_FILE, JSON.stringify({ rgb: FLASH_RGB, ms: 1200 })); }
    catch (e) { log.info('welcome: no ambient flash (' + e.message + ')'); }
}

function createWelcome(o) {
    const log = o.log;
    let state = 'idle', t0 = 0, waitFrom = 0, timer = null, cards = [], alert = false, flashes = [];
    const stop = (why) => {
        if (timer) clearInterval(timer);
        timer = null; state = 'idle';
        flashes.forEach(clearTimeout); flashes = [];
        fv.update(false);
        if (why) log.info('welcome: ' + why);
    };
    const fv = createFullView({ RenderClient: o.RenderClient, Recorder: o.Recorder, appId: 'mas_carburante', log, W: W,
        off: 'MGU_EMU_CLOSED' in process.env,
        // a tap anywhere or the controller: closed at once
        onTouch: (phase) => { if (phase === 3 && state === 'show') stop('closed by a tap'); return true; },
        onCcu: () => { if (state === 'show') stop('closed by the controller'); } });

    function frame() {
        if (state === 'wait') {
            fv.update(true);
            if (fv.shown()) {
                state = 'show'; t0 = Date.now();
                log.info('welcome: shown');
                if (alert) flashes = [setTimeout(() => flash(log), 2600), setTimeout(() => flash(log), 4400)];
            } else if (Date.now() - waitFrom > WAIT_MS) { stop('the renderer did not show it'); return; }
            else return;
        }
        const t = Date.now() - t0;
        if (t > SHOW_MS + FADE_MS) { stop('done'); return; }
        fv.update(true);
        fv.draw((rec, H) => paint(rec, H, t, cards, new Date()));
    }
    return {
        busy: () => state !== 'idle',
        show(c, opts) {
            if (state !== 'idle') return;
            cards = c || []; alert = !!(opts && opts.alert);
            state = 'wait'; waitFrom = Date.now();
            timer = setInterval(frame, FRAME_MS);
            frame();
        },
        stop: () => { if (state !== 'idle') stop('stopped'); },
    };
}

module.exports = { createWelcome, paint, greeting, dateLine, W };
