'use strict';
/**
 * wide_cluster.js - the phone's map (waze-on-cluster's "map" target, 1088 x 480) shown larger on the whole
 * cluster ("panel", 1920 x 720) through the Store's Cluster renderer (robertnisipeanu/idrive-apps,
 * cluster-render PROTOCOL.md "Hosting from layers"): one rect between the two gauge arcs, over BMW's digital
 * speed and consumption readouts, never over the arcs, the bottom bar or the warning lamps (the rect is the
 * user's, set while parked with the test grid).
 *
 * Layers on "panel", all images (no shaders: a heavy shader once restarted a cluster, Redline README):
 *   frame  the rect: transparent, only its rounded corners dark; the map is drawn just under it (the anchor)
 *   strip  the arrival line at the rect's bottom (route_info.js), shown only while a route gives one
 *   grid   the test grid over the whole cluster with the rect outlined: only while parked and asked for
 * Nothing shows unless the map is being drawn (another app's video on "map" or "panel", from the service's
 * status every 2 s): with no map, or the setting off, every layer is hidden and the host ended, so the
 * cluster is BMW's own. During a warning the cluster takes its slots back by itself (cluster-render README).
 *
 * Node 8: no ?., ?? or object spread.
 */
const { loadClient, mapLayers, drawing } = require('./kit/cluster_render');
const { Canvas } = require('./kit/canvas');

const PANEL_W = 1920, PANEL_H = 720, MAP_W = 1088, MAP_H = 480;
const RECONNECT_MS = 8000, STATUS_MS = 2000, RADIUS = 22;
const STRIP_W = 560, STRIP_H = 64, CARD_W = 440, CARD_H = 176;

/** The part of the 1088 x 480 map that fills rect r without stretching (centred): { src_x, src_y, src_w, src_h }. */
function crop(r) {
    const a = r.w / r.h, m = MAP_W / MAP_H;
    if (a >= m) { const h = Math.max(32, Math.round(MAP_W / a)); return { src_x: 0, src_y: Math.round((MAP_H - h) / 2), src_w: MAP_W, src_h: h }; }
    const w = Math.max(64, Math.round(MAP_H * a));
    return { src_x: Math.round((MAP_W - w) / 2), src_y: 0, src_w: w, src_h: MAP_H };
}

/** The rect from the four edges (panel pixels), kept inside the panel and at least 64 x 32. */
function rectOf(e) {
    const x = Math.max(0, Math.min(PANEL_W - 64, e.left | 0)), y = Math.max(0, Math.min(PANEL_H - 32, e.top | 0));
    const r = Math.min(PANEL_W, e.right | 0), b = Math.min(PANEL_H, e.bottom | 0);
    return { x: x, y: y, w: Math.max(64, r - x), h: Math.max(32, b - y) };
}

class WideMap {
    /** o: log, app (the app's id) */
    constructor(o) {
        this.log = o.log; this.app = o.app;
        this.cr = null; this.ready = false; this.err = null; this.downAt = 0;
        this.want = { on: false, grid: false, rect: null, strip: null };
        this.refs = { frame: 0, strip: 0, grid: 0, card: 0 };
        this.drawn = { frame: null, strip: null, grid: null, card: null };
        this.mapSeen = {}; this.mapLive = false; this.hosted = false; this.hosting = ''; this.hostKey = ''; this.vis = {};
    }

    /** What the app's status line says. */
    view() {
        if (this.err) return this.err.text;
        if (!this.cr || !this.ready) return 'Collegamento al Cluster renderer...';
        if (!this.want.on) return 'Mappa larga spenta';
        if (!this.mapLive) return 'Mappa larga pronta: aspetto la mappa del telefono sul quadro';
        return this.hosting === 'live' ? 'Mappa larga attiva' : 'Mappa larga in attesa' + (this.hostingWhy ? ': ' + this.hostingWhy : '');
    }

    /** w: { on, grid (and parked), rect {x,y,w,h}, strip: text or null } */
    update(w) {
        this.want = w;
        if (!this.cr) this._connect();
        this._apply();
    }

