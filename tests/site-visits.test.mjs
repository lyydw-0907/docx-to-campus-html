import test from 'node:test';
import assert from 'node:assert/strict';
import { startSiteVisits } from '../public/site-visits.js';

const since = '2026-10-07T08:30:00.000Z';
function fixture({ href = 'https://tool.example/', endpoint = '/api/visits', element = true } = {}) {
  const counter = element ? { hidden: false, textContent: 'old count', title: 'old title' } : null;
  const document = {
    querySelector: selector => selector === 'meta[name="campus-visit-counter"]' ? { content: endpoint } : null,
    getElementById: id => id === 'site-visits' ? counter : null,
  };
  return { counter, options: { document, location: { href }, topLevel: true } };
}
const json = (data = { total: 1234, since }, init = {}) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json' }, ...init,
});

test('disabled and missing configuration or elements never request or invent a zero', async () => {
  let requests = 0; const fetchRequest = () => { requests++; return json(); };
  for (const endpoint of ['', '  ', null, undefined]) {
    const { options, counter } = fixture({ endpoint });
    if (endpoint === undefined) options.document.querySelector = () => null;
    assert.equal(await startSiteVisits({ ...options, fetchRequest }), null);
    assert.equal(counter.hidden, true); assert.equal(counter.textContent, '');
  }
  assert.equal(await startSiteVisits({ ...fixture({ element: false }).options, fetchRequest }), null);
  assert.equal(await startSiteVisits({ document: undefined, fetchRequest }), null);
  assert.equal(requests, 0);
});

test('local, private, non-HTTPS and embedded pages send zero requests', async () => {
  let requests = 0; const fetchRequest = () => { requests++; return json(); };
  const origins = [
    'http://tool.example/', 'file:///C:/tool/index.html', 'https://localhost:4318/',
    'https://LOCALHOST./', 'https://preview.localhost/', 'https://127.0.0.1/', 'https://127.90.5.2/',
    'https://2130706433/', 'https://[::1]/', 'https://[0:0:0:0:0:0:0:1]/',
    'https://10.0.0.2/', 'https://172.20.0.2/', 'https://192.168.1.2/', 'https://[fd00::1]/',
    'https://[::ffff:127.0.0.1]/', 'https://school.local/', 'https://intranet/',
    'https://school.internal/', 'https://school.lan/', 'https://school.home/',
  ];
  for (const href of origins) {
    assert.equal(await startSiteVisits({ ...fixture({ href }).options, fetchRequest }), null, href);
  }
  assert.equal(await startSiteVisits({ ...fixture().options, topLevel: false, fetchRequest }), null);
  assert.equal(requests, 0);
});

test('unsafe endpoint configuration cannot send requests to another origin or leak query values', async () => {
  let requests = 0; const fetchRequest = () => { requests++; return json(); };
  for (const endpoint of ['https://other.example/api/visits', 'https://tool.example/api/visits', '//other.example/api/visits', '/\\other.example/api/visits', 'api/visits', '/api/visits?name=private.docx', '/api/visits#fragment', '/api/visits?', '/api/visits#']) {
    assert.equal(await startSiteVisits({ ...fixture({ endpoint }).options, fetchRequest }), null, endpoint);
  }
  assert.equal(requests, 0);
});

test('one initialization uses an empty private POST and renders the confirmed cumulative PV', async () => {
  const { options, counter } = fixture(); const calls = [];
  const fetchRequest = async (...args) => { calls.push(args); return json(); };
  const first = startSiteVisits({ ...options, fetchRequest });
  assert.equal(startSiteVisits({ ...options, fetchRequest }), first);
  assert.equal(counter.hidden, true);
  assert.deepEqual(await first, { total: 1234, since });
  assert.equal(startSiteVisits({ ...options, fetchRequest }), first);
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, 'https://tool.example/api/visits');
  assert.equal(init.method, 'POST'); assert.equal(Object.hasOwn(init, 'body'), false);
  assert.equal(init.credentials, 'omit'); assert.equal(init.referrer, ''); assert.equal(init.referrerPolicy, 'strict-origin');
  assert.equal(init.mode, 'same-origin'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  assert.deepEqual(init.headers, { Accept: 'application/json' }); assert.ok(init.signal instanceof AbortSignal);
  assert.equal(counter.hidden, false); assert.equal(counter.textContent, '累计访问 1,234 次');
  assert.match(counter.title, /刷新/); assert.match(counter.title, /启用/); assert.match(counter.title, /独立访客/);
});

