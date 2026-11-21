'use strict';
/**
 * logkit (Node) — structured JSON logs per our logging standard (AGENTS.md "Logging standard").
 * Zero dependencies. Canonical copy: /home/flori/tools/logkit (vendor this file + logkit.mjs into an app).
 *
 *   const { createLogger, httpLogger, captureConsole, installProcessHandlers } = require('./logkit.cjs');
 *   const log = createLogger({ app: 'pdfmint' });
 *   captureConsole(log);              // existing console.* calls become JSON lines (level kept)
 *   installProcessHandlers(log);      // crash / unhandled rejection logged with stack (behaviour unchanged)
 *   app.use(httpLogger(log));         // Express or (req,res,next) style: request id + one access line per request
 *   req.log.info('invoice.created', { account_id, invoice_id });   // request-scoped, carries request_id
 *   log.error('stripe.webhook_failed', { err });                    // errors with name/message/stack
 *
 * Every line: {"ts","level","app","msg", ...fields}. Secrets are redacted and e-mails / client IPs hashed here
 * AND again in the central store (applogs). Never pass request/response bodies, prompts or documents.
 */
const crypto = require('crypto');
const util = require('util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /^(?:x-)?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|pass|authorization|proxy-authorization|cookie|set-cookie|session|sessionid|session[_-]?token|private[_-]?key|signature|sig|otp|pin|cvc|card[_-]?number|iban|stripe[_-]?signature|webhook[_-]?secret)$/i;
const IP_KEY = /^(?:ip|client[_-]?ip|remote[_-]?ip|remote[_-]?addr(?:ess)?|x-forwarded-for|x-real-ip|cf-connecting-ip|source[_-]?ip|user[_-]?ip)$/i;
const TOKEN_PATTERNS = [
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (m, p) => `${p} ${REDACTED}`],
  [/\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bcpk_[A-Za-z0-9._-]{16,}/g, REDACTED],
  [/\bhf_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, (m, s, u) => `${s}${u}:${REDACTED}@`],
  [/(["']?\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|authorization|cookie|session[_-]?id|session[_-]?token|x-api-key|private[_-]?key)["']?\s*[:=]\s*)(["']?)(?!\d+\b)(?!\[REDACTED\])([^\s"'&,;}{]{4,})/gi, (m, k, q) => `${k}${q}${REDACTED}`],
  [/([?&](?:key|api_key|apikey|token|access_token|auth|sig|signature|password|code|secret)=)[^&\s"'#]+/gi, (m, k) => k + REDACTED],
];
const EMAIL = /(?<![\w.+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24})\b/g;
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
const OWN_IPS = new Set(['65.109.49.103', '65.108.15.165', '37.27.102.32']);

// Hash salt: LOG_HASH_SALT (stable across restarts/instances) or a random per-process salt.
const SALT = process.env.LOG_HASH_SALT || crypto.randomBytes(16).toString('hex');

function hashId(value, kind = 'id') {
  if (value === undefined || value === null || value === '') return value;
  return `${kind}~${crypto.createHmac('sha256', SALT).update(String(value).trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

function isPrivateIp(ip) {
  if (OWN_IPS.has(ip)) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

function hashIp(ip) {
  if (!ip) return undefined;
  ip = String(ip).trim().replace(/^::ffff:/, '');
  return isPrivateIp(ip) ? ip : hashId(ip, 'ip');
}

function scrubText(s) {
  if (typeof s !== 'string' || !s) return s;
  for (const [re, rep] of TOKEN_PATTERNS) s = s.replace(re, rep);
  s = s.replace(EMAIL, (m, u, d) => `${hashId(m, 'email')}@${d}`);
  if (s.includes('.')) s = s.replace(IPV4, (ip) => (isPrivateIp(ip) ? ip : hashId(ip, 'ip')));
  return s;
}

function serializeError(err) {
  if (!(err instanceof Error)) return scrub(err);
  const out = { name: err.name, message: scrubText(String(err.message || '')) };
  if (err.code !== undefined) out.code = err.code;
  if (err.status !== undefined) out.status = err.status;
  if (err.statusCode !== undefined) out.status = err.statusCode;
  if (err.stack) out.stack = scrubText(String(err.stack)).split('\n').slice(0, 30).join('\n');
  if (err.cause) out.cause = serializeError(err.cause);
  return out;
}

function scrub(v, depth = 0, seen = new WeakSet()) {
  if (depth > 8) return '[DEPTH]';
  if (typeof v === 'string') return scrubText(v.length > 8192 ? v.slice(0, 8192) + '…[truncated]' : v);
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? String(v) : v;
  if (v instanceof Error) return serializeError(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `[Buffer ${v.length} bytes]`;
  if (seen.has(v)) return '[Circular]';
  seen.add(v);
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => scrub(x, depth + 1, seen));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || typeof val === 'function') continue;
    if (SENSITIVE_KEY.test(k) && val !== null && val !== '' && typeof val !== 'boolean' && typeof val !== 'number') out[k] = REDACTED;
    else if (IP_KEY.test(k) && typeof val === 'string') out[k] = val.split(',').map((x) => hashIp(x)).join(', ');
    else out[k] = scrub(val, depth + 1, seen);
  }
  return out;
}

function createLogger(opts = {}) {
  const app = opts.app || process.env.LOG_APP || process.env.COOLIFY_RESOURCE_NAME || 'app';
  const min = LEVELS[(opts.level || process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
  const base = { app, ...(opts.base || {}) };
  const out = opts.write || ((line) => process.stdout.write(line + '\n'));
  const emit = (level, bound, msg, fields) => {
    if (LEVELS[level] < min) return;
    let rec;
    try {
      if (msg instanceof Error) { fields = { ...(fields || {}), err: msg }; msg = msg.message; }
      const f = fields && typeof fields === 'object' ? scrub(fields) : (fields !== undefined ? { data: scrub(fields) } : {});
      rec = { ts: new Date().toISOString(), level, ...base, ...bound, msg: scrubText(String(msg)), ...f };
      out(JSON.stringify(rec));
    } catch (e) {
      try { out(JSON.stringify({ ts: new Date().toISOString(), level: 'error', app, msg: 'logkit.serialize_failed', error: String(e && e.message) })); } catch (_) { /* never throw from logging */ }
    }
  };
  const make = (bound) => {
    const l = {};
    for (const lv of Object.keys(LEVELS)) l[lv] = (msg, fields) => emit(lv, bound, msg, fields);
    l.child = (more) => make({ ...bound, ...scrub(more || {}) });
    l.app = app;
    return l;
  };
  return make({});
}

const RID_OK = /^[A-Za-z0-9._:-]{6,128}$/;
function newRequestId() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }

function clientIp(req) {
  const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  const first = xf ? String(xf).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '';
  return first;
}

/**
 * Express/Connect middleware (also usable as wrapper for plain http: httpLogger(log)(req, res, () => handler(req, res))).
 * opts.skip: array of path prefixes or RegExp not logged when status < 400 (default: health checks).
 * opts.ip / opts.ua: false = leave ip_hash / user agent out (use when the app's privacy page promises no IPs/UAs in logs).
 * Sets req.id, req.log (child logger with request_id) and the X-Request-Id response header.
 * Apps may add fields to the access line via req.logFields = { account_id, ... } (ids, never secrets).
 */
function httpLogger(log, opts = {}) {
  const skip = opts.skip || [/^\/(?:healthz?|readyz|livez|api\/health|_health|favicon\.ico)(?:$|[/?])/];
  const header = opts.header || 'x-request-id';
  return function logkitHttp(req, res, next) {
    const start = process.hrtime.bigint();
    let rid = req.headers && req.headers[header];
    if (Array.isArray(rid)) rid = rid[0];
    if (!rid || !RID_OK.test(String(rid))) rid = newRequestId();
    req.id = rid;
    req.log = log.child({ request_id: rid });
    try { if (!res.headersSent) res.setHeader('X-Request-Id', rid); } catch (_) { /* ignore */ }
    let done = false;
    const finish = (aborted) => {
      if (done) return; done = true;
      const status = res.statusCode;
      const path = String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300);
      if (status < 400 && skip.some((s) => (s instanceof RegExp ? s.test(path) : path.startsWith(s)))) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route && req.route.path ? String((req.baseUrl || '') + req.route.path) : undefined;
      const fields = {
        method: req.method, path, route, status, duration_ms: Math.round(ms * 10) / 10,
        bytes: Number(res.getHeader && res.getHeader('content-length')) || undefined,
        ip_hash: opts.ip === false ? undefined : hashIp(clientIp(req)),
        ua: opts.ua !== false && req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 160) : undefined,
        aborted: aborted || undefined, ...(req.logFields || {}),
      };
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      req.log[level]('http.request', fields);
    };
    res.on('finish', () => finish(false));
    res.on('close', () => finish(!res.writableEnded));
    if (typeof next === 'function') next();
  };
}

/** Express error handler that logs the error with stack, then passes it on unchanged (behaviour unchanged). */
function errorLogger(log) {
  // eslint-disable-next-line no-unused-vars
  return function logkitError(err, req, res, next) {
    (req.log || log).error('http.unhandled_error', { err, method: req.method, path: String(req.originalUrl || req.url || '').split('?')[0] });
    next(err);
  };
}

/** Route console.* through the logger so legacy console calls become JSON lines. Idempotent. */
function captureConsole(log) {
  if (console.__logkit) return;
  const map = { log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error' };
  for (const [fn, lv] of Object.entries(map)) {
    console[fn] = (...args) => {
      const errs = args.filter((a) => a instanceof Error);
      const msg = util.format(...args.map((a) => (a instanceof Error ? a.message : a)));
      log[lv](msg.length > 8192 ? msg.slice(0, 8192) + '…[truncated]' : msg, errs.length ? { err: errs[0], source: 'console' } : { source: 'console' });
    };
  }
  console.__logkit = true;
}

/** Log fatal crashes with stack. Uses the *monitor* hook: Node's default crash behaviour stays unchanged. */
function installProcessHandlers(log) {
  if (process.__logkitHandlers) return;
  process.__logkitHandlers = true;
  process.on('uncaughtExceptionMonitor', (err, origin) => log.fatal('process.crash', { err, origin }));
  process.on('exit', (code) => log.info('process.exit', { code }));
  log.info('process.start', { node: process.version, pid: process.pid, commit: process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT || undefined });
}

/** Time an outbound call: await timed(log, 'stripe.charge', () => fetch(...), { account_id }) -> logs duration + ok/error. */
async function timed(log, name, fn, fields = {}) {
  const t0 = process.hrtime.bigint();
  try {
    const r = await fn();
    const status = r && typeof r.status === 'number' ? r.status : undefined;
    log[status && status >= 500 ? 'warn' : 'info']('external.call', { call: name, status, duration_ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10, ...fields });
    return r;
  } catch (err) {
    log.error('external.call_failed', { call: name, duration_ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10, err, ...fields });
    throw err;
  }
}

module.exports = { createLogger, httpLogger, errorLogger, captureConsole, installProcessHandlers, timed, scrub, scrubText, hashId, hashIp, newRequestId };