    _connect() {
        const now = Date.now();
        if (this.err && now - this.errAt < 30000) return;
        const c = loadClient({}, { missing: 'Cluster renderer non installato: installa Maps on cluster dallo Store' });
        if (c.error) { if (!this.err) this.log.warn('cluster: ' + c.text); this.err = c; this.errAt = now; return; }
        this.err = null;
        let cr;
        try { cr = this.cr = new c.ClusterRender(this.app, c.sock); } catch (e) { this.err = { text: e.message }; this.errAt = now; this.cr = null; return; }
        cr.on('ready', () => {
            if (this.cr !== cr) return;
            this.ready = true; this.refs = { frame: 0, strip: 0, grid: 0, card: 0 }; this.drawn = { frame: null, strip: null, grid: null, card: null }; this.hosted = false; this.vis = {};
            this.log.info('cluster: connected, host from layers ' + (cr.hostLayers ? 'yes' : 'NO (update the Cluster renderer)'));
            this._apply();
        });
        cr.on('disconnected', () => { if (this.cr !== cr) return; this.ready = false; this.hosted = false; this.downAt = Date.now(); });
        cr.on('refused', (op, ref, reason) => { if (this.cr === cr) this.log.warn('cluster: refused ' + (op || '?') + ': ' + (reason || '?')); });
        cr.on('hosting', (target, ev) => {
            if (this.cr !== cr || target !== 'map') return;
            const st = (ev && ev.state) || '', why = (ev && ev.reason) || '';
            if (st !== this.hosting || why !== this.hostingWhy) this.log.info('cluster: hosting ' + st + (why ? ' (' + why + ')' : ''));
            this.hosting = st; this.hostingWhy = why;
        });
        cr.on('status', (text) => {
            if (this.cr !== cr) return;
            const now2 = Date.now();
            const vids = mapLayers(text, this.app, 'map').concat(mapLayers(text, this.app, 'panel')).filter((l) => l.kind === 'video');
            const live = vids.some((l) => drawing(l, this.mapSeen, now2));
            if (live !== this.mapLive) { this.mapLive = live; this.log.info('cluster: phone map ' + (live ? 'drawing' : 'not drawing')); this._apply(); }
        });
        this.downAt = now;
        this.timer = setInterval(() => {
            if (this.cr !== cr) return;
            if (this.ready) { try { cr.status(); } catch (e) { /* next */ } }
            else if (Date.now() - this.downAt >= RECONNECT_MS) { this.log.info('cluster: reconnecting'); this.close(); this._connect(); }
        }, STATUS_MS);
        try { cr.connect(); } catch (e) { this.log.warn('cluster: connect ' + e.message); }
    }

    _image(name, g, klass, z, draw, key) {
        const cr = this.cr;
        if (this.refs[name] && this.drawn[name + 'Geom'] !== g.x + ',' + g.y + ',' + g.w + ',' + g.h) {
            try { cr.drop(this.refs[name]); } catch (e) { /* gone */ }
            this.refs[name] = 0; this.drawn[name] = null;
        }
        if (!this.refs[name]) {
            const ref = cr.image({ target: 'panel', klass: klass, z: z, exclusive: false, contend: true, visible: false,
                x: g.x, y: g.y, w: g.w, h: g.h, iw: g.w, ih: g.h, sampling: 'nearest', fps: 2 });
            if (!ref) { this.log.warn('cluster: ' + name + ' refused by the client'); return false; }
            this.refs[name] = ref; this.drawn[name + 'Geom'] = g.x + ',' + g.y + ',' + g.w + ',' + g.h; this.drawn[name] = null;
        }
        if (this.drawn[name] !== key) {
            const img = draw(g.w, g.h);
            try { cr.pixels(this.refs[name], null, Buffer.from(img.d.buffer, img.d.byteOffset, img.d.length)); } catch (e) { this.log.warn('cluster: pixels ' + e.message); return false; }
            this.drawn[name] = key;
        }
        return true;
    }
    _show(name, v) {
        if (!this.refs[name]) return;
        const key = this.refs[name] + ':' + !!v;
        if (this.vis[name] === key) return;             // sent once per change, not every tick
        this.vis[name] = key;
        try { this.cr.set(this.refs[name], { visible: !!v }); } catch (e) { /* gone */ }
    }

