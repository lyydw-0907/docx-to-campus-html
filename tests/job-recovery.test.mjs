import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRecovery } from '../public/job-recovery.js';

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const expired = () => json({ code: 'JOB_EXPIRED', error: '本地转换结果已过期，请重新转换。' }, 410);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(jobId = OLD_ID) {
  return {
    jobId, fragment: '<p>正文<math><mi>x</mi></math><img src="data:image/png;base64,YQ=="><img src="data:image/png;base64,Yg=="></p>',
    assets: [
      { filename: 'image-a.png', mime: 'image/png', kind: 'image', width: 60, height: 30, uploadFilename: '01-image-a.png' },
      { filename: 'image-b.png', mime: 'image/png', kind: 'image', width: 40, height: 50, uploadFilename: '02-image-b.png' },
    ],
    manifest: { formulas: [{ index: 1, tex: 'x', display: false }], options: { fontSize: 14, scale: 3, formulaFormat: 'mathml', imageMode: 'embedded' }, warnings: [] },
  };
}

function harness(fetchRequest, callbacks = {}) {
  let current = fixture();
  const originalInput = new Blob(['original Word bytes']);
  const params = { fontSize: '14', scale: '3', formulaFormat: 'mathml' };
  const recovery = createJobRecovery({ getCurrent: () => current, fetchRequest, ...callbacks });
  recovery.remember(current, originalInput, params);
  return { recovery, originalInput, params, getCurrent: () => current, setCurrent: result => { current = result; } };
}

test('expired import restores original input and options, preserves result identity, and retries its unchanged payload', async () => {
  const calls = [];
  const callbacks = [];
  const source = '<p>学校源码<img src="https://school.example.test/upload/a.png"></p>';
  const manualUrls = { 'image-a.png': 'https://school.example.test/manual.png' };
  const init = { method: 'POST', body: JSON.stringify({ html: source, pageUrl: 'https://school.example.test/System/Edit' }) };
  const state = harness(async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('/api/convert?')) return json(fixture(NEW_ID));
    return url.endsWith(OLD_ID) ? expired() : json({ detectedCount: 2 });
  }, { onRecovering: result => callbacks.push(['recovering', result]), onRecovered: (result, previousId) => callbacks.push(['recovered', result, previousId]) });
  const original = state.getCurrent();
  const oldAssets = original.assets;
  const oldManifest = original.manifest;
  // Later selection changes must not alter the previous conversion's recovery.
  state.params.fontSize = '20';
  state.params.formulaFormat = 'png';
  const response = await state.recovery.request('import-images', init);
  assert.deepEqual(await response.json(), { detectedCount: 2 });
  assert.equal(state.getCurrent(), original);
  assert.equal(original.jobId, NEW_ID);
  assert.equal(original.assets, oldAssets);
  assert.equal(original.manifest, oldManifest);
  assert.equal(calls[1].url, '/api/convert?fontSize=14&scale=3&formulaFormat=mathml');
  assert.equal(calls[1].options.body, state.originalInput);
  assert.equal(await calls[1].options.body.text(), 'original Word bytes');
  assert.equal(calls[0].options, init);
  assert.equal(calls[2].options, init);
  assert.equal(source, JSON.parse(calls[2].options.body).html);
  assert.equal(manualUrls['image-a.png'], 'https://school.example.test/manual.png');
  assert.deepEqual(callbacks, [['recovering', original], ['recovered', original, OLD_ID]]);
});

test('image downloads and mapped exports restore their local jobs as well', async () => {
  for (const route of ['upload-images', 'export']) {
    const calls = [];
    const init = route === 'export' ? { method: 'POST', body: '{"mode":"mapped","format":"json","urls":{"image-a.png":"https://school.example.test/a.png"}}' } : undefined;
    const state = harness(async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('/api/convert?')) return json(fixture(NEW_ID));
      if (url.endsWith(OLD_ID)) return expired();
      return route === 'export' ? json({ fragment: '<p>映射正文</p>' }) : new Response('zip bytes', { headers: { 'Content-Type': 'application/zip' } });
    });
    const response = await state.recovery.request(route, init);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url, `/api/${route}/${NEW_ID}`);
    assert.equal(calls[2].options, init);
  }
});

test('concurrent expired requests share one recovery conversion', async () => {
  const pending = deferred();
  let conversions = 0;
  const state = harness(async url => {
    if (url.startsWith('/api/convert?')) { conversions++; return pending.promise; }
    return url.endsWith(OLD_ID) ? expired() : json({ route: url });
  });
  const first = state.recovery.request('import-images');
  const second = state.recovery.request('upload-images');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(conversions, 1);
  pending.resolve(json(fixture(NEW_ID)));
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(conversions, 1);
});

