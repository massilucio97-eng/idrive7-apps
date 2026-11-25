'use strict';
/**
 * Carburante (mas_carburante): the cheapest fuel stations around a chosen comune, from the official MIMIT
 * open data (Osservaprezzi carburanti, IODL 2.0): the prices in force at 8 in the morning, published daily.
 *
 * Screen MAIN (an HMI list): a status line, the ten cheapest stations (price, distance, brand; name and
 * address on the second row), "Aggiorna i prezzi", then the settings (fuel, self / servito, zone, radius).
 *
 * Where: the car's own GPS position is not read (no app in the community reads it yet): the distance is from
 * the centre of the chosen comune (the mean of its stations' coordinates), so no address is ever stored.
 *
 * Data: the two files are read line by line as they arrive (fuel_http.js), and only the stations within
 * 25 km of the zone and their prices are kept, in <data>/zone.json (a few hundred KB): changing fuel, service
 * or radius needs no download; changing the zone does. A new download at start and every 30 minutes when
 * the kept data is older than 6 hours, or with "Aggiorna i prezzi".
 *
 * Read only: nothing is written to the car. Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const M = require('./mimit');
const fuelHttp = require('./fuel_http');

const FILES = { stations: '/images/exportCSV/anagrafica_impianti_attivi.csv', prices: '/images/exportCSV/prezzo_alle_8.csv' };
const ROWS = 10;
const STALE_MS = 6 * 3600 * 1000, CHECK_MS = 30 * 60 * 1000;
const FUEL_NAME = { benzina: 'Benzina', gasolio: 'Gasolio', gpl: 'GPL', metano: 'Metano' };
const MODE_NAME = { self: 'self', servito: 'servito', any: 'self o servito' };

const euro = (p) => p.toFixed(3).replace('.', ',') + ' €';
const kmText = (k) => (k < 10 ? k.toFixed(1).replace('.', ',') : String(Math.round(k))) + ' km';
const title = (s) => String(s || '').toLowerCase().replace(/(^|[\s'(-])(\S)/g, (m, a, b) => a + b.toUpperCase());
/** "2026-11-24" -> "24/11" */
const dayMonth = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? m[3] + '/' + m[2] : '?'; };
/** "24/11/2026 07:15:00" -> "24/11" */
const reportDay = (at) => { const m = /^(\d{2})\/(\d{2})\//.exec(at || ''); return m ? m[1] + '/' + m[2] : ''; };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const http = fuelHttp.client(ctx.dataDir);
        const cacheFile = path.join(ctx.dataDir || '.', 'zone.json');
        let zone = null, busy = false, lastError = null;

        try { zone = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); log.info('zone.json: ' + zone.comune + ', ' + Object.keys(zone.stations || {}).length + ' stations'); }
        catch (e) { zone = null; }

        const choice = () => ({
            fuel: M.FUELS[settings.get('fuel')] ? settings.get('fuel') : 'benzina',
            mode: ['self', 'servito', 'any'].indexOf(settings.get('mode')) >= 0 ? settings.get('mode') : 'self',
            radius: Number(settings.get('radius')) || 10,
            zone: String(settings.get('zone') || 'RIVOLI').toUpperCase(),
            max: ROWS,
        });
        const fresh = () => {
            const c = choice();
            return zone && zone.comune === c.zone && Date.now() - (zone.fetchedAt || 0) < STALE_MS;
        };

        /* ---------- the screen ---------- */
        function render(status) {
            const c = choice();
            const head = FUEL_NAME[c.fuel] + ' ' + MODE_NAME[c.mode] + ' · entro ' + c.radius + ' km da ' + title(c.zone);
            let info, list = [];
            if (zone && zone.comune === c.zone && zone.centre) {
                list = M.cheapest(zone, c);
                info = head + ' · prezzi del ' + dayMonth(zone.pricesDate);
                if (!list.length) info += ' · nessun distributore trovato';
            } else if (zone && zone.comune === c.zone && !zone.centre) {
                info = 'Nessun distributore registrato nel comune di ' + title(c.zone);
            } else {
                info = head + ' · ' + (busy ? 'scarico i prezzi...' : 'nessun dato: premi Aggiorna');
            }
            if (status) info += ' · ' + status;
            else if (lastError) info += ' · ultimo aggiornamento non riuscito: ' + lastError;
            ui.text('MENU_INFO', info);
            for (let i = 0; i < ROWS; i++) {
                const name = 'ROW_' + (i + 1), s = list[i];
                if (!s) { ui.visible(name, false); continue; }
                const day = reportDay(s.at);
                ui.cells(name, 0, {
                    Text1stRow: euro(s.price) + '   ·   ' + kmText(s.km) + '   ·   ' + (s.brand || 'Pompa bianca') + (c.mode === 'any' ? (s.self ? ' (self)' : ' (servito)') : ''),
                    Text2ndRow: title(s.addr) + ', ' + title(s.comune) + (s.name ? ' · ' + title(s.name) : '') + (day ? ' · comunicato il ' + day : ''),
                });
                ui.visible(name, true);
            }
        }

        /* ---------- the download ---------- */
        async function refresh(why) {
            if (busy) return;
            if (!http.online()) { lastError = 'auto offline (serve l\'hotspot)'; render(); return; }
            busy = true; lastError = null;
            const c = choice();
            const t0 = Date.now();
            log.info('refresh (' + why + '): ' + c.zone);
            try {
                render('scarico i distributori...');
                const zr = M.zoneReader(c.zone);
                const nb1 = await http.lines(FILES.stations, (l) => zr.line(l));
                const z = zr.done();
                log.info('stations: ' + z.total + ' read (' + Math.round(nb1 / 1024) + ' KB), ' + Object.keys(z.stations).length + ' kept, centre ' +
                    (z.centre ? z.centre.n + ' stations of ' + c.zone : 'none'));
                let pr = { date: null, prices: {} };
                if (z.centre) {
                    render('scarico i prezzi...');
                    const rd = M.priceReader(z.stations);
                    const nb2 = await http.lines(FILES.prices, (l) => rd.line(l));
                    pr = rd.done();
                    log.info('prices: ' + Object.keys(pr.prices).length + ' stations with prices (' + Math.round(nb2 / 1024) + ' KB)');
                }
                zone = { comune: c.zone, fetchedAt: Date.now(), stationsDate: z.date, pricesDate: pr.date, centre: z.centre, stations: z.stations, prices: pr.prices };
                try { fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(zone)); fs.renameSync(cacheFile + '.tmp', cacheFile); }
                catch (e) { log.warn('zone.json not written: ' + e.message); }
                log.info('refresh done in ' + Math.round((Date.now() - t0) / 1000) + ' s');
            } catch (e) {
                lastError = e.message || String(e);
                log.warn('refresh failed: ' + lastError);
            }
            busy = false;
            render();
        }

        ui.onClick('BTN_REFRESH', () => refresh('button'));
        settings.onChange((k) => {
            if (k === 'zone' && !fresh()) refresh('zone changed');
            else render();
        });
        render();
        if (!fresh()) refresh('start');
        setInterval(() => { if (!fresh() && !busy) refresh('timer'); }, CHECK_MS);
        setInterval(() => { if (ui.isVisible('MAIN') && !busy) render(); }, 60000);
    },
});
