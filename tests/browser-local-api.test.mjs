import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createBrowserApi } from '../browser/local-api.js';
import { compareFragments as browserCompare } from '../browser/compare.js';
import { compareFragments as originalCompare } from '../src/probe.mjs';
import { load } from '../browser/html.js';

const pixels = Uint8Array.of(1, 2, 3, 4);
const dataUrl = 'data:image/png;base64,AQIDBA==';
const math = '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>−</mo><mn>1</mn></mrow><annotation encoding="application/x-tex">x-1</annotation></semantics></math>';
const fragment = `<p>合成正文 ${math}<img src="${dataUrl}" width="64" height="32" alt="合成图片"></p>`;
function fixture() {
  return {
    fragment, preview: `<!DOCTYPE html><html><body>${fragment}</body></html>`,
    manifest: { formulas: [{ tex: 'x-1' }], warnings: [], options: { fontMode: 'uniform', fontSize: 16, formulaFormat: 'mathml', imageMode: 'embedded' } },
    assets: [{ filename: 'image-1.png', mime: 'image/png', kind: 'image', width: 64, height: 32, data: pixels }],
    sections: [{ id: 'progress', title: '项目进展', kind: 'field', fragment, preview: `<html><body>${fragment}</body></html>`, assetFilenames: ['image-1.png'], formulaCount: 1, imageCount: 1 }],
  };
}

function scopedFixture() {
  const assets = ['a', 'b', 'c'].map((letter, offset) => ({ filename: `image-${letter}.png`, mime: 'image/png', kind: 'image', width: 64, height: 32, data: Uint8Array.of(offset + 1, 2, 3, 4) }));
  const image = index => `<img src="data:image/png;base64,${btoa(String.fromCharCode(...assets[index].data))}" width="64" height="32">`;
  const sections = [
    { id: 'first-field', title: '合成栏目一', kind: 'field', fragment: `<p>${image(0)}${image(1)}${math}</p>`, assetFilenames: ['image-a.png', 'image-b.png'], formulaCount: 1, imageCount: 2 },
    { id: 'second-field', title: '合成栏目二', kind: 'field', fragment: `<p>${image(2)}</p>`, assetFilenames: ['image-c.png'], formulaCount: 0, imageCount: 1 },
    { id: 'text-field', title: '合成文字栏目', kind: 'field', fragment: `<p>仅有文字 ${math}</p>`, assetFilenames: [], formulaCount: 1, imageCount: 0 },
    { id: 'unassigned-1', title: '合成附图', kind: 'unassigned', fragment: `<p>共享图片 ${image(0)}</p>`, assetFilenames: ['image-a.png'], formulaCount: 0, imageCount: 1 },
  ].map(section => ({ ...section, preview: `<!doctype html><html><body>${section.fragment}</body></html>` }));
  const fragment = sections.map(section => section.fragment).join('\n');
  return { assets, sections, fragment, preview: `<!doctype html><html><body>${fragment}</body></html>`, manifest: { formulas: [{}, {}], warnings: [], options: { formulaFormat: 'mathml', imageMode: 'embedded' } } };
}
const post = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
async function start(api) {
  const response = await api.request('/api/convert?formulaFormat=mathml', { method: 'POST', body: new Blob([Uint8Array.of(9)]) });
  assert.equal(response.status, 200);
  return response.json();
}