test('no storage is used, fresh page elements count independently and zero is shown only from the service', async () => {
  let requests = 0; const fetchRequest = async () => { requests++; return json({ total: 0, since }); };
  const first = fixture(); const second = fixture();
  const forbidden = () => { throw new Error('Storage must not be read'); };
  first.options.document.localStorage = { getItem: forbidden, setItem: forbidden };
  Object.defineProperty(first.options.location, 'search', { get: forbidden });
  await startSiteVisits({ ...first.options, fetchRequest }); await startSiteVisits({ ...second.options, fetchRequest });
  assert.equal(requests, 2); assert.equal(first.counter.textContent, '累计访问 0 次');
});

test('HTTP, network, redirect and invalid JSON failures stay hidden with no retry', async () => {
  const failures = [
    async () => json({ total: 1234, since }, { status: 503 }),
    async () => { throw new TypeError('Failed to fetch'); },
    async () => { throw new TypeError('Redirect rejected'); },
    async () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    async () => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }),
  ];
  for (const failure of failures) {
    const { options, counter } = fixture(); let requests = 0;
    const fetchRequest = (...args) => { requests++; return failure(...args); };
    assert.equal(await startSiteVisits({ ...options, fetchRequest }), null);
    assert.equal(await startSiteVisits({ ...options, fetchRequest }), null);
    assert.equal(requests, 1); assert.equal(counter.hidden, true); assert.equal(counter.textContent, '');
  }
});

test('malformed totals and timestamps never become a displayed statistic', async () => {
  const invalid = [
    null, [], { total: -1, since }, { total: 1.5, since }, { total: '12', since },
    { total: Number.MAX_SAFE_INTEGER + 1, since }, { total: 12 }, { total: 12, since: 'yesterday' },
    { total: 12, since: '<img src=x onerror=alert(1)>' }, { total: 12, since: '2026-02-30T00:00:00Z' },
    { total: 12, since: '2026-10-07T24:00:00Z' }, { total: 12, since: '2026-10-07T00:00:00+25:00' },
  ];
  for (const data of invalid) {
    const { options, counter } = fixture();
    assert.equal(await startSiteVisits({ ...options, fetchRequest: async () => json(data) }), null);
    assert.equal(counter.hidden, true); assert.equal(counter.textContent, '');
  }
});

test('responses larger than 4 KB are bounded even without a Content-Length header', async () => {
  for (const response of [
    new Response(' '.repeat(4097), { headers: { 'content-type': 'application/json' } }),
    json({ total: 12, since }, { headers: { 'content-type': 'application/json', 'content-length': '4097' } }),
    json({ total: 12, since }, { headers: { 'content-type': 'application/json', 'content-length': 'invalid' } }),
  ]) {
    const { options, counter } = fixture();
    assert.equal(await startSiteVisits({ ...options, fetchRequest: async () => response }), null);
    assert.equal(counter.hidden, true);
  }
});

test('true deadline aborts a request that ignores AbortSignal and late success never appears', async () => {
  const { options, counter } = fixture(); let signal; let settle;
  const never = new Promise(resolve => { settle = resolve; });
  const before = Date.now();
  const result = await startSiteVisits({ ...options, timeoutMs: 15, fetchRequest: async (url, init) => { signal = init.signal; return never; } });
  assert.equal(result, null); assert.equal(signal.aborted, true); assert.ok(Date.now() - before < 1000);
  settle(json()); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(counter.hidden, true); assert.equal(counter.textContent, '');
});

test('deadline also bounds a response stream which never finishes', async () => {
  const { options, counter } = fixture(); let signal; let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"total":')); },
    cancel() { cancelled = true; },
  });
  const result = await startSiteVisits({ ...options, timeoutMs: 15, fetchRequest: async (url, init) => {
    signal = init.signal; return new Response(body, { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(result, null); assert.equal(signal.aborted, true); assert.equal(counter.hidden, true);
  assert.equal(cancelled, true);
});

test('successful response clears the timeout rather than aborting a completed fetch', async () => {
  const { options } = fixture(); let signal;
  await startSiteVisits({ ...options, timeoutMs: 10, fetchRequest: async (url, init) => { signal = init.signal; return json(); } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
});

test('Node initialization without a window or a usable document is safe', async () => {
  const { options } = fixture(); let requests = 0;
  assert.equal(await startSiteVisits({ ...options, topLevel: undefined, fetchRequest: () => { requests++; return json(); } }), null);
  assert.equal(await startSiteVisits({ document: { getElementById() { throw new Error('Unavailable document'); } } }), null);
  assert.equal(requests, 0);
});
