import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from '../src/server.mjs';

async function localServer(t) {
  const server = createServer();
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test('native HTTP serves progress and visit modules as executable JavaScript with their real exports', async t => {
  const origin = await localServer(t);
  for (const [filename, exported] of [
    ['progress-actions.js', 'createProgressActions'], ['work-progress.js', 'createWorkProgress'], ['site-visits.js', 'startSiteVisits'],
  ]) {
    const response = await fetch(`${origin}/${filename}`);
    assert.equal(response.status, 200, `${filename} must load in the native page`);
    assert.match(response.headers.get('Content-Type'), /^text\/javascript; charset=utf-8$/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    const source = await response.text();
    assert.equal(source, await readFile(new URL(`../public/${filename}`, import.meta.url), 'utf8'));
    assert.match(source, new RegExp(`export\\s+(?:async\\s+)?function\\s+${exported}\\b`));
  }
});

test('every local ES module reachable from native app.js loads through the actual HTTP allowlist', async t => {
  const origin = await localServer(t);
  const pending = [new URL('/app.js', origin).href];
  const visited = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url)) continue;
    visited.add(url);
    const response = await fetch(url);
    assert.equal(response.status, 200, `module ${url} must be served`);
    assert.match(response.headers.get('Content-Type'), /^text\/javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^[./]/, 'native browser imports must be local paths');
      const dependency = new URL(match[1], url);
      assert.equal(dependency.origin, origin);
      pending.push(dependency.href);
    }
  }
  for (const name of ['progress-actions.js', 'work-progress.js', 'site-visits.js', 'job-recovery.js', 'image-mapping.js']) {
    assert.ok(visited.has(`${origin}/${name}`), `${name} is reachable from app.js`);
  }
});

test('new static modules retain the restricted HTTP surface and do not intercept image API routes', async t => {
  const origin = await localServer(t);
  for (const pathname of ['/unknown-module.js', '/src/server.mjs', '/package.json']) {
    const response = await fetch(`${origin}${pathname}`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
  }
  const rejected = await fetch(`${origin}/work-progress.js`, { headers: { Origin: 'https://outside.example.test' } });
  assert.equal(rejected.status, 403);
  const expired = await fetch(`${origin}/api/import-images/00000000-0000-0000-0000-000000000000`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sectionId: 'research-purpose', html: '<p>synthetic</p>' }),
  });
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).code, 'JOB_EXPIRED');
});