test('a late expired response uses an already restored ID without converting again', async () => {
  const late = deferred();
  let conversions = 0;
  const calls = [];
  const state = harness(async url => {
    calls.push(url);
    if (url.startsWith('/api/convert?')) { conversions++; return json(fixture(NEW_ID)); }
    if (url === `/api/upload-images/${OLD_ID}`) return late.promise;
    return url.endsWith(OLD_ID) ? expired() : json({ ok: true });
  });
  const delayed = state.recovery.request('upload-images');
  assert.equal((await state.recovery.request('import-images')).status, 200);
  late.resolve(expired());
  assert.equal((await delayed).status, 200);
  assert.equal(conversions, 1);
  assert.equal(calls.at(-1), `/api/upload-images/${NEW_ID}`);
});

test('clear prevents a pending restoration from reviving the old document', async () => {
  const pending = deferred();
  const started = deferred();
  let recovered = 0;
  const state = harness(async url => {
    if (url.startsWith('/api/convert?')) { started.resolve(); return pending.promise; }
    return expired();
  }, { onRecovered: () => { recovered++; } });
  const original = state.getCurrent();
  const request = state.recovery.request('export');
  const rejection = assert.rejects(request, /当前文档已变化/);
  await started.promise;
  state.recovery.clear();
  pending.resolve(json(fixture(NEW_ID)));
  await rejection;
  assert.equal(original.jobId, OLD_ID);
  assert.equal(recovered, 0);
});

test('remembering a new conversion makes the old restoration and response stale', async () => {
  const pending = deferred();
  const started = deferred();
  let recovered = 0;
  const state = harness(async url => {
    if (url.startsWith('/api/convert?')) { started.resolve(); return pending.promise; }
    return url.endsWith(OTHER_ID) ? json({ ok: true }) : expired();
  }, { onRecovered: () => { recovered++; } });
  const original = state.getCurrent();
  const request = state.recovery.request('import-images');
  const rejection = assert.rejects(request, /当前文档已变化/);
  await started.promise;
  const newer = fixture(OTHER_ID);
  state.setCurrent(newer);
  state.recovery.remember(newer, new Blob(['new Word']), new URLSearchParams({ fontSize: '20', formulaFormat: 'png' }));
  pending.resolve(json(fixture(NEW_ID)));
  await rejection;
  assert.equal(original.jobId, OLD_ID);
  assert.equal(newer.jobId, OTHER_ID);
  assert.equal(recovered, 0);
  assert.equal((await state.recovery.request('export')).status, 200);
});

test('recovery refuses changed body, formula structure, configuration or ordered asset identity', async () => {
  const mutations = [
    result => { result.fragment += '<p>不同内容</p>'; },
    result => { result.assets.reverse(); },
    ...['filename', 'mime', 'kind', 'width', 'height', 'uploadFilename'].map(field => result => { result.assets[0][field] = 'changed'; }),
    result => { result.manifest.formulas[0].tex = 'y'; },
    result => { result.manifest.options.fontSize = 20; },
    result => { result.jobId = 'invalid-job-id'; },
    result => { result.assets = null; },
  ];
  for (const mutate of mutations) {
    let recovered = 0;
    let calls = 0;
    const replacement = fixture(NEW_ID);
    mutate(replacement);
    const state = harness(async url => {
      calls++;
      return url.startsWith('/api/convert?') ? json(replacement) : expired();
    }, { onRecovered: () => { recovered++; } });
    await assert.rejects(state.recovery.request('import-images'), /不一致/);
    assert.equal(state.getCurrent().jobId, OLD_ID);
    assert.equal(recovered, 0);
    assert.equal(calls, 2);
  }
});

test('warning wording and object-key order changes do not alter document identity', async () => {
  const restored = fixture(NEW_ID);
  restored.manifest.warnings = ['Different local notice'];
  restored.manifest.options = Object.fromEntries(Object.entries(restored.manifest.options).reverse());
  restored.assets = restored.assets.map(asset => Object.fromEntries(Object.entries(asset).reverse()));
  const state = harness(async url => url.startsWith('/api/convert?') ? json(restored) : url.endsWith(OLD_ID) ? expired() : json({ ok: true }));
  assert.equal((await state.recovery.request('export')).status, 200);
  assert.equal(state.getCurrent().jobId, NEW_ID);
  assert.deepEqual(state.getCurrent().manifest.warnings, []);
});