    _apply() {
        if (!this.cr || !this.ready) return;
        const w = this.want, r = w.rect;
        const active = !!(w.on && r && this.mapLive && this.cr.hostLayers);
        // the rect's frame: the anchor the map is drawn under
        const fade = w.fade || 0, shape = w.shape || 0;
        if (r && (active || w.grid)) this._image('frame', r, 'content', 10, (cw, ch) => frameImage(cw, ch, fade, shape), r.w + 'x' + r.h + 'f' + fade + 's' + shape);
        if (active) {
            const key = [r.x, r.y, r.w, r.h].join(',');
            if (!this.hosted || this.hostKey !== key) {
                const c = crop(r);
                this.cr.host('panel', { target: 'map', x: r.x, y: r.y, w: r.w, h: r.h, src_x: c.src_x, src_y: c.src_y, src_w: c.src_w, src_h: c.src_h });
                this.hosted = true; this.hostKey = key;
                this.log.info('cluster: map hosted at ' + key + ' (map part ' + [c.src_x, c.src_y, c.src_w, c.src_h].join(',') + ')');
            }
        } else if (this.hosted) {
            try { this.cr.unhost('map'); } catch (e) { /* gone */ }
            this.hosted = false; this.hosting = '';
            this.log.info('cluster: map back on its own place');
        }
        this._show('frame', active);
        // the arrival line, at the bottom of the rect
        if (active && w.strip && r) {
            const g = { x: r.x + Math.round((r.w - STRIP_W) / 2), y: r.y + r.h - STRIP_H - 10, w: STRIP_W, h: STRIP_H };
            if (this._image('strip', g, 'overlay', 20, (cw, ch) => stripImage(cw, ch, w.strip), w.strip)) this._show('strip', true);
        } else this._show('strip', false);
        // the next turn, Waze-like, at the rect's top left (inside the shading)
        const card = active && w.card && r ? cardKey(w.card) : null;
        if (card) {
            const inset = Math.max(24, Math.round(fade * 0.6));
            const g = { x: r.x + inset + (shape > 2 ? Math.round(r.w * 0.06) : 0), y: r.y + Math.round(inset * 0.6), w: CARD_W, h: CARD_H };
            if (this._image('card', g, 'overlay', 21, (cw, ch) => cardImage(cw, ch, w.card), card)) this._show('card', true);
        } else this._show('card', false);
        // the test grid (parked only: main.js)
        if (w.grid && r) {
            if (this._image('grid', { x: 0, y: 0, w: PANEL_W, h: PANEL_H }, 'overlay', 30, (cw, ch) => gridImage(cw, ch, r, shape), 'g' + [r.x, r.y, r.w, r.h, shape].join(','))) this._show('grid', true);
        } else this._show('grid', false);
    }

    close() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.cr) {
            try { if (this.hosted) this.cr.unhost('map'); } catch (e) { /* gone */ }
            Object.keys(this.refs).forEach((k) => { try { if (this.refs[k]) this.cr.drop(this.refs[k]); } catch (e) { /* gone */ } });
            try { this.cr.close(); } catch (e) { /* closing */ }
        }
        this.cr = null; this.ready = false; this.hosted = false; this.refs = { frame: 0, strip: 0, grid: 0, card: 0 };
    }
}

/* ---------- the pictures ---------- */

const SHADE = [7, 9, 12];      // the cluster's own near-black, so the faded edge melts into BMW's background

/**
 * Over the map: transparent in the middle, darker towards the edges (fade px: the shading BMW draws round its own
 * map, "Bordi sfumati"). shape: 0 a rect with rounded corners; n > 2 a squared ellipse (superellipse |x|^n + |y|^n = 1,
 * "Forma": widest at mid height, flatter towards the top and bottom, as the space between the gauge arcs). Each
 * pixel's darkness follows its distance inside the shape, eased (smoothstep), so there is no visible line.
 */
