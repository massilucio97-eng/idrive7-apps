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
 * Diary (fuellog.js): the tank level and the odometer (KombiIF.statusRangeTankStatus, read every 10 s) find each
 * refuel by themselves; the status line then asks where: a tap on the station in the list keeps its price, "Non ho
 * fatto benzina in questi" keeps the refuel without one. Screen DIARY: the real consumption, cost per km, the
 * month's spend and the last refuels. Kept in <data>/diario.json.
 *
 * Read only: nothing is written to the car. Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const M = require('./mimit');
const fuelHttp = require('./fuel_http');
const LOG = require('./fuellog');

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
const num1 = (x) => x.toFixed(1).replace('.', ',');
const kmInt = (k) => String(Math.round(k)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dateText = (ms) => { const d = new Date(ms); return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2); };
const KOMBI = 'de.bmw.infotainment.KombiIF';
/** "13,0 km · 0,85 l · 1,48 €" (what is known of it) */
const tripText = (t) => num1(t.km) + ' km' + (t.litres !== null ? ' · ' + t.litres.toFixed(2).replace('.', ',') + ' l' : '') +
    (t.eur !== null ? ' · ' + t.eur.toFixed(2).replace('.', ',') + ' €' : t.litres === null ? ' · consumo non ancora noto' : ' · prezzo: indica un distributore al prossimo pieno');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const http = fuelHttp.client(ctx.dataDir);
        const cacheFile = path.join(ctx.dataDir || '.', 'zone.json');
        let zone = null, busy = false, lastError = null, shown = [];
        const diaryFile = path.join(ctx.dataDir || '.', 'diario.json');
        let diary = LOG.empty(), carSignals = false, savedKm = null;
        try { diary = JSON.parse(fs.readFileSync(diaryFile, 'utf8')); if (!diary.refuels) diary = LOG.empty(); } catch (e) { diary = LOG.empty(); }
        const saveDiary = () => {
            try { fs.writeFileSync(diaryFile + '.tmp', JSON.stringify(diary)); fs.renameSync(diaryFile + '.tmp', diaryFile); }
            catch (e) { log.warn('diario.json not written: ' + e.message); }
        };

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
            shown = list;
            const pend = LOG.pending(diary);
            if (pend) {
                ui.text('LOG_INFO', 'Rifornimento trovato: +' + num1(pend.litres) + ' l a ' + kmInt(pend.km) + ' km. Tocca il distributore dove hai fatto benzina');
                ui.visible('BTN_SKIP', true);
            } else {
                const sm = LOG.summary(diary, Date.now()), lt = diary.lastClosed;
                if (lt && Date.now() - lt.end < 6 * 3600 * 1000) ui.text('LOG_INFO', 'Ultimo viaggio: ' + tripText(lt));
                else ui.text('LOG_INFO', sm.l100 !== null ? 'Consumo reale ' + num1(sm.l100) + ' l/100 km' + (sm.eurKm !== null ? ' · ' + sm.eurKm.toFixed(3).replace('.', ',') + ' €/km' : '') +
                    ' · questo mese ' + sm.month.eur.toFixed(2).replace('.', ',') + ' €' : carSignals ? 'Diario: il consumo compare dopo due rifornimenti' : 'Diario: aspetto il livello del serbatoio dall\'auto');
                ui.visible('BTN_SKIP', false);
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

        /* ---------- the diary ---------- */
        function renderDiary() {
            const sm = LOG.summary(diary, Date.now());
            ui.text('DIARY_1', sm.l100 !== null ? 'Consumo reale medio ' + num1(sm.l100) + ' l/100 km' + (sm.lastL100 !== null ? ' · ultimo pieno ' + num1(sm.lastL100) : '') :
                'Consumo reale: serve almeno un tratto di ' + LOG.MIN_KM + ' km tra due rifornimenti');
            ui.text('DIARY_2', (sm.eurKm !== null ? 'Costo ' + sm.eurKm.toFixed(3).replace('.', ',') + ' €/km' : 'Costo al km: serve il prezzo di due rifornimenti') +
                (sm.avgPrice !== null ? ' · prezzo medio ' + sm.avgPrice.toFixed(3).replace('.', ',') + ' €/l' : ''));
            ui.text('DIARY_3', 'Questo mese ' + num1(sm.month.litres) + ' l, ' + sm.month.eur.toFixed(2).replace('.', ',') + ' € · rifornimenti salvati: ' + sm.count +
                (diary.last ? ' · ora ' + num1(diary.last.level) + ' l, ' + kmInt(diary.last.km) + ' km' : ''));
            const tm = LOG.tripsMonth(diary, Date.now()), lt = diary.lastClosed;
            ui.text('DIARY_4', 'Viaggi del mese: ' + tm.count + ', ' + num1(tm.km) + ' km, ' + tm.eur.toFixed(2).replace('.', ',') + ' €' +
                (lt ? ' · ultimo viaggio (' + dateText(lt.start) + '): ' + tripText(lt) : ''));
            const rs = diary.refuels;
            for (let i = 0; i < 8; i++) {
                const k = rs.length - 1 - i, r = rs[k], name = 'LOG_' + (i + 1);
                if (!r) { ui.visible(name, false); continue; }
                const lg = LOG.leg(diary, k);
                ui.cells(name, 0, {
                    Text1stRow: dateText(r.at) + '   ·   +' + num1(r.litres) + ' l' + (r.price ? '   ·   ' + (r.litres * r.price).toFixed(2).replace('.', ',') + ' € (' + r.price.toFixed(3).replace('.', ',') + ' €/l)' : '') +
                        (lg ? '   ·   ' + num1(lg.l100) + ' l/100 km' : ''),
                    Text2ndRow: kmInt(r.km) + ' km' + (lg ? ' · ' + kmInt(lg.km) + ' km dal precedente' : '') + ' · ' + (r.where || (r.skipped ? 'distributore non indicato' : 'distributore da indicare')),
                });
                ui.visible(name, true);
            }
            ui.visible('BTN_UNDO', rs.length > 0);
        }
        for (let i = 1; i <= ROWS; i++) {
            const n = i;
            ui.onClick('ROW_' + n, () => {
                const s = shown[n - 1];
                if (!s || !LOG.pending(diary)) return;
                LOG.setStation(diary, s.price, (s.brand || 'Pompa bianca') + ', ' + title(s.addr) + ', ' + title(s.comune));
                saveDiary();
                log.info('refuel: station ' + s.id + ' at ' + s.price);
                render();
            });
        }
        ui.onClick('BTN_SKIP', () => { if (LOG.skip(diary)) { saveDiary(); render(); } });
        ui.onClick('BTN_DIARY', () => { renderDiary(); ui.open('DIARY'); });
        ui.onClick('BTN_UNDO', () => { const r = LOG.undo(diary); if (r) { saveDiary(); log.info('refuel removed: ' + r.km + ' km'); } renderDiary(); render(); });
        // the car: tank level and odometer, every 10 s (as Live Data polls KombiIF)
        if (ctx.signals && ctx.signals.watch) {
            ctx.signals.watch(KOMBI, '1', {
                statusRangeTankStatus: (v) => {
                    if (!v) return;
                    const km = v.mileageKilometre, level = v.fluidLevelFuelTank;
                    if (!LOG.valid(km, level)) return;
                    const first = !carSignals;
                    carSignals = true;
                    const what = LOG.reading(diary, km, level, Date.now());
                    if (what) { log.info('refuel ' + what + ': ' + JSON.stringify(diary.refuels[diary.refuels.length - 1])); saveDiary(); render(); }
                    else if (first) { saveDiary(); render(); }
                    // the last reading is kept at every new km, so a refuel after the car is switched off is found at the next start
                    else if (km !== savedKm) saveDiary();
                    savedKm = km;
                },
            }, log, { pollMs: 10000 }).then((sub) => { log.info('KombiIF: ' + (sub && sub.error ? sub.error : 'watching')); }, (e) => log.warn('KombiIF: ' + e.message));
        }

        ui.onClick('BTN_REFRESH', () => refresh('button'));
        settings.onChange((k) => {
            if (k === 'zone' && !fresh()) refresh('zone changed');
            else render();
        });
        render();
        if (!fresh()) refresh('start');
        setInterval(() => { if (!fresh() && !busy) refresh('timer'); }, CHECK_MS);
        setInterval(() => { if (ui.isVisible('MAIN') && !busy) render(); if (ui.isVisible('DIARY')) renderDiary(); }, 60000);
    },
});
