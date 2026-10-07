const MAX_TOTAL = Number.MAX_SAFE_INTEGER;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
};

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...RESPONSE_HEADERS, ...headers } });
}

function unavailable() {
  return response({ error: 'Visit count unavailable.' }, 503);
}

function productionOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname;
    if (url.protocol !== 'https:' || value !== url.origin || url.username || url.password) return null;
    if (!hostname.includes('.') || hostname.endsWith('.') || hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname)) return null;
    if (/(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(hostname)) return null;
    return url.origin;
  } catch { return null; }
}

async function emptyBody(request) {
  // Reject declared payloads before touching the stream. Never decode or store a payload.
  const length = request.headers.get('Content-Length');
  if (request.headers.has('Content-Type') || (length !== null && length !== '0')) return false;
  if (request.body === null) return true;
  let reader;
  let timer;
  try {
    reader = request.body.getReader();
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); });
    for (let index = 0; index < 4; index++) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk?.done) return true;
      if (chunk === null || !(chunk.value instanceof Uint8Array) || chunk.value.byteLength !== 0) return false;
    }
    return false;
  } catch { return false; }
  finally {
    clearTimeout(timer);
    if (reader) {
      // A client-controlled stream must not keep an invalid request waiting on cancel.
      try { reader.cancel().catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}

function validRow(row) {
  if (!row || !Number.isSafeInteger(row.total) || row.total < 0 || typeof row.since !== 'string' || !ISO_DATE.test(row.since)) return false;
  const date = new Date(row.since);
  return Number.isFinite(date.valueOf()) && date.toISOString() === row.since;
}

export async function onRequest({ request, env = {} }) {
  const origin = productionOrigin(env.VISIT_COUNTER_ORIGIN);
  if (!origin) return unavailable();
  let url;
  try { url = new URL(request.url); } catch { return response({ error: 'Invalid request.' }, 400); }
  if (url.origin !== origin) return response({ error: 'Origin not allowed.' }, 403);
  if (url.pathname !== '/api/visits' || url.href.includes('?') || url.href.includes('#') || url.username || url.password) return response({ error: 'Invalid request.' }, 400);
  if (request.method !== 'GET' && request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
  if (request.method === 'POST' && request.headers.get('Origin') !== origin) return response({ error: 'Origin not allowed.' }, 403);
  if (!(await emptyBody(request))) return response({ error: 'Request body not allowed.' }, 400);
  if (!env.VISITS_DB || typeof env.VISITS_DB.prepare !== 'function') return unavailable();
  try {
    const row = request.method === 'GET'
      ? await env.VISITS_DB.prepare('SELECT total, since FROM site_visits WHERE id = ?').bind('homepage').first()
      : await env.VISITS_DB.prepare(`
          UPDATE site_visits SET total = total + 1
          WHERE id = ? AND typeof(total) = 'integer' AND total >= 0 AND total < ?
            AND typeof(since) = 'text' AND length(since) = 24
            AND strftime('%Y-%m-%dT%H:%M:%fZ', since) = since
          RETURNING total, since
        `).bind('homepage', MAX_TOTAL).first();
    if (!validRow(row)) return unavailable();
    return response({ total: row.total, since: row.since });
  } catch { return unavailable(); }
}