function frameImage(w, h, fade, shape) {
    const c = new Canvas(w, h);
    c.clear([0, 0, 0, 0]);
    const d = c.d, f = Math.max(0, fade || 0), n = shape > 2 ? shape : 0;
    const hw = w / 2, hh = h / 2, rad = Math.max(RADIUS, Math.min(f, Math.min(w, h) / 2));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let out;     // signed distance to the shape's edge, px (negative inside)
            if (n) {
                const u = Math.abs(x + 0.5 - hw) / hw, v = Math.abs(y + 0.5 - hh) / hh;
                const r = Math.pow(Math.pow(u, n) + Math.pow(v, n), 1 / n);
                if (r < 1e-6) { out = -1e9; } else {
                    const gu = Math.pow(u / r, n - 1) / hw, gv = Math.pow(v / r, n - 1) / hh;
                    out = (r - 1) / Math.sqrt(gu * gu + gv * gv);
                }
            } else {
                const dx = Math.abs(x + 0.5 - hw) - (hw - rad), dy = Math.abs(y + 0.5 - hh) - (hh - rad);
                out = Math.sqrt(Math.max(dx, 0) * Math.max(dx, 0) + Math.max(dy, 0) * Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - rad;
            }
            let a;
            if (out >= 0) a = 1;
            else if (f > 0) { const t = Math.min(1, -out / f); a = 1 - t * t * (3 - 2 * t); }
            else a = Math.max(0, Math.min(1, out + 1));
            if (a <= 0.004) continue;
            const i = (y * w + x) * 4;
            d[i] = SHADE[0]; d[i + 1] = SHADE[1]; d[i + 2] = SHADE[2]; d[i + 3] = Math.round(a * 255);
        }
    }
    return c;
}

/** What the card shows, as a key: changes only when the picture would. */
function cardKey(t) {
    return [t.kind, t.dir, t.exit, t.dist, t.unit, t.road, t.then ? t.then.kind + t.then.dir : ''].join('|');
}

/** The turn's angle, degrees clockwise from straight on (0), or null for none (a dot). */
function angleOf(t) {
    const d = String(t.dir || '');
    if (t.kind === 'keep' || t.kind === 'lanechange' || /FORK|BRANCH|HIGHWAY_OUT/.test(d)) return /LEFT/.test(d) ? -40 : /RIGHT/.test(d) ? 40 : 0;
    if (/UTURN/.test(d)) return /LEFT/.test(d) ? -180 : 180;
    const side = /LEFT/.test(d) ? -1 : /RIGHT/.test(d) ? 1 : 0;
    if (!side) return /STRAIGHT|HIGHWAY_IN/.test(d) || t.kind === 'turn' ? 0 : null;
    return side * (/SLIGHT/.test(d) ? 45 : /HARD/.test(d) ? 135 : 90);
}

/** A white turn arrow in box s x s at (x, y). */
function arrow(c, x, y, s, t) {
    const W = '#ffffff', lw = s * 0.13, cx = x + s / 2, base = y + s * 0.95, mid = y + s * 0.5;
    if (t.kind === 'destination') {           // a chequered flag
        c.line(x + s * 0.3, y + s * 0.1, x + s * 0.3, base, lw * 0.7, W);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 === 0) c.fillRect(x + s * 0.3 + j * s * 0.13, y + s * 0.1 + i * s * 0.12, s * 0.13, s * 0.12, W);
        return;
    }
    if (t.kind === 'roundabout') {
        c.arc(cx, y + s * 0.42, s * 0.2, s * 0.2 + lw * 0.8, 0, 360, W);
        c.line(cx, base, cx, y + s * 0.64, lw, W);
        if (t.exit) c.text(String(t.exit), cx, y + s * 0.42 + s * 0.12, s * 0.32, W, { align: 'center', literal: true });
        return;
    }
    const a = angleOf(t);
    if (a === null) { c.circle(cx, mid, s * 0.14, W); return; }
    if (Math.abs(a) === 180) {                // U-turn: up, over, back down
        const dx = a > 0 ? s * 0.3 : -s * 0.3, r = Math.abs(dx) / 2, pts = [];
        for (let k = 0; k <= 12; k++) { const t2 = Math.PI * k / 12; pts.push([cx + (a > 0 ? 1 : -1) * (r - Math.cos(t2) * r), y + s * 0.35 - Math.sin(t2) * r]); }
        c.line(cx, base, cx, y + s * 0.35, lw, W); c.polyline(pts, lw, W); c.line(cx + dx, y + s * 0.35, cx + dx, y + s * 0.6, lw, W);
        c.triangle([[cx + dx - s * 0.16, y + s * 0.56], [cx + dx + s * 0.16, y + s * 0.56], [cx + dx, y + s * 0.8]], W);
        return;
    }
    const rad = a * Math.PI / 180, len = s * 0.34;
    const ex = cx + Math.sin(rad) * len, ey = mid - Math.cos(rad) * len;
    c.line(cx, base, cx, mid, lw, W); c.line(cx, mid, ex, ey, lw, W);
    const hx = Math.sin(rad), hy = -Math.cos(rad), px = -hy, py = hx, hs = s * 0.2;
    c.triangle([[ex + hx * hs, ey + hy * hs], [ex + px * hs * 0.8, ey + py * hs * 0.8], [ex - px * hs * 0.8, ey - py * hs * 0.8]], W);
}

