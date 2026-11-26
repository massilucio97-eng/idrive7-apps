'use strict';
/**
 * notify.js - from the car to the phone, through the same private ntfy.sh topic family as phone.js:
 *   <topic>-avvisi  notifications, for the free ntfy app on the iPhone (subscribe to it there): a trip ended with its
 *                   cost, a refuel to tell where, a low range with the cheapest station near
 *   <topic>-stato   the latest summary as one JSON message, for the Home screen widget (Scriptable, carburante_widget.js)
 * Published as JSON to https://ntfy.sh/ (UTF-8 titles). With the car offline (no hotspot) the messages wait, at most
 * QUEUE of them, and go when the uplink is back; a notification older than MAX_AGE_MS is dropped instead.
 *
 * Whoever knows the topic can read these too (as phone.js says): they hold costs, km and station addresses, never the
 * car's position. Node 8: no ?., ?? or object spread. Never throws.
 */
const QUEUE = 12, MAX_AGE_MS = 3 * 3600 * 1000, FLUSH_MS = 20000;

function start(http, topic, log, enabled) {
    const queue = [];
    let busy = false, sent = 0, failed = 0, lastError = null, lastState = null;
    function flush() {
        if (busy || !queue.length || !http.online()) return;
        busy = true;
        const m = queue[0];
        if (m.kind === 'alert' && Date.now() - m.at > MAX_AGE_MS) { queue.shift(); busy = false; setImmediate(flush); return; }
        // the item itself is taken out (a newer summary may have replaced queued ones meanwhile: never shift blindly)
        const drop = () => { const i = queue.indexOf(m); if (i >= 0) queue.splice(i, 1); };
        http.post('/', JSON.stringify(m.body)).then((code) => {
            if (code >= 200 && code < 300) { drop(); sent++; lastError = null; }
            else { failed++; lastError = 'HTTP ' + code; if (code >= 400 && code < 500 && code !== 429) drop(); }
        }, (e) => { failed++; lastError = e.message || String(e); }).then(() => { busy = false; if (!lastError) setImmediate(flush); });
    }
    setInterval(flush, FLUSH_MS);
    function push(m) {
        if (m.kind === 'state') { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'state') queue.splice(i, 1); }   // only the newest
        queue.push(m);
        while (queue.length > QUEUE) queue.shift();
        flush();
    }
    return {
        /** A notification on the phone: title, text, tags (ntfy emoji names), priority 1-5; extra: { click (URL opened on a
         * tap), actions ([{ action: 'view', label, url }], buttons) }. Returns false when notifications are off. */
        alert(title, message, tags, priority, extra) {
            if (!enabled()) return false;
            log.info('notify: ' + title);
            const body = { topic: topic + '-avvisi', title: title, message: message, tags: tags || [], priority: priority || 3 };
            if (extra && extra.click) body.click = extra.click;
            if (extra && extra.actions) body.actions = extra.actions;
            push({ kind: 'alert', at: Date.now(), body: body });
            return true;
        },
        /** The summary for the widget (sent when it changed, or every 6 h so ntfy keeps one). */
        state(obj) {
            if (!enabled()) return;
            const s = JSON.stringify(obj.data);
            if (lastState && lastState.s === s && Date.now() - lastState.at < 6 * 3600 * 1000) return;
            lastState = { s: s, at: Date.now() };
            push({ kind: 'state', at: Date.now(), body: { topic: topic + '-stato', message: JSON.stringify(Object.assign({ v: 1, at: Date.now() }, obj.data)) } });
        },
        status: () => (!enabled() ? 'notifiche spente' : lastError ? 'notifiche: ultimo invio non riuscito (' + lastError + '), ' + queue.length + ' in attesa' :
            'notifiche: ' + sent + ' inviate' + (queue.length ? ', ' + queue.length + ' in attesa' : '')),
    };
}

module.exports = { start };
