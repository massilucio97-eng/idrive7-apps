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
const STRIP_W = 560, STRIP_H = 64;

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
        this.refs = { frame: 0, strip: 0, grid: 0 };
        this.drawn = { frame: null, strip: null, grid: null };
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
            this.ready = true; this.refs = { frame: 0, strip: 0, grid: 0 }; this.drawn = { frame: null, strip: null, grid: null }; this.hosted = false; this.vis = {};
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
        const fade = w.fade || 0;
        if (r && (active || w.grid)) this._image('frame', r, 'content', 10, (cw, ch) => frameImage(cw, ch, fade), r.w + 'x' + r.h + 'f' + fade);
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
        // the test grid (parked only: main.js)
        if (w.grid && r) {
            if (this._image('grid', { x: 0, y: 0, w: PANEL_W, h: PANEL_H }, 'overlay', 30, (cw, ch) => gridImage(cw, ch, r), 'g' + [r.x, r.y, r.w, r.h].join(','))) this._show('grid', true);
        } else this._show('grid', false);
    }

    close() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.cr) {
            try { if (this.hosted) this.cr.unhost('map'); } catch (e) { /* gone */ }
            Object.keys(this.refs).forEach((k) => { try { if (this.refs[k]) this.cr.drop(this.refs[k]); } catch (e) { /* gone */ } });
            try { this.cr.close(); } catch (e) { /* closing */ }
        }
        this.cr = null; this.ready = false; this.hosted = false; this.refs = { frame: 0, strip: 0, grid: 0 };
    }
}

/* ---------- the pictures ---------- */

const SHADE = [7, 9, 12];      // the cluster's own near-black, so the faded edge melts into BMW's background

/**
 * Over the map: transparent in the middle, darker towards the edges (fade px: the shading BMW draws round its own
 * map, "Bordi sfumati"), the corners rounded. fade 0: only the rounded corners. Each pixel's darkness follows its
 * distance inside a rounded rect, eased (smoothstep), so there is no visible line.
 */
function frameImage(w, h, fade) {
    const c = new Canvas(w, h);
    c.clear([0, 0, 0, 0]);
    const d = c.d, f = Math.max(0, fade || 0), rad = Math.max(RADIUS, Math.min(f, Math.min(w, h) / 2));
    const hw = w / 2, hh = h / 2;
    for (let y = 0; y < h; y++) {
        const dy = Math.abs(y + 0.5 - hh) - (hh - rad);
        for (let x = 0; x < w; x++) {
            const dx = Math.abs(x + 0.5 - hw) - (hw - rad);
            // signed distance to the rounded rect's edge (negative inside)
            const out = Math.sqrt(Math.max(dx, 0) * Math.max(dx, 0) + Math.max(dy, 0) * Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - rad;
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

/** The arrival line: a dark rounded pill, white text centred. */
function stripImage(w, h, text) {
    const c = new Canvas(w, h);
    c.clear([0, 0, 0, 0]);
    c.roundRect(0, 0, w, h, h / 2, [20, 22, 26, 225]);
    c.text(text, w / 2, h / 2 + 12, 32, '#ffffff', { align: 'center', literal: true });
    return c;
}

/** The test grid: lines every 40 px, stronger every 200 with the numbers, the rect in green. */
function gridImage(w, h, r) {
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
    return c;
}

module.exports = { WideMap, crop, rectOf, frameImage, stripImage, gridImage, PANEL_W, PANEL_H };