/** The next-turn card, as Waze draws it: the arrow, the distance big, the street under it, "e poi" with the next one. */
function cardImage(w, h, t) {
    const c = new Canvas(w, h);
    c.clear([0, 0, 0, 0]);
    const thenH = t.then ? 44 : 0, top = h - thenH;
    c.roundRect(0, 0, w, h, 26, [10, 10, 12, 235]);
    arrow(c, 22, 18, 96, t);
    const dist = t.dist ? t.dist + ' ' + t.unit : t.kind === 'destination' ? 'Arrivo' : '';
    c.text(dist, 140, 70, 52, '#ffffff', { literal: true });
    let road = String(t.road || '').replace(/\s+/g, ' ').trim();
    if (road.length > 26) road = road.slice(0, 25) + '…';
    if (road) c.text(road, 140, top - 26, 30, '#ffffff', { literal: true });
    if (t.then) {
        c.fillRect(0, top, w, 1, [255, 255, 255, 60]);
        c.text('e poi', 22, h - 13, 26, '#d0d0d0', { literal: true });
        arrow(c, w - 60, top + 4, 36, t.then);
    }
    return c;
}

/** The arrival line: a dark rounded pill, white text centred. */
function stripImage(w, h, text) {
    const c = new Canvas(w, h);
    c.clear([0, 0, 0, 0]);
    c.roundRect(0, 0, w, h, h / 2, [20, 22, 26, 225]);
    c.text(text, w / 2, h / 2 + 12, 32, '#ffffff', { align: 'center', literal: true });
    return c;
}

/** The test grid: lines every 40 px, stronger every 200 with the numbers, the rect in green. */
function gridImage(w, h, r, shape) {
    const c = new Canvas(w, h);
    c.clear([0, 0, 0, 0]);
    for (let x = 0; x <= w; x += 40) c.fillRect(Math.min(x, w - 2), 0, x % 200 ? 1 : 2, h, x % 200 ? [255, 255, 255, 70] : [255, 210, 0, 200]);
    for (let y = 0; y <= h; y += 40) c.fillRect(0, Math.min(y, h - 2), w, y % 200 ? 1 : 2, y % 200 ? [255, 255, 255, 70] : [255, 210, 0, 200]);
    for (let x = 200; x < w; x += 200) c.text(String(x), x + 4, 26, 22, '#ffd200', { literal: true });
    for (let y = 200; y < h; y += 200) c.text(String(y), 6, y - 6, 22, '#ffd200', { literal: true });
    const g = [40, 220, 90, 255];
    c.fillRect(r.x, r.y, r.w, 4, g); c.fillRect(r.x, r.y + r.h - 4, r.w, 4, g);
    c.fillRect(r.x, r.y, 4, r.h, g); c.fillRect(r.x + r.w - 4, r.y, 4, r.h, g);
    c.text(r.x + ',' + r.y + '  ' + r.w + 'x' + r.h, r.x + 12, r.y + 34, 26, '#28dc5a', { literal: true });
    if (shape > 2) {
        // the squared ellipse the map shows in: its corners outside it are dark, but they still cover what is under them
        const hw = r.w / 2, hh = r.h / 2, cx = r.x + hw, cy = r.y + hh;
        for (let k = 0; k < 720; k++) {
            const t = k / 720 * 2 * Math.PI, ct = Math.cos(t), st = Math.sin(t);
            const px = cx + hw * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / shape), py = cy + hh * Math.sign(st) * Math.pow(Math.abs(st), 2 / shape);
            c.fillRect(Math.round(px) - 2, Math.round(py) - 2, 4, 4, [0, 200, 255, 255]);
        }
    }
    return c;
}

module.exports = { WideMap, crop, rectOf, frameImage, stripImage, gridImage, PANEL_W, PANEL_H };
