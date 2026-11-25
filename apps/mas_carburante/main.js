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
 * Trend (trend.js): each day's prices of the zone's stations are kept 15 days (<data>/storico.json); the line under
 * the status says whether the stations around are raising or lowering their prices since the day before (the others
 * usually follow within 1-3 days), so whether to fill up today or wait. With the range under twice the range notice,
 * a notification once a day when the prices are rising.
 *
 * Read only: nothing is written to the car. Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const M = require('./mimit');
const fuelHttp = require('./fuel_http');
const LOG = require('./fuellog');
const PHONE = require('./phone');
const NOTIFY = require('./notify');
const TR = require('./trend');

const FILES = { stations: '/images/exportCSV/anagrafica_impianti_attivi.csv', prices: '/images/exportCSV/prezzo_alle_8.csv' };
const ROWS = 10;
const STALE_MS = 6 * 3600 * 1000, CHECK_MS = 30 * 60 * 1000, MOVE_KM = 8, RETRY_MS = 10 * 60 * 1000;
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

        const histFile = path.join(ctx.dataDir || '.', 'storico.json');
        let hist = { days: {} }, trend = null;
        try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); if (!hist || !hist.days) hist = { days: {} }; } catch (e) { hist = { days: {} }; }
        const saveHist = () => {
            try { fs.writeFileSync(histFile + '.tmp', JSON.stringify(hist)); fs.renameSync(histFile + '.tmp', histFile); }
            catch (e) { log.warn('storico.json not written: ' + e.message); }
        };
        try { zone = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); log.info('zone.json: ' + zone.comune + ', ' + Object.keys(zone.stations || {}).length + ' stations'); }
        catch (e) { zone = null; }
        if (zone && zone.pricesDate && !hist.days[zone.pricesDate]) { hist = TR.record(hist, zone.pricesDate, zone); saveHist(); }

        const choice = () => ({
            fuel: M.FUELS[settings.get('fuel')] ? settings.get('fuel') : 'benzina',
            mode: ['self', 'servito', 'any'].indexOf(settings.get('mode')) >= 0 ? settings.get('mode') : 'self',
            radius: Number(settings.get('radius')) || 10,
            zone: String(settings.get('zone') || 'RIVOLI').toUpperCase(),
            max: ROWS,
        });
        // the iPhone's position (phone.js), when fresh; else the zone in the settings, as before
        const phone = PHONE.start(http, ctx.dataDir, log, () => settings.get('gps') !== false);
        const pos = () => (settings.get('gps') !== false ? phone.position() : null);
        const near = (z, p) => z && z.gps && z.centre && M.km(z.centre.lat, z.centre.lon, p.lat, p.lon) < MOVE_KM;
        const fresh = () => {
            const c = choice(), p = pos();
            if (!zone || Date.now() - (zone.fetchedAt || 0) >= STALE_MS) return false;
            return p ? near(zone, p) : !zone.gps && zone.comune === c.zone;
        };
        /** What to show: { zone, from, label } (from: the phone's position, distances from it) or null. */
        const shown_ = () => {
            const c = choice(), p = pos();
            if (zone && p && near(zone, p)) return { zone: zone, from: p, label: 'da te (iPhone)' };
            if (zone && !zone.gps && zone.comune === c.zone) return { zone: zone, from: null, label: 'da ' + title(c.zone) };
            return null;
        };
        let lastTry = 0;
        // to the phone: notifications (ntfy app) and the summary for the Home screen widget
        const notifier = NOTIFY.start(http, phone.topic, log, () => settings.get('notify') !== false);
        let lastRange = null, kmChangedAt = Date.now(), kmSeen = null;

        /* ---------- the screen ---------- */
        function render(status) {
            const c = choice();
            const sz = shown_(), p = pos();
            const head = FUEL_NAME[c.fuel] + ' ' + MODE_NAME[c.mode] + ' · entro ' + c.radius + ' km ' + (sz ? sz.label : p ? 'da te (iPhone)' : 'da ' + title(c.zone));
            let info, list = [];
            if (sz && sz.zone.centre) {
                list = M.cheapest(sz.zone, Object.assign({}, c, { from: sz.from }));
                info = head + ' · prezzi del ' + dayMonth(zone.pricesDate);
                if (!list.length) info += ' · nessun distributore trovato';
            } else if (sz && !sz.zone.centre) {
                info = 'Nessun distributore registrato nel comune di ' + title(c.zone);
            } else {
                info = head + ' · ' + (busy ? 'scarico i prezzi...' : 'nessun dato: premi Aggiorna');
            }
            shown = list;
            trend = sz && sz.zone.centre ? TR.compute(hist, sz.zone, Object.assign({}, c, { from: sz.from })) : null;
            if (trend) ui.text('TREND_INFO', trend.line);
            else ui.text('TREND_INFO', Object.keys(hist.days).length < 2 ? 'Andamento prezzi: raccolgo i prezzi di ogni giorno, da domani ti dico se in zona salgono o scendono'
                : 'Andamento prezzi: pochi distributori da confrontare con ieri');
            ui.visible('TREND_INFO', !!(sz && sz.zone.centre));
            maybeTrendAlert();
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
            publishState(list);
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
            busy = true; lastError = null; lastTry = Date.now();
            const c = choice(), p = pos();
            const t0 = Date.now();
            log.info('refresh (' + why + '): ' + (p ? 'around the phone' : c.zone));
            try {
                render('scarico i distributori...');
                const zr = M.zoneReader(p ? { lat: p.lat, lon: p.lon } : c.zone);
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
                zone = { comune: p ? 'GPS' : c.zone, gps: !!p, fetchedAt: Date.now(), stationsDate: z.date, pricesDate: pr.date, centre: z.centre, stations: z.stations, prices: pr.prices };
                if (pr.date) { hist = TR.record(hist, pr.date, zone); saveHist(); log.info('storico: ' + Object.keys(hist.days).join(', ')); }
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

        /** Prices rising and the range under twice the range notice's: one notification a day (diary.trendAlerted: the day). */
        function maybeTrendAlert() {
            if (!trend || trend.kind !== 'up' || settings.get('trendAlert') === false || !zone || !zone.pricesDate) return;
            const thr = Number(settings.get('rangeAlert')) || 80;
            if (lastRange === null || lastRange >= 2 * thr || diary.trendAlerted === zone.pricesDate) return;
            diary.trendAlerted = zone.pricesDate; saveDiary();
            const b = shown[0];
            notifier.alert('Prezzi in salita', trend.short + ' Autonomia ' + lastRange + ' km.' + (b ? ' Il più economico: ' + euro(b.price) + ' · ' + (b.brand || 'Pompa bianca') + ', ' + title(b.addr) + '.' : ''), ['chart_with_upwards_trend', 'fuelpump'], 3);
        }

        /** The summary for the widget (notify.js sends it only when it changed). */
        function publishState(list) {
            const sm = LOG.summary(diary, Date.now()), tm = LOG.tripsMonth(diary, Date.now()), lt = diary.lastClosed, b = list && list[0], c = choice();
            notifier.state({ data: {
                fuel: FUEL_NAME[c.fuel] + ' ' + MODE_NAME[c.mode], l100: sm.l100, eurKm: sm.eurKm, avgPrice: sm.avgPrice,
                month: { litres: sm.month.litres, eur: sm.month.eur, trips: tm.count, km: tm.km, tripsEur: tm.eur },
                lastTrip: lt ? { at: lt.start, km: lt.km, litres: lt.litres, eur: lt.eur } : null,
                best: b ? { price: b.price, brand: b.brand || 'Pompa bianca', addr: title(b.addr), comune: title(b.comune), km: b.km } : null,
                trend: trend ? { kind: trend.kind, text: trend.short } : null,
                range: lastRange, odometer: diary.last ? diary.last.km : null, level: diary.last ? diary.last.level : null,
            } });
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
                    const closedBefore = diary.lastClosed;
                    const what = LOG.reading(diary, km, level, Date.now());
                    const lc = diary.lastClosed;
                    if (lc && lc !== closedBefore) {
                        // closed at this start: sent unless the stop notice already told it (diary.tripNotice: kept across starts)
                        const n = diary.tripNotice;
                        if (!n || n.start !== lc.start || lc.km - n.km >= 1) notifier.alert('Viaggio finito', tripText(lc), ['car'], 2);
                        diary.tripNotice = null;
                    }
                    if (what === 'new') {
                        const r = diary.refuels[diary.refuels.length - 1];
                        notifier.alert('Rifornimento trovato', '+' + num1(r.litres) + ' l a ' + kmInt(r.km) + ' km. In auto tocca il distributore dove hai fatto benzina, così salvo il prezzo.', ['fuelpump'], 3);
                    }
                    if (kmSeen === null || km !== kmSeen) { kmSeen = km; kmChangedAt = Date.now(); }
                    // the range: one notice when it falls under the setting, again only after it went back up
                    const range = typeof v.range === 'number' && v.range > 0 && v.range < 4095 ? v.range : null;
                    if (range !== null) {
                        lastRange = range;
                        const thr = Number(settings.get('rangeAlert')) || 0;
                        if (thr && range < thr && !diary.rangeAlerted) {
                            diary.rangeAlerted = true;
                            const b = shown[0];
                            notifier.alert('Autonomia ' + range + ' km', (b ? 'Il più economico vicino: ' + euro(b.price) + ' · ' + (b.brand || 'Pompa bianca') + ', ' + title(b.addr) + ' (' + kmText(b.km) + ')' : 'Fai benzina presto.') +
                                (trend ? ' ' + trend.short : ''), ['warning', 'fuelpump'], 4);
                        } else if (thr && range > thr + 30 && diary.rangeAlerted) diary.rangeAlerted = false;
                    }
                    if (what) { log.info('refuel ' + what + ': ' + JSON.stringify(diary.refuels[diary.refuels.length - 1])); saveDiary(); render(); }
                    else if (first) { saveDiary(); render(); }
                    // the last reading is kept at every new km, so a refuel after the car is switched off is found at the next start
                    else if (km !== savedKm) saveDiary();
                    savedKm = km;
                },
            }, log, { pollMs: 10000 }).then((sub) => { log.info('KombiIF: ' + (sub && sub.error ? sub.error : 'watching')); }, (e) => log.warn('KombiIF: ' + e.message));
        }

        ui.onClick('BTN_REFRESH', () => refresh('button'));
        ui.onClick('BTN_PHONE', () => {
            ui.text('PHONE_1', 'Canale della tua auto: ' + phone.topic);
            ui.text('PHONE_2', 'Stato: ' + phone.status() + ' · ' + notifier.status());
            ui.text('PHONE_TEXT', 'Sull\'iPhone, app Comandi > Automazione > Nuova > CarPlay > Si connette > Esegui subito.\n' +
                'Azioni: 1) Ottieni posizione attuale. 2) Testo: [Latitudine] ; [Longitudine] (dai dettagli della posizione, arrotondati a 3 decimali). ' +
                '3) Ottieni contenuto dell\'URL: https://ntfy.sh/' + phone.topic + ' , metodo POST, corpo: File/Testo con il testo del punto 2.\n' +
                'Notifiche: installa l\'app ntfy e iscriviti al canale ' + phone.topic + '-avvisi (server ntfy.sh).\n' +
                'Widget: app Scriptable, script carburante_widget.js con il canale ' + phone.topic + '.\n' +
                'La posizione resta valida 60 minuti; senza, l\'app usa la zona delle impostazioni. Il canale è segreto: non condividerlo (chi lo conosce può leggere la posizione inviata, ntfy.sh la tiene circa 12 ore).');
            ui.open('PHONE');
        });
        settings.onChange((k) => {
            if ((k === 'zone' || k === 'gps') && !fresh()) refresh(k + ' changed');
            else render();
        });
        render();
        // a moment for the phone's position (phone.js asks at 2 s): one download, around the right place
        setTimeout(() => { if (!fresh()) refresh('start'); }, 6000);
        setInterval(() => { if (!fresh() && !busy) refresh('timer'); }, CHECK_MS);
        // a new position from the phone, farther than MOVE_KM from the stations kept: download them again (not more
        // often than RETRY_MS, a download is ~14 MB on the phone's data)
        let seenPos = null;
        setInterval(() => {
            const p = pos();
            if (!p || (seenPos && p.at === seenPos.at)) return;
            seenPos = p;
            if (!fresh() && !busy && (Date.now() - lastTry > RETRY_MS || (zone && !zone.gps))) refresh('phone position'); else render();
        }, 30000);
        setInterval(() => { if (ui.isVisible('MAIN') && !busy) render(); if (ui.isVisible('DIARY')) renderDiary(); }, 60000);
        // the car stands (the odometer still for 2 minutes, usually parked with the head unit still on): the trip so far to the
        // phone, once (again only after 5 more km); the closed trip at the next start is not sent a second time
        setInterval(() => {
            if (!diary.trip || Date.now() - kmChangedAt < 120000) return;
            const t = LOG.tripPreview(diary);
            const n = diary.tripNotice;
            if (!t || t.km < 1 || (n && n.start === t.start && t.km - n.km < 5)) return;
            diary.tripNotice = { start: t.start, km: t.km };
            saveDiary();
            notifier.alert('Viaggio finito', tripText(t), ['car'], 2);
            render();
        }, 30000);
    },
});
