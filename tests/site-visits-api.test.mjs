import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequest } from '../functions/api/visits.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const sqliteOptions = { skip: DatabaseSync ? false : 'SQLite integration needs node:sqlite (Node 22.5+).' };
const migration = await readFile(new URL('../migrations/0001_site_visits.sql', import.meta.url), 'utf8');
const origin = 'https://campus-tool.pages.dev';
const since = '2026-10-07T01:02:03.000Z';

function request(method = 'POST', { url = `${origin}/api/visits`, headers = {}, body } = {}) {
  return new Request(url, { method, headers: { ...(method === 'POST' ? { Origin: origin } : {}), ...headers }, ...(body !== undefined ? { body, duplex: 'half' } : {}) });
}

function spyDb({ result = { total: 1, since }, fail = false } = {}) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const entry = { sql, parameters: [] };
      statements.push(entry);
      return { bind(...parameters) { entry.parameters = parameters; return this; }, async first() { if (fail) throw new Error('PRIVATE DATABASE DETAIL'); return result; } };
    },
  };
}

function sqliteDb(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(migration);
  const statements = [];
  return {
    sqlite, statements,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const entry = { sql, parameters: [] };
      statements.push(entry);
      return {
        bind(...parameters) { entry.parameters = parameters; return this; },
        async first() { return statement.get(...entry.parameters) ?? null; },
      };
    },
  };
}

function call(input, db, configuredOrigin = origin) {
  return onRequest({ request: input, env: { VISIT_COUNTER_ORIGIN: configuredOrigin, VISITS_DB: db } });
}

test('GET returns the persistent count without incrementing; POST updates one shared row atomically', sqliteOptions, async () => {
  const db = sqliteDb();
  try {
    const first = await call(request('GET'), db);
    const initial = await first.json();
    assert.equal(first.status, 200);
    assert.equal(initial.total, 0);
    assert.equal(new Date(initial.since).toISOString(), initial.since);
    const totals = [];
    for (let index = 0; index < 3; index++) totals.push((await (await call(request(), db)).json()).total);
    assert.deepEqual(totals, [1, 2, 3]);
    const last = await call(request('GET'), db);
    assert.deepEqual(await last.json(), { total: 3, since: initial.since });
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM site_visits').get().count, 1);
    assert.equal(db.statements.filter(item => /^\s*UPDATE/.test(item.sql)).length, 3);
    assert.equal(db.statements.filter(item => /^\s*SELECT/.test(item.sql)).length, 2);
    for (const item of db.statements) assert.deepEqual(item.parameters, /^\s*UPDATE/.test(item.sql) ? ['homepage', Number.MAX_SAFE_INTEGER] : ['homepage']);
    for (const response of [first, last]) {
      assert.match(response.headers.get('Cache-Control'), /no-store/);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
  } finally { db.sqlite.close(); }
});

test('concurrent valid page-view requests each increment once without losing updates', sqliteOptions, async () => {
  const db = sqliteDb();
  try {
    const results = await Promise.all(Array.from({ length: 80 }, () => call(request(), db)));
    assert.ok(results.every(response => response.status === 200));
    const totals = (await Promise.all(results.map(response => response.json()))).map(result => result.total).sort((a, b) => a - b);
    assert.deepEqual(totals, Array.from({ length: 80 }, (_, index) => index + 1));
    assert.equal((await (await call(request('GET'), db)).json()).total, 80);
  } finally { db.sqlite.close(); }
});

test('migration preserves an existing total and start time, and counts survive reopening the database', sqliteOptions, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'campus-visits-'));
  const path = join(directory, 'visits.sqlite');
  let db;
  try {
    db = sqliteDb(path);
    db.sqlite.prepare('UPDATE site_visits SET total = 42, since = ?').run(since);
    db.sqlite.exec(migration);
    assert.deepEqual(await (await call(request('GET'), db)).json(), { total: 42, since });
    db.sqlite.close();
    db = sqliteDb(path);
    assert.deepEqual(await (await call(request(), db)).json(), { total: 43, since });
  } finally {
    db?.sqlite.close();
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});

test('invalid and preview origins cannot read or alter the production counter', async () => {
  const db = spyDb();
  for (const configured of [undefined, '', 'http://campus-tool.pages.dev', `${origin}/`, `${origin}/path`, `${origin}?query=1`, 'https://name:password@campus-tool.pages.dev', 'https://localhost', 'https://foo.localhost', 'https://127.0.0.1', 'https://127.1.2.3', 'https://2130706433', 'https://[::1]', 'https://192.168.1.1', 'https://printer.local', 'https://intranet']) {
    const response = await onRequest({ request: request(), env: { VISIT_COUNTER_ORIGIN: configured, VISITS_DB: db } });
    assert.equal(response.status, 503, String(configured));
  }
  for (const url of ['https://preview.campus-tool.pages.dev/api/visits', 'https://localhost/api/visits', 'http://campus-tool.pages.dev/api/visits']) {
    assert.equal((await call(request('GET', { url }), db)).status, 403, url);
  }
  for (const supplied of ['', 'null', 'https://another-tool.pages.dev', `${origin}/`, 'http://campus-tool.pages.dev']) {
    assert.equal((await call(request('POST', { headers: { Origin: supplied } }), db)).status, 403, supplied);
  }
  const missingOrigin = request();
  missingOrigin.headers.delete('Origin');
  assert.equal((await call(missingOrigin, db)).status, 403);
  assert.equal(db.statements.length, 0);
});

