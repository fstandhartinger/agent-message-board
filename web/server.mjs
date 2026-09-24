import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USERNAME = process.env.BOARD_USERNAME || 'board';
const PASSWORD = process.env.BOARD_PASSWORD;
const EXPORT_TOKEN = process.env.BOARD_EXPORT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 10;
const failures = new Map();
let snapshot = null;
let snapshotJson = '';

if (!PASSWORD || Buffer.byteLength(PASSWORD, 'utf8') < 20 || !EXPORT_TOKEN) {
  throw new Error('Required board authentication configuration is missing');
}

const fixedTimeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length < 512) {
    const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts.at(-1);
  }
  return request.socket.remoteAddress || 'unknown';
}

function withinFailureLimit(address) {
  const now = Date.now();
  const recent = (failures.get(address) || []).filter((time) => now - time < FAILURE_WINDOW_MS);
  if (recent.length >= FAILURE_LIMIT) {
    failures.set(address, recent);
    return false;
  }
  failures.set(address, recent);
  return true;
}

function recordFailure(address) {
  const now = Date.now();
  const recent = (failures.get(address) || []).filter((time) => now - time < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(address, recent);
  if (failures.size > 5000) {
    for (const [key, times] of failures) {
      if (!times.length || now - times.at(-1) >= FAILURE_WINDOW_MS) failures.delete(key);
    }
    while (failures.size > 5000) failures.delete(failures.keys().next().value);
  }
}

function basicAuth(request) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  return fixedTimeEqual(user, USERNAME) && fixedTimeEqual(pass, PASSWORD);
}

function send(response, status, body, contentType = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    ...extra
  });
  response.end(body);
}

function sendJson(response, status, value, extra = {}) {
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8', extra);
}

async function readRequestBody(request, response) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > MAX_SNAPSHOT_BYTES) {
    sendJson(response, 413, { error: 'Snapshot too large' });
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SNAPSHOT_BYTES) {
      sendJson(response, 413, { error: 'Snapshot too large' });
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validSnapshot(candidate) {
  if (!candidate || ![1, 2].includes(candidate.schemaVersion) || !Array.isArray(candidate.threads)) return false;
  if (candidate.threads.length > 20000) return false;
  return candidate.threads.every((thread) =>
    thread && typeof thread.id === 'string' && typeof thread.title === 'string' &&
    Array.isArray(thread.tags) && Array.isArray(thread.entries) &&
    thread.entries.length <= 100000
  );
}

async function handle(request, response) {
  const url = new URL(request.url || '/', 'http://localhost');
  const address = clientAddress(request);

  if (url.pathname === '/healthz' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true });
  }
  if (url.pathname === '/robots.txt' && request.method === 'GET') {
    return send(response, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
  }

  if (url.pathname === '/api/snapshot' && request.method === 'POST') {
    if (!withinFailureLimit(address)) return sendJson(response, 429, { error: 'Too many failed requests' }, { 'Retry-After': '900' });
    const bearer = request.headers.authorization || '';
    if (!bearer.startsWith('Bearer ') || !fixedTimeEqual(bearer.slice(7), EXPORT_TOKEN)) {
      recordFailure(address);
      return sendJson(response, 403, { error: 'Forbidden' });
    }
    failures.delete(address);
    const raw = await readRequestBody(request, response);
    if (raw === null) return;
    let candidate;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return sendJson(response, 400, { error: 'Invalid JSON' });
    }
    if (!validSnapshot(candidate)) return sendJson(response, 400, { error: 'Invalid snapshot format' });
    snapshot = candidate;
    snapshotJson = JSON.stringify(candidate);
    return sendJson(response, 202, { ok: true, exportedAt: candidate.exportedAt || null });
  }

  const protectedArea = url.pathname === '/' || url.pathname.startsWith('/thread/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/');
  if (protectedArea) {
    if (!withinFailureLimit(address)) return sendJson(response, 429, { error: 'Too many failed login attempts' }, { 'Retry-After': '900' });
    if (!basicAuth(request)) {
      recordFailure(address);
      return sendJson(response, 401, { error: 'Authentication required' }, { 'WWW-Authenticate': 'Basic realm="Agent Message Board", charset="UTF-8"' });
    }
    failures.delete(address);
  }

  if ((url.pathname === '/' || url.pathname.startsWith('/thread/')) && request.method === 'GET') {
    const html = await readFile(path.join(HERE, 'public', 'index.html'), 'utf8');
    return send(response, 200, html, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/assets/app.js' && request.method === 'GET') {
    const js = await readFile(path.join(HERE, 'public', 'app.js'), 'utf8');
    return send(response, 200, js, 'text/javascript; charset=utf-8');
  }
  if (url.pathname === '/assets/styles.css' && request.method === 'GET') {
    const css = await readFile(path.join(HERE, 'public', 'styles.css'), 'utf8');
    return send(response, 200, css, 'text/css; charset=utf-8');
  }

  if (url.pathname === '/api/board' && request.method === 'GET') {
    if (!snapshot) return sendJson(response, 503, { error: 'Board snapshot is not available yet' });
    return send(response, 200, snapshotJson, 'application/json; charset=utf-8');
  }

  return send(response, 404, 'Not found\n', 'text/plain; charset=utf-8');
}

const server = createServer((request, response) => {
  handle(request, response).catch(() => {
    if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error' });
    else response.destroy();
  });
});

server.listen(PORT, '::', () => {
  console.log(`Agent board web listening on port ${PORT}`);
});
