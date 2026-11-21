'use strict';
/**
 * logkit preload — structured logs for a Node HTTP server WITHOUT touching its code (Next.js standalone server.js,
 * any app that calls http.createServer). Start it with:
 *     node -r ./logkit-preload.cjs server.js        (or NODE_OPTIONS="--require ./logkit-preload.cjs")
 * Env: LOG_APP (name, default COOLIFY_RESOURCE_NAME), LOG_LEVEL, LOG_IP=0 / LOG_UA=0 (leave out hashed IP / user agent
 * when the privacy page promises it), LOG_CONSOLE=0 (keep console untouched), LOG_SKIP (comma list of path prefixes
 * logged only when failing; default health checks + /_next/static/ + /favicon).
 * Effects: console.* -> JSON lines; crashes logged with stack (behaviour unchanged); every HTTP request -> one
 * `http.request` line with request id (incoming X-Request-Id honoured, else generated; echoed in X-Request-Id and
 * set on req.headers['x-request-id'] so the app can read it). Only the first http(s) server's 'request' event is wrapped
 * per server instance; listeners and responses are otherwise unchanged.
 */
const http = require('http');
const https = require('https');
const lk = require('./logkit.cjs');

const log = lk.createLogger({ app: process.env.LOG_APP || process.env.COOLIFY_RESOURCE_NAME || 'app' });
if (process.env.LOG_CONSOLE !== '0') lk.captureConsole(log);
lk.installProcessHandlers(log);
const skip = (process.env.LOG_SKIP || '/healthz,/health,/readyz,/api/health,/_next/static/,/_next/image,/favicon')
  .split(',').map((s) => s.trim()).filter(Boolean);
const mw = lk.httpLogger(log, { skip, ip: process.env.LOG_IP !== '0', ua: process.env.LOG_UA !== '0' });

for (const mod of [http, https]) {
  const proto = mod.Server.prototype;
  if (proto.__logkitPatched) continue;
  const orig = proto.emit;
  proto.emit = function logkitEmit(ev, req, res) {
    if (ev === 'request' && req && res && !req.__logkit) {
      req.__logkit = true;
      try {
        mw(req, res);
        if (req.id) req.headers['x-request-id'] = req.id;
      } catch (_) { /* logging must never break a request */ }
    }
    return orig.apply(this, arguments);
  };
  proto.__logkitPatched = true;
}
module.exports = { log };
