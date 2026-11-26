'use strict';
/**
 * applog.js - the app's own log (kit: <data>/<app id>.log, and .log.1 before it), its last lines as one text, to send
 * to the phone when something does not work.
 *
 *   tail(dataDir, appId, maxLines) -> text (the newest last), with a header (app, time)
 *
 * Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 400 * 1024;

function tail(dataDir, appId, maxLines, extra) {
    const f = path.join(dataDir || '.', appId + '.log');
    let lines = [];
    [f + '.1', f].forEach((p) => {
        try {
            const st = fs.statSync(p);
            const fd = fs.openSync(p, 'r'), len = Math.min(st.size, MAX_BYTES), buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, st.size - len);
            fs.closeSync(fd);
            lines = lines.concat(buf.toString('utf8').split('\n').filter(Boolean));
        } catch (e) { /* none */ }
    });
    lines = lines.slice(-(maxLines || 500));
    const head = ['=== ' + appId + ' · log dall\'auto · ' + new Date().toISOString() + ' · ' + lines.length + ' righe ==='];
    return head.concat(lines, extra && extra.length ? ['', '=== altro ==='].concat(extra) : []).join('\n') + '\n';
}

module.exports = { tail };