test('local conversion accepts File-compatible input and keeps options, images and job metadata in memory', async () => {
  let received;
  const progress = [];
  const api = createBrowserApi({ convert: async (input, options) => { received = { input, options }; return fixture(); }, onProgress: event => progress.push(event) });
  try {
    const response = await api.request('/api/convert?fontMode=word&fontSize=14&scale=4&formulaFormat=mathml', { method: 'POST', body: new Blob([Uint8Array.of(7, 8)]) });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual([...received.input], [7, 8]);
    assert.deepEqual(received.options, { documentType: 'application', fontMode: 'word', fontSize: 14, scale: 4, formulaFormat: 'mathml' });
    assert.match(result.jobId, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
    assert.equal(result.assets[0].uploadFilename, '01-image-1.png');
    assert.equal(result.assets[0].previewUrl, api.assetUrl(result.jobId, 'image-1.png'));
    assert.match(result.assets[0].previewUrl, /^blob:/);
    const asset = await api.request(`/api/assets/${result.jobId}/image-1.png`);
    assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [...pixels]);
    assert.deepEqual(progress.map(event => event.percent), [0, 100]);
    assert.equal(progress[0].stage, 'convert');
  } finally { api.dispose(); }
});

test('conversion forwards application and progress form choices and rejects unknown forms before reading the document', async () => {
  const received = [];
  const api = createBrowserApi({ convert: async (_input, options) => {
    received.push(options.documentType);
    const result = fixture();
    result.manifest.options.documentType = options.documentType;
    return result;
  } });
  try {
    for (const [query, expected] of [['', 'application'], ['?documentType=application', 'application'], ['?documentType=progress', 'progress']]) {
      const response = await api.request(`/api/convert${query}`, { method: 'POST', body: pixels });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).manifest.options.documentType, expected);
    }
    let bodyReads = 0;
    for (const value of ['unknown', '', 'Progress']) {
      const input = new Request(`http://browser.local/api/convert?documentType=${value}`, { method: 'POST', body: pixels });
      input.arrayBuffer = async () => { bodyReads++; throw new Error('Document should not be read'); };
      const response = await api.request(input);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /学校表单/);
    }
    assert.equal(bodyReads, 0);
    assert.deepEqual(received, ['application', 'application', 'progress']);
  } finally { api.dispose(); }
});

test('concurrent conversions are rejected and validation runs before conversion', async () => {
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const api = createBrowserApi({ convert: async () => { calls++; return pending; } });
  try {
    assert.equal((await api.request('/api/convert?formulaFormat=png', { method: 'POST', body: pixels })).status, 400);
    assert.equal((await api.request('/api/convert?fontSize=15', { method: 'POST', body: pixels })).status, 400);
    assert.equal((await api.request('/api/convert', { method: 'POST', body: new Uint8Array() })).status, 400);
    assert.equal((await api.request('/api/convert', { method: 'POST', headers: { 'Content-Length': String(21 * 1024 * 1024) }, body: pixels })).status, 400);
    assert.equal(calls, 0);
    const first = api.request('/api/convert', { method: 'POST', body: pixels });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await api.request('/api/convert', { method: 'POST', body: pixels })).status, 409);
    release(fixture());
    assert.equal((await first).status, 200);
    assert.equal(calls, 1);
  } finally { release(fixture()); api.dispose(); }
});

