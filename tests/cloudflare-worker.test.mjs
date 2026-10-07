import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';

test('Cloudflare wrapper serves static assets without touching visitor storage', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const pathname of ['/', '/app.js', '/worker.js', '/pandoc.wasm.gz', '/demo.docx']) {
      const request = new Request(`https://campus.example${pathname}`, { method });
      let seen;
      const expected = new Response(method === 'HEAD' ? null : 'static');
      const env = { ASSETS: { fetch: input => { seen = input; return expected; } },
        VISITS_DB: { prepare: () => { throw new Error('Static asset touched visitor database'); } } };
      assert.equal(await worker.fetch(request, env), expected);
      assert.equal(seen, request);
    }
  }
});

test('Cloudflare wrapper refuses document POST instead of forwarding it to assets', async () => {
  let calls = 0;
  const request = new Request('https://campus.example/api/convert', { method: 'POST', body: 'synthetic docx bytes' });
  const response = await worker.fetch(request, { ASSETS: { fetch: () => { calls++; } } });
  assert.equal(response.status, 405);
  assert.equal(calls, 0);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
});

test('Cloudflare wrapper dispatches only the configured visit route', async () => {
  let calls = 0;
  const response = await worker.fetch(new Request('https://campus.example/api/visits', { method: 'POST' }),
    { ASSETS: { fetch: () => { calls++; } } });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
});
