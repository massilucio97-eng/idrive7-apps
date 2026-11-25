'use strict';
/**
 * Mappa larga (mas_mappa_larga): the phone's map from Maps on cluster (robertnisipeanu/idrive-apps) shown larger on
 * the instrument cluster, in one rect between the two gauge arcs (wide_cluster.js), with Waze's arrival line under
 * it (route_info.js). Starts with the head unit and needs no screen: the settings decide.
 *
 * Settings: Mappa larga (off by default), the arrival line, the test grid (parked only) and the rect's four edges in
 * the cluster's pixels (1920 x 720). Screen MAIN: what it is doing; DIAG: the route data read and the car catalog's
 * entries that could give the time to the destination.
 *
 * Safety: the rect is kept inside the arcs by the user with the grid, parked; with no phone map, the setting off or a
 * warning on the cluster, nothing of this app is shown. Node 8: no ?., ?? or object spread.
 */
const mgu = require('./kit/mgu');
const Parked = require('./kit/parked');
const { WideMap, rectOf } = require('./wide_cluster');
const route = require('./route_info');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const parked = Parked.watch(ctx, log);
        const wide = new WideMap({ log: log, app: 'mas_mappa_larga' });
        const ri = route.start(ctx, log);

        const rect = () => rectOf({ left: Number(settings.get('left')), right: Number(settings.get('right')),
            top: Number(settings.get('top')), bottom: Number(settings.get('bottom')) });
        let lastStrip = null;

        function tick() {
            const r = rect();
            const info = ri.info();
            const strip = settings.get('strip') !== false ? route.line(info, Date.now()) : null;
            const card = settings.get('card') !== false && info && info.turn ? Object.assign({}, info.turn, { then: info.then || null }) : null;
            const grid = settings.get('grid') === true && !parked.moving();
            wide.update({ on: settings.get('wide') === true, grid: grid, rect: r, strip: strip, card: card, fade: Number(settings.get('fade')) || 0, shape: Number(settings.get('shape')) || 0, edge: settings.get('edge') || 'auto' });
            if (strip !== lastStrip) lastStrip = strip;
            if (ui.isVisible('MAIN')) {
                ui.text('STATUS', wide.view() + (settings.get('grid') === true && parked.moving() ? ' · griglia nascosta in marcia' : ''));
                ui.text('ROUTE', 'Percorso: ' + ri.status() + (card ? ' · svolta: ' + (card.dist ? card.dist + ' ' + card.unit + ' ' : '') + (card.dir || card.kind) : '') + (strip ? ' · ' + strip : ''));
                ui.text('BTN_MODE', settings.get('wide') === true ? 'Passa alla mappa BMW normale' : 'Passa alla mappa a tutto schermo');
                ui.text('RECT', 'Rettangolo ' + r.x + ',' + r.y + '  ' + r.w + ' x ' + r.h + ' px (quadro 1920 x 720)');
            }
        }
        settings.onChange(() => tick());
        // one press: full screen <-> as BMW draws it (the same as the setting)
        ui.onClick('BTN_MODE', () => { settings.set('wide', settings.get('wide') !== true); tick(); });
        ui.onClick('BTN_DIAG', () => {
            const info = ri.info();
            ui.text('DIAG_1', 'Percorso: ' + ri.status() + (info ? ' · ' + Math.round(info.metres) + ' m all\'arrivo' +
                (Object.keys(info.keys).length ? ' · campi tempo: ' + JSON.stringify(info.keys) : ' · nessun campo tempo nella risposta') : ''));
            let lines;
            try { lines = route.probe(30); } catch (e) { lines = ['errore: ' + e.message]; }
            log.info('catalog probe: ' + lines.join(' | '));
            ui.text('DIAG_TEXT', 'Campi del catalogo che potrebbero dare il tempo all\'arrivo:\n' + lines.join('\n'));
            ui.open('DIAG');
        });
        tick();
        setInterval(tick, 1000);
    },
});