test('mapped section copy preserves local previews, math characters, annotations and image dimensions', async () => {
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const result = await start(api);
    const response = await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', format: 'json', sectionId: 'progress', urls: { 'image-1.png': 'https://school.example/upload/image-1.png' } }));
    const { section } = await response.json();
    assert.equal(response.status, 200);
    assert.equal(section.id, 'progress');
    assert.equal(section.preview, undefined);
    assert.match(section.fragment, /https:\/\/school\.example\/upload\/image-1\.png/);
    const $ = load(section.fragment, null, false);
    assert.equal($('img').attr('width'), '64');
    assert.equal($('img').attr('height'), '32');
    assert.equal($('mo').text(), '−');
    assert.equal($('annotation').text(), 'x-1');
    assert.equal(result.preview, fixture().preview);
    assert.equal((await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', format: 'json', sectionId: 'missing', urls: { 'image-1.png': 'https://school.example/image.png' } }))).status, 400);
    assert.equal((await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', format: 'json', sectionId: 'progress', urls: {} }))).status, 400);
  } finally { api.dispose(); }
});

test('scoped browser copy permits independent field progress and still requires every image for whole exports', async () => {
  const api = createBrowserApi({ convert: async () => scopedFixture() });
  try {
    const result = await start(api);
    const urls = { 'image-a.png': 'https://school.example/a.png', 'image-b.png': 'https://school.example/b.png' };
    const request = options => api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', format: 'json', ...options }));
    const copied = await request({ sectionId: 'first-field', urls: { ...urls, 'image-c.png': 'javascript:alert(1)' } });
    assert.equal(copied.status, 200);
    const section = (await copied.json()).section;
    assert.deepEqual(section.assetFilenames, ['image-a.png', 'image-b.png']);
    assert.equal(load(section.fragment, null, false)('img').length, 2);
    assert.equal(load(section.fragment, null, false)('annotation').text(), 'x-1');
    assert.equal((await request({ sectionId: 'second-field', urls })).status, 400);
    for (const sectionId of ['whole', undefined]) assert.equal((await request({ sectionId, urls })).status, 400);
    assert.equal((await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', urls }))).status, 400);
    assert.equal((await request({ sectionId: 'text-field', urls: {} })).status, 200);
    assert.equal((await request({ sectionId: 'unassigned-1', urls: { 'image-a.png': urls['image-a.png'] } })).status, 200);
    for (const invalidUrls of [
      { 'image-a.png': urls['image-a.png'] },
      { ...urls, 'image-b.png': 'javascript:alert(1)' },
      { 'image-a.png': 'https://SCHOOL.EXAMPLE:443/same.png', 'image-b.png': 'https://school.example/same.png' },
    ]) assert.equal((await request({ sectionId: 'first-field', urls: invalidUrls })).status, 400);
    for (const sectionId of ['', 'missing', null, 1, []]) assert.equal((await request({ sectionId, urls })).status, 400);
    const complete = { ...urls, 'image-c.png': 'https://school.example/c.png' };
    assert.equal((await request({ sectionId: 'whole', urls: complete })).status, 200);
    assert.equal((await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', urls: complete }))).status, 200);
  } finally { api.dispose(); }
});

test('scoped browser import and image ZIP use only trusted field images and retain document-wide upload numbers', async () => {
  const original = scopedFixture();
  const api = createBrowserApi({ convert: async () => original });
  try {
    const result = await start(api);
    const html = '<img src="https://school.example/upload/03-image-c.png">';
    const importedResponse = await api.request(`/api/import-images/${result.jobId}`, post({ html, sectionId: 'second-field', assetFilenames: ['image-a.png'] }));
    assert.equal(importedResponse.status, 200);
    const imported = await importedResponse.json();
    assert.equal(imported.sectionId, 'second-field');
    assert.deepEqual(imported.assetFilenames, ['image-c.png']);
    assert.deepEqual(imported.matches, [{ filename: 'image-c.png', url: 'https://school.example/upload/03-image-c.png', method: 'uploadFilename' }]);
    assert.deepEqual(imported.unmatchedAssets, []);
    for (const sectionId of ['first-field', 'second-field', 'unassigned-1', 'whole', undefined]) {
      const suffix = sectionId === undefined ? '' : `?sectionId=${sectionId}`;
      const response = await api.request(`/api/upload-images/${result.jobId}${suffix}`);
      assert.equal(response.status, 200);
      const zip = await JSZip.loadAsync(await response.arrayBuffer(), { checkCRC32: true });
      const names = Object.keys(zip.files).filter(name => name.endsWith('.png'));
      const indexes = sectionId === 'first-field' ? [0, 1] : sectionId === 'second-field' ? [2] : sectionId === 'unassigned-1' ? [0] : [0, 1, 2];
      const expected = indexes.map(index => result.assets[index].uploadFilename);
      assert.deepEqual(names, expected);
      for (const index of indexes) assert.deepEqual([...await zip.file(result.assets[index].uploadFilename).async('uint8array')], [...original.assets[index].data]);
      const instructions = await zip.file('上传顺序.txt').async('string');
      for (const name of expected) assert.ok(instructions.includes(name));
      for (const asset of result.assets.filter(asset => !expected.includes(asset.uploadFilename))) assert.ok(!instructions.includes(asset.uploadFilename));
    }
    const allImport = await api.request(`/api/import-images/${result.jobId}`, post({ html }));
    assert.deepEqual((await allImport.json()).unmatchedAssets, ['image-a.png', 'image-b.png']);
    for (const value of ['', 'unknown', null, 42, []]) {
      assert.equal((await api.request(`/api/import-images/${result.jobId}`, post({ html, sectionId: value }))).status, 400);
      if (typeof value === 'string') assert.equal((await api.request(`/api/upload-images/${result.jobId}?sectionId=${value}`)).status, 400);
    }
    const noImages = await api.request(`/api/upload-images/${result.jobId}?sectionId=text-field`);
    assert.equal(noImages.status, 400);
    assert.match((await noImages.json()).error, /不含图片/);
  } finally { api.dispose(); }
});

test('browser scoped routes reject corrupt trusted asset lists instead of silently ignoring them', async () => {
  for (const assetFilenames of [undefined, null, ['missing.png'], ['image-a.png', 'image-a.png'], [1]]) {
    const original = scopedFixture(); original.sections[0].assetFilenames = assetFilenames;
    const api = createBrowserApi({ convert: async () => original });
    try {
      const result = await start(api);
      const urls = { 'image-a.png': 'https://school.example/a.png', 'image-b.png': 'https://school.example/b.png' };
      for (const response of [
        await api.request(`/api/import-images/${result.jobId}`, post({ html: '<img src="https://school.example/a.png">', sectionId: 'first-field' })),
        await api.request(`/api/upload-images/${result.jobId}?sectionId=first-field`),
        await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', format: 'json', sectionId: 'first-field', urls })),
      ]) {
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /栏目图片与转换清单不一致/);
      }
    } finally { api.dispose(); }
  }
});

test('ZIP exports include original assets, complete HTML and independently indexed section bodies', async () => {
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const result = await start(api);
    for (const mode of ['embedded', 'mapped']) {
      const response = await api.request(`/api/export/${result.jobId}`, post({ mode, urls: { 'image-1.png': 'https://school.example/image.png' } }));
      assert.equal(response.status, 200);
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      for (const name of ['fragment.html', 'preview.html', 'manifest.json', 'assets/image-1.png', 'sections/progress.html', 'sections/progress-preview.html', 'sections/index.json', '使用说明.txt']) assert.ok(zip.file(name), name);
      assert.deepEqual([...await zip.file('assets/image-1.png').async('uint8array')], [...pixels]);
      const index = JSON.parse(await zip.file('sections/index.json').async('string'));
      assert.equal(index[0].fragmentFile, 'sections/progress.html');
      assert.equal(index[0].destination, '学校“项目进展”编辑框');
      const source = await zip.file('fragment.html').async('string');
      assert.ok(source.includes(mode === 'mapped' ? 'https://school.example/image.png' : dataUrl));
      const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
      assert.equal(manifest.options.imageMode, mode);
    }
    const upload = await api.request(`/api/upload-images/${result.jobId}`);
    const zip = await JSZip.loadAsync(await upload.arrayBuffer());
    assert.deepEqual([...await zip.file('01-image-1.png').async('uint8array')], [...pixels]);
    assert.match(await zip.file('上传顺序.txt').async('string'), /01-image-1\.png/);
  } finally { api.dispose(); }
});

test('mapped ZIP keeps CSP-compatible embedded images in previews and school URLs only in copyable bodies', async () => {
  const original = fixture();
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'">';
  original.preview = original.preview.replace('<html>', `<html><head>${csp}</head>`);
  original.sections[0].preview = original.sections[0].preview.replace('<html>', `<html><head>${csp}</head>`);
  const schoolUrl = 'https://school.example/mapped-image.png';
  const api = createBrowserApi({ convert: async () => original });
  try {
    const result = await start(api);
    const response = await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', urls: { 'image-1.png': schoolUrl } }));
    assert.equal(response.status, 200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    for (const [filename, expected] of [['preview.html', original.preview], ['sections/progress-preview.html', original.sections[0].preview]]) {
      const html = await zip.file(filename).async('string');
      assert.equal(html, expected, 'preview source and its CSP must remain unchanged');
      assert.ok(html.includes(dataUrl));
      assert.ok(!html.includes(schoolUrl));
      const $ = load(html);
      assert.equal($('img').attr('src'), dataUrl);
      assert.equal($('math')[0].namespace, 'http://www.w3.org/1998/Math/MathML');
      assert.equal($('mo').text(), '−');
      assert.equal($('annotation').text(), 'x-1');
    }
    for (const filename of ['fragment.html', 'sections/progress.html']) {
      const html = await zip.file(filename).async('string');
      assert.ok(html.includes(schoolUrl));
      assert.ok(!html.includes(dataUrl));
      const $ = load(html, null, false);
      assert.equal($('math')[0].namespace, 'http://www.w3.org/1998/Math/MathML');
      assert.equal($('math').attr('xmlns'), 'http://www.w3.org/1998/Math/MathML');
      assert.equal($('img').attr('width'), '64');
      assert.equal($('img').attr('height'), '32');
      assert.equal($('annotation').text(), 'x-1');
    }
    assert.match(await zip.file('使用说明.txt').async('string'), /预览继续使用本地嵌入原图，不请求学校图片地址/);
  } finally { api.dispose(); }
});

test('image address import and export inspect pasted text without requesting school URLs', async () => {
  const savedFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('Unexpected network request'); };
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const result = await start(api);
    const response = await api.request(`/api/import-images/${result.jobId}`, post({ html: '<script>fetch("https://school.example")</script><img src="/upload/01-image-1.png">', pageUrl: 'https://school.example/edit' }));
    const imported = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(imported.matches, [{ filename: 'image-1.png', url: 'https://school.example/upload/01-image-1.png', method: 'uploadFilename' }]);
    const exported = await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', urls: { 'image-1.png': imported.matches[0].url } }));
    assert.equal(exported.status, 200);
    assert.equal(fetchCalls, 0);
    assert.equal((await api.request('https://school.example/api/probe')).status, 400);
    assert.equal((await api.request(`/api/export/${result.jobId}`, post({ mode: 'mapped', urls: { 'image-1.png': 'javascript:alert(1)' } }))).status, 400);
    assert.equal(fetchCalls, 0);
  } finally { api.dispose(); globalThis.fetch = savedFetch; }
});

test('comparison keeps original MathML namespace semantics and detects token or annotation changes', async () => {
  const before = `<p>文 ${math}</p><img src="https://school.example/p.png" width="64" height="32">`;
  const changed = before.replace('<mo>−</mo>', '<mo>?</mo>').replace('>x-1</annotation>', '>x+1</annotation>');
  assert.deepEqual(browserCompare(before, changed), originalCompare(before, changed));
  const comparison = browserCompare(before, changed);
  assert.equal(comparison.mathPreserved, false);
  assert.equal(comparison.mathChanges[0].tokensPreserved, false);
  assert.equal(comparison.mathChanges[0].annotationPreserved, false);
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const report = await api.request('/api/compare', post({ before, after: changed }));
    assert.equal(report.status, 200);
    assert.equal((await report.json()).mathChanges[0].tokenChanges[0].before.codePoints[0], 'U+2212');
    const probe = await (await api.request('/api/probe')).json();
    assert.match(probe.fragment, /<math/);
    assert.doesNotMatch(probe.fragment, /<img|data:image|PNG-BASELINE/);
    assert.equal(browserCompare(probe.fragment, probe.fragment).mathPreserved, true);
  } finally { api.dispose(); }
});

test('jobs retain at most three documents and clearJobs revokes every asset URL', async () => {
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const results = [];
    for (let index = 0; index < 4; index++) results.push(await start(api));
    const expired = await api.request(`/api/assets/${results[0].jobId}/image-1.png`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, 'JOB_EXPIRED');
    assert.throws(() => api.assetUrl(results[0].jobId, 'image-1.png'), /过期/);
    const finalUrl = results.at(-1).assets[0].previewUrl;
    api.clearJobs();
    assert.equal((await api.request(`/api/export/${results.at(-1).jobId}`, post({ mode: 'embedded' }))).status, 410);
    await assert.rejects(fetch(finalUrl));
  } finally { api.dispose(); }
});

test('restore candidates preserve the active old job across four conversions while retaining the three-job limit', async () => {
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const original = await start(api);
    const originalUrl = api.assetUrl(original.jobId, 'image-1.png');
    const candidates = [];
    for (let index = 0; index < 4; index++) {
      const response = await api.request('/api/convert?formulaFormat=mathml', {
        method: 'POST', body: pixels, preserveJobId: original.jobId,
      });
      assert.equal(response.status, 200);
      candidates.push(await response.json());
      assert.equal(api.assetUrl(original.jobId, 'image-1.png'), originalUrl);
      assert.equal((await api.request(`/api/assets/${original.jobId}/image-1.png`)).status, 200);
      assert.deepEqual([...new Uint8Array(await (await fetch(originalUrl)).arrayBuffer())], [...pixels]);
    }
    for (const candidate of candidates.slice(0, 2)) {
      assert.equal((await api.request(`/api/assets/${candidate.jobId}/image-1.png`)).status, 410);
      await assert.rejects(fetch(candidate.assets[0].previewUrl));
    }
    for (const candidate of candidates.slice(2)) assert.equal((await api.request(`/api/assets/${candidate.jobId}/image-1.png`)).status, 200);
    // Preservation applies to a single conversion, rather than pinning a job.
    await start(api);
    assert.equal((await api.request(`/api/assets/${original.jobId}/image-1.png`)).status, 410);
    await assert.rejects(fetch(originalUrl));
  } finally { api.dispose(); }
});

test('invalid or nonexistent preserve IDs and URL query options do not change FIFO eviction', async () => {
  for (const invalid of [undefined, null, '', 123, {}, ['a'], '00000000-0000-0000-0000-000000000000']) {
    const api = createBrowserApi({ convert: async () => fixture() });
    try {
      const original = await start(api);
      await start(api); await start(api);
      const response = await api.request(`/api/convert?formulaFormat=mathml&preserveJobId=${original.jobId}`, {
        method: 'POST', body: pixels, preserveJobId: invalid,
      });
      assert.equal(response.status, 200);
      assert.equal((await api.request(`/api/assets/${original.jobId}/image-1.png`)).status, 410);
      await assert.rejects(fetch(original.assets[0].previewUrl));
    } finally { api.dispose(); }
  }
});

test('preserving a job never renews its existing expiry time', async () => {
  const savedNow = Date.now;
  const initialTime = savedNow();
  let elapsed = 0;
  Date.now = () => initialTime + elapsed;
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const original = await start(api);
    elapsed = 29 * 60 * 1000;
    const preserved = await api.request('/api/convert?formulaFormat=mathml', { method: 'POST', body: pixels, preserveJobId: original.jobId });
    assert.equal(preserved.status, 200);
    const candidate = await preserved.json();
    assert.equal(api.assetUrl(original.jobId, 'image-1.png'), original.assets[0].previewUrl);
    elapsed = 30 * 60 * 1000;
    assert.equal((await api.request(`/api/assets/${original.jobId}/image-1.png`)).status, 410);
    assert.equal((await api.request(`/api/assets/${candidate.jobId}/image-1.png`)).status, 200);
    await assert.rejects(fetch(original.assets[0].previewUrl));
  } finally { Date.now = savedNow; api.dispose(); }
});

