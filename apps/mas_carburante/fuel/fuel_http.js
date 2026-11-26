'use strict';
/**
 * fuel_http.js - one file from the MIMIT open data, read line by line as it arrives, through the Store's
 * internet uplink (mgu-uplink; kit/runtime/uplink.js resolves the host through the lease's DNS servers, as
 * arefahmad's and M850i-amn's apps do). Only www.mimit.gov.it is asked for the prices (a redirect is followed only
 * on it), ntfy.sh for the phone's position (phone.js: lines(path, fn, 'ntfy.sh')) and api.open-meteo.com for the
 * welcome's weather (meteo.js).
 *
 *   const http = require('./fuel_http').client(dataDir);
 *   await http.lines('/images/exportCSV/prezzo_alle_8.csv', (line) => ...);   // -> bytes read
 *
 * Node 8: no ?., ?? or object spread.
 */
const https = require('https');
const uplink = require('./kit/uplink');

const HOST = 'www.mimit.gov.it', HOSTS = ['www.mimit.gov.it', 'ntfy.sh', 'api.open-meteo.com'];
const MAX_BYTES = 80 * 1024 * 1024;     // the price file is ~10 MB, the stations ~4 MB
const TIMEOUT_MS = 30000;

function client(dataDir) {
    const lookupFor = uplink.resolver();
    function get(pathname, onLine, hops, host) {
        host = host || HOST;
        return new Promise((resolve, reject) => {
            if (HOSTS.indexOf(host) < 0) { reject(new Error('host not allowed: ' + host)); return; }
            const opts = { method: 'GET', host: host, port: 443, path: pathname, timeout: TIMEOUT_MS,
                headers: { 'User-Agent': 'mas_carburante/0.1 (iDrive 7)', 'Accept': 'text/csv,*/*' } };
            const lookup = lookupFor(uplink.lease(dataDir));
            if (lookup) opts.lookup = lookup;
            const ca = uplink.trustedCa(dataDir);
            if (ca) opts.ca = ca;
            const req = https.request(opts, (res) => {
                const loc = res.headers.location;
                if (res.statusCode >= 300 && res.statusCode < 400 && loc && hops < 2) {
                    res.resume();
                    const m = /^(?:https:\/\/www\.mimit\.gov\.it)?(\/[^\s]*)$/.exec(loc);
                    if (!m) { reject(new Error('redirect to another site refused')); return; }
                    if (host !== HOST) { reject(new Error('redirect refused')); return; }
                    get(m[1], onLine, hops + 1, host).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
                res.setEncoding('utf8');
                let rest = '', n = 0, failed = false;
                res.on('data', (chunk) => {
                    if (failed) return;
                    n += Buffer.byteLength(chunk);
                    if (n > MAX_BYTES) { failed = true; req.abort(); reject(new Error('file too large')); return; }
                    const parts = (rest + chunk).split('\n');
                    rest = parts.pop();
                    try { parts.forEach((l) => onLine(l.replace(/\r$/, ''))); }
                    catch (e) { failed = true; req.abort(); reject(e); }
                });
                res.on('end', () => {
                    if (failed) return;
                    try { if (rest) onLine(rest.replace(/\r$/, '')); } catch (e) { reject(e); return; }
                    resolve(n);
                });
                res.on('error', (e) => { if (!failed) reject(e); });
            });
            req.on('timeout', () => { req.abort(); reject(new Error('no answer from ' + host)); });
            req.on('error', reject);
            req.end();
        });
    }
    /** POST a small body (JSON) to ntfy.sh only: resolves with the status code. */
    function post(pathname, body) {
        return new Promise((resolve, reject) => {
            const data = Buffer.from(body, 'utf8');
            if (data.length > 4096) { reject(new Error('message too large')); return; }
            const opts = { method: 'POST', host: 'ntfy.sh', port: 443, path: pathname, timeout: TIMEOUT_MS,
                headers: { 'User-Agent': 'mas_carburante (iDrive 7)', 'Content-Type': 'application/json', 'Content-Length': data.length } };
            const lookup = lookupFor(uplink.lease(dataDir));
            if (lookup) opts.lookup = lookup;
            const ca = uplink.trustedCa(dataDir);
            if (ca) opts.ca = ca;
            const req = https.request(opts, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); });
            req.on('timeout', () => { req.abort(); reject(new Error('no answer from ntfy.sh')); });
            req.on('error', reject);
            req.end(data);
        });
    }
    /** PUT a file to ntfy.sh as an attachment (query: title, message, filename, tags, priority): resolves with the status. */
    function put(pathname, body, query) {
        return new Promise((resolve, reject) => {
            const data = Buffer.from(body, 'utf8');
            if (data.length > 2 * 1024 * 1024) { reject(new Error('file too large')); return; }
            const q = Object.keys(query || {}).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
            const opts = { method: 'PUT', host: 'ntfy.sh', port: 443, path: pathname + (q ? '?' + q : ''), timeout: 60000,
                headers: { 'User-Agent': 'mas_carburante (iDrive 7)', 'Content-Length': data.length } };
            const lookup = lookupFor(uplink.lease(dataDir));
            if (lookup) opts.lookup = lookup;
            const ca = uplink.trustedCa(dataDir);
            if (ca) opts.ca = ca;
            const req = https.request(opts, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); });
            req.on('timeout', () => { req.abort(); reject(new Error('no answer from ntfy.sh')); });
            req.on('error', reject);
            req.end(data);
        });
    }
    return {
        post: post,
        put: put,
        online() { return !!uplink.lease(dataDir); },
        lines(pathname, onLine, host) { return get(pathname, onLine, 0, host); },
    };
}

module.exports = { client, HOST, HOSTS };