test('recovery checks section assignment even when whole-document content is unchanged', async () => {
  const sections = [
    { id: 'purpose', title: '研究目的', kind: 'field', fragment: '<p>目的正文</p>', assetFilenames: [], formulaCount: 0, imageCount: 0, preview: 'original-preview' },
    { id: 'content', title: '研究内容', kind: 'field', fragment: '<p>内容正文</p>', assetFilenames: ['image-a.png'], formulaCount: 1, imageCount: 1, preview: 'original-content-preview' },
  ];
  for (const mutate of [
    result => { result.sections.reverse(); },
    result => { result.sections[0].id = 'content'; },
    result => { result.sections[0].fragment = '<p>错栏正文</p>'; },
    result => { result.sections[1].assetFilenames = ['image-b.png']; },
    result => { result.sections[0].kind = 'unassigned'; },
    result => { result.sections = []; },
    result => { result.sections[0].preview = 'regenerated-preview'; },
  ]) {
    const replacement = fixture(NEW_ID); replacement.sections = structuredClone(sections); mutate(replacement);
    const state = harness(async url => url.startsWith('/api/convert?') ? json(replacement) : url.endsWith(OLD_ID) ? expired() : json({ ok: true }));
    const original = state.getCurrent(); original.sections = structuredClone(sections);
    state.recovery.remember(original, state.originalInput, state.params);
    if (replacement.sections[0]?.preview === 'regenerated-preview') {
      assert.equal((await state.recovery.request('export')).status, 200);
      assert.equal(original.jobId, NEW_ID);
    } else {
      await assert.rejects(state.recovery.request('export'), /不一致/);
      assert.equal(original.jobId, OLD_ID);
    }
  }
});

test('only a structured 410 expiry triggers recovery, leaving all other bodies readable', async () => {
  for (const makeResponse of [
    () => json({ error: '本地转换结果已过期，请重新转换。' }, 400),
    () => json({ code: 'JOB_EXPIRED', error: 'Wrong status' }, 400),
    () => json({ code: 'VALIDATION_ERROR', error: 'Bad input' }, 410),
    () => new Response('not JSON', { status: 410 }),
    () => json({ error: '正在转换另一个文档。' }, 409),
    () => json({ ok: true }),
  ]) {
    const response = makeResponse();
    const expected = await response.clone().text();
    let calls = 0;
    const state = harness(async () => { calls++; return response; });
    const returned = await state.recovery.request('import-images');
    assert.equal(returned, response);
    assert.equal(await returned.text(), expected);
    assert.equal(calls, 1);
  }
});

test('a second expiry is returned to the caller after one retry, with no recovery loop', async () => {
  let conversions = 0;
  let requests = 0;
  const state = harness(async url => {
    if (url.startsWith('/api/convert?')) { conversions++; return json(fixture(NEW_ID)); }
    requests++; return expired();
  });
  const response = await state.recovery.request('import-images');
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, 'JOB_EXPIRED');
  assert.equal(conversions, 1);
  assert.equal(requests, 2);
});

test('a failed restoration keeps the old ID and permits a later user action to retry', async () => {
  let conversions = 0;
  const state = harness(async url => {
    if (url.startsWith('/api/convert?')) return ++conversions === 1 ? json({ error: '恢复转换失败' }, 400) : json(fixture(NEW_ID));
    return url.endsWith(OLD_ID) ? expired() : json({ ok: true });
  });
  await assert.rejects(state.recovery.request('import-images'), /恢复转换失败/);
  assert.equal(state.getCurrent().jobId, OLD_ID);
  assert.equal((await state.recovery.request('import-images')).status, 200);
  assert.equal(conversions, 2);
});

test('a changed document rejects successful old-operation responses as well', async () => {
  const pending = deferred();
  const state = harness(async () => pending.promise);
  const request = state.recovery.request('export');
  const rejection = assert.rejects(request, /当前文档已变化/);
  state.setCurrent(fixture(OTHER_ID));
  pending.resolve(json({ fragment: 'stale content' }));
  await rejection;
});

test('unknown routes and cleared recovery state never make requests', async () => {
  let calls = 0;
  const state = harness(async () => { calls++; return json({ ok: true }); });
  await assert.rejects(state.recovery.request('https://school.example.test/upload'), /未知/);
  state.recovery.clear();
  await assert.rejects(state.recovery.request('export'), /当前文档已变化/);
  assert.equal(calls, 0);
});