test('synthetic demo performs only one cached static GET; external demo sources are rejected', async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(Uint8Array.of(5, 6)); };
  const api = createBrowserApi({ convert: async () => fixture(), demoUrl: '/demo.docx' });
  const badApi = createBrowserApi({ convert: async () => fixture(), demoUrl: 'https://external.example/demo.docx' });
  try {
    const one = await api.request('/api/demo-docx');
    const two = await api.request('/api/demo-docx');
    assert.deepEqual([...new Uint8Array(await one.arrayBuffer())], [5, 6]);
    assert.deepEqual([...new Uint8Array(await two.arrayBuffer())], [5, 6]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://browser.local/demo.docx');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal((await badApi.request('/api/demo-docx')).status, 400);
    assert.equal(calls.length, 1);
  } finally { api.dispose(); badApi.dispose(); globalThis.fetch = savedFetch; }
});

test('application and progress examples have separate same-origin caches and never fall back to the wrong form', async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(url.endsWith('/progress-demo.docx') ? Uint8Array.of(2) : Uint8Array.of(1));
  };
  const api = createBrowserApi({ convert: async () => fixture(), demoUrl: '/demo.docx', progressDemoUrl: '/progress-demo.docx' });
  const missing = createBrowserApi({ convert: async () => fixture(), demoUrl: '/demo.docx' });
  const external = createBrowserApi({ convert: async () => fixture(), demoUrl: '/demo.docx', progressDemoUrl: 'https://other.example/progress.docx' });
  try {
    for (const [query, expected] of [['', 1], ['?documentType=progress', 2], ['?documentType=application', 1], ['?documentType=progress', 2]]) {
      const response = await api.request(`/api/demo-docx${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [expected]);
      assert.match(response.headers.get('Content-Disposition'), expected === 2 ? /progress-demo.docx/ : /"demo.docx"/);
    }
    assert.deepEqual(calls.map(call => call.url), ['http://browser.local/demo.docx', 'http://browser.local/progress-demo.docx']);
    assert.ok(calls.every(call => call.options.method === 'GET' && call.options.credentials === 'omit' && call.options.redirect === 'error'));
    const absent = await missing.request('/api/demo-docx?documentType=progress');
    assert.equal(absent.status, 400);
    assert.match((await absent.json()).error, /进展检查合成示例未配置/);
    assert.equal((await external.request('/api/demo-docx?documentType=progress')).status, 400);
    assert.equal((await api.request('/api/demo-docx?documentType=unknown')).status, 400);
    assert.equal(calls.length, 2);
  } finally { api.dispose(); missing.dispose(); external.dispose(); globalThis.fetch = savedFetch; }
});

test('Request objects, size-limited JSON, aborts and XML source index options are supported', async () => {
  const api = createBrowserApi({ convert: async () => fixture() });
  try {
    const input = new Request('http://browser.local/api/convert', { method: 'POST', body: pixels });
    assert.equal((await api.request(input)).status, 200);
    assert.equal((await api.request('/api/compare', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await api.request('/api/compare', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 400);
    const signal = AbortSignal.abort();
    await assert.rejects(api.request('/api/probe', { signal }), { name: 'AbortError' });
    const xml = '<w:p><w:r>文本</w:r></w:p>';
    const $ = load(xml, { xmlMode: true, withStartIndices: true, withEndIndices: true });
    assert.equal($('w\\:r')[0].startIndex, 5);
    assert.equal($('w\\:r')[0].endIndex, xml.indexOf('</w:r>') + 5);
    assert.equal(load($.html($('w\\:r')[0]), { xmlMode: true })('w\\:r').text(), '文本');
  } finally { api.dispose(); }
});
