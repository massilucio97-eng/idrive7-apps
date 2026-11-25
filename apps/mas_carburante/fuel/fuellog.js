'use strict';
/**
 * fuellog.js - the refuelling diary: refuels found from the car's own tank gauge and odometer, the real
 * consumption between them and what they cost.
 *
 * The car (de.bmw.infotainment.KombiIF.statusRangeTankStatus, as cauliflowermossgrape's Live Data reads it):
 * fluidLevelFuelTank (litres), mileageKilometre (km). A refuel is the tank rising by RISE_L or more within
 * NEAR_KM: the car is filled with the engine off, so the jump shows at the next start. The gauge settles slowly,
 * so a further rise within NEAR_KM of a refuel is added to it.
 *
 * Consumption needs no full tank: the fuel used between two refuels is the level after the first minus the
 * level before the second (both read by the car), over the km between them.
 *
 * State (one JSON object, main.js keeps it in <data>/diario.json):
 *   { last: { km, level, at }, refuels: [{ at, km, litres, before, after, price, where }] }
 * price (EUR/l) and where (the station) are set when the user picks the station on the list; null until then.
 *
 * Pure functions. Node 8: no ?., ?? or object spread.
 */

const RISE_L = 4;          // a rise this large is a refuel (the gauge moves 1-2 l on slopes)
const NEAR_KM = 5;         // ... read within this many km of the last reading
const MAX_KEEP = 200;
const MIN_KM = 20;         // a consumption over fewer km is not shown (the gauge's error)

function empty() { return { last: null, refuels: [] }; }

/** A plausible reading? (the car sends all-ones for "not known") */
function valid(km, level) {
    return typeof km === 'number' && typeof level === 'number' && km > 0 && km < 2000000 && level >= 0 && level < 200;
}

/**
 * One reading of the car: updates state; returns 'new' (a refuel found), 'more' (added to the last one) or null.
 * now: ms (Date.now()).
 */
function reading(state, km, level, now) {
    if (!valid(km, level)) return null;
    const last = state.last;
    let what = null;
    if (last && km >= last.km && km - last.km <= NEAR_KM) {
        const rise = level - last.level;
        const prev = state.refuels.length ? state.refuels[state.refuels.length - 1] : null;
        if (prev && km - prev.km <= NEAR_KM && rise >= 1.5 && level > prev.after) {
            prev.litres = round1(prev.litres + (level - prev.after));
            prev.after = level;
            what = 'more';
        } else if (rise >= RISE_L) {
            state.refuels.push({ at: now, km: km, litres: round1(rise), before: last.level, after: level, price: null, where: null });
            if (state.refuels.length > MAX_KEEP) state.refuels.shift();
            what = 'new';
        }
    }
    state.last = { km: km, level: level, at: now };
    return what;
}

/** The newest refuel still without a price (the user hasn't said where), or null. */
function pending(state) {
    const r = state.refuels.length ? state.refuels[state.refuels.length - 1] : null;
    return r && r.price === null && !r.skipped ? r : null;
}

/** The station of the newest refuel: price EUR/l, where text. */
function setStation(state, price, where) {
    const r = pending(state);
    if (!r) return false;
    r.price = price; r.where = where || null;
    return true;
}
function skip(state) { const r = pending(state); if (r) r.skipped = true; return !!r; }
function undo(state) { return state.refuels.pop() || null; }

/** Consumption for refuel i (from refuel i-1): { km, used, l100 } or null. */
function leg(state, i) {
    const a = state.refuels[i - 1], b = state.refuels[i];
    if (!a || !b) return null;
    const km = b.km - a.km, used = a.after - b.before;
    if (km < MIN_KM || used <= 0) return null;
    return { km: km, used: round1(used), l100: Math.round(used / km * 1000) / 10 };
}

/**
 * The summary: { count, l100 (the mean over every leg, weighted by km), lastL100, eurKm, month: { litres, eur },
 * avgPrice } - null where not known. now: ms, for "this month".
 */
function summary(state, now) {
    const rs = state.refuels;
    let km = 0, used = 0, lastL100 = null;
    for (let i = 1; i < rs.length; i++) {
        const l = leg(state, i);
        if (l) { km += l.km; used += l.used; lastL100 = l.l100; }
    }
    let pl = 0, pe = 0;
    rs.forEach((r) => { if (r.price) { pl += r.litres; pe += r.litres * r.price; } });
    const avgPrice = pl ? pe / pl : null;
    const l100 = km >= MIN_KM ? Math.round(used / km * 1000) / 10 : null;
    const d = new Date(now), y = d.getFullYear(), m = d.getMonth();
    let ml = 0, me = 0;
    rs.forEach((r) => {
        const t = new Date(r.at);
        if (t.getFullYear() === y && t.getMonth() === m) { ml += r.litres; if (r.price) me += r.litres * r.price; }
    });
    return {
        count: rs.length, l100: l100, lastL100: lastL100,
        eurKm: l100 !== null && avgPrice !== null ? Math.round(l100 / 100 * avgPrice * 1000) / 1000 : null,
        month: { litres: round1(ml), eur: Math.round(me * 100) / 100 },
        avgPrice: avgPrice !== null ? Math.round(avgPrice * 1000) / 1000 : null,
    };
}

function round1(x) { return Math.round(x * 10) / 10; }

module.exports = { empty, valid, reading, pending, setStation, skip, undo, leg, summary, RISE_L, NEAR_KM, MIN_KM };