test('methods, query strings, path payloads and declared document/JSON bodies are rejected before D1 access or body reads', async () => {
  const db = spyDb();
  for (const method of ['PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await call(request(method), db);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, POST');
  }
  for (const url of [`${origin}/api/visits?document=secret`, `${origin}/api/visits?`, `${origin}/api/visits/document.docx`, `${origin}/api/visits/`, `${origin}/api/visits#document`, `${origin}/api/visits#`, 'https://user:secret@campus-tool.pages.dev/api/visits']) {
    // Fetch Request disallows user information, so pass an otherwise ordinary request with a URL getter for that case.
    const input = url.includes('user:') ? request() : request('POST', { url });
    if (url.includes('user:')) Object.defineProperty(input, 'url', { value: url });
    assert.equal((await call(input, db)).status, 400, url);
  }
  let reads = 0;
  const forbidden = [
    request('POST', { headers: { 'Content-Type': 'application/json' } }),
    request('POST', { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }),
    request('POST', { headers: { 'Content-Length': '20000000' } }),
    request('POST', { headers: { 'Content-Length': '1' } }),
  ];
  for (const input of forbidden) {
    Object.defineProperty(input, 'body', { get() { reads++; throw new Error('Payload stream must not be accessed'); } });
    assert.equal((await call(input, db)).status, 400);
  }
  assert.equal(reads, 0);
  assert.equal(db.statements.length, 0);
});

test('empty platform streams count, while nonempty or stalled streams are bounded and never reach D1', async () => {
  const db = spyDb();
  const empty = new ReadableStream({ start(controller) { controller.close(); } });
  assert.equal((await call(request('POST', { headers: { 'Content-Length': '0' }, body: empty }), db)).status, 200);
  const emptyChunks = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array()); controller.close(); } });
  assert.equal((await call(request('POST', { body: emptyChunks }), db)).status, 200);
  assert.equal(db.statements.length, 2);
  let cancelled = 0;
  const content = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); }, cancel() { cancelled++; } });
  assert.equal((await call(request('POST', { body: content }), db)).status, 400);
  const endlesslyEmpty = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel() { cancelled++; } });
  assert.equal((await call(request('POST', { body: endlesslyEmpty }), db)).status, 400);
  const stalled = new ReadableStream({ cancel() { cancelled++; } });
  const started = performance.now();
  assert.equal((await call(request('POST', { body: stalled }), db)).status, 400);
  assert.ok(performance.now() - started < 2000);
  assert.equal(cancelled, 3);
  assert.equal(db.statements.length, 2);
});

test('missing database, failed statements, missing row and invalid stored results are generic noncached 503 responses', async () => {
  for (const db of [undefined, {}, spyDb({ fail: true }), spyDb({ result: null }), spyDb({ result: { total: -1, since } }), spyDb({ result: { total: 1.5, since } }), spyDb({ result: { total: Number.MAX_SAFE_INTEGER + 1, since } }), spyDb({ result: { total: 1, since: 'not a date' } }), spyDb({ result: { total: 1, since: '2026-02-30T01:02:03.000Z' } })]) {
    const response = await call(request(), db);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Visit count unavailable.' });
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('safe-integer limit is readable and never incremented, and schema rejects corrupted counts or additional rows', sqliteOptions, async () => {
  const db = sqliteDb();
  try {
    db.sqlite.prepare('UPDATE site_visits SET total = ?').run(Number.MAX_SAFE_INTEGER);
    assert.equal((await (await call(request('GET'), db)).json()).total, Number.MAX_SAFE_INTEGER);
    assert.equal((await call(request(), db)).status, 503);
    assert.equal(db.sqlite.prepare('SELECT total FROM site_visits').get().total, Number.MAX_SAFE_INTEGER);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => db.sqlite.prepare('UPDATE site_visits SET total = ?').run(value), /constraint/i);
    assert.throws(() => db.sqlite.prepare('INSERT INTO site_visits (id) VALUES (?)').run('visitor-id'), /constraint/i);
    assert.throws(() => db.sqlite.prepare('UPDATE site_visits SET since = ?').run('2026-02-30T01:02:03.000Z'), /constraint/i);
  } finally { db.sqlite.close(); }
});

test('corrupted stored timestamps cannot increment even if external database writes bypassed migration constraints', sqliteOptions, async () => {
  const db = sqliteDb();
  try {
    db.sqlite.exec('PRAGMA ignore_check_constraints = ON');
    db.sqlite.prepare('UPDATE site_visits SET total = 7, since = ?').run('2026-02-30T01:02:03.000Z');
    assert.equal((await call(request(), db)).status, 503);
    assert.equal((await call(request('GET'), db)).status, 503);
    assert.equal(db.sqlite.prepare('SELECT total FROM site_visits').get().total, 7);
  } finally { db.sqlite.close(); }
});
