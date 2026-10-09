import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createWorkProgress, readWorkProgress, fingerprintConversion, validateRestoredProgress } from '../public/work-progress.js';

const encoder = new TextEncoder();
const params = 'documentType=application&fontMode=word&fontSize=14&scale=3&formulaFormat=mathml';
function result() {
  return { jobId: 'old-local-job', fragment: '<p>合成正文</p><img src="data:image/png;base64,c3ludGhldGlj">', preview: '<p>preview</p>',
    assets: [{ filename: 'image-a.png', mime: 'image/png', kind: 'image', width: 160, height: 60, uploadFilename: '图01-image-a.png' }],
    manifest: { options: { documentType: 'application', fontMode: 'word', fontSize: 14, scale: 3, formulaFormat: 'mathml', imageMode: 'embedded' },
      formulas: [{ index: 1, tex: 'x+y', display: true, format: 'mathml' }], warnings: [], verification: 'unverified' },
    sections: [{ id: 'research-purpose', title: '研究目的', kind: 'field', fragment: '<p>合成正文</p>', preview: '<p>local preview</p>',
      assetFilenames: ['image-a.png'], formulaCount: 1, imageCount: 1 }],
  };
}
const snapshot = () => ({ version: 1, urls: { 'image-a.png': 'https://school.test/one.png' },
  sources: [{ sectionId: 'research-purpose', html: '<p><img src="https://school.test/one.png"></p>', pageUrl: 'https://school.test/edit' }],
  orders: [{ sectionId: 'research-purpose', images: [{ index: 1, url: 'https://school.test/one.png' }],
    rows: [{ filename: 'image-a.png', selection: '1', existingUrl: 'https://school.test/one.png', keepUrl: '' }], pendingFilenames: [], confirmed: true }] });
const options = (overrides = {}) => ({ input: encoder.encode('synthetic original Word bytes'), name: '申报书（测试）.docx', params,
  result: result(), mapping: snapshot(), selectedSectionId: 'research-purpose', ...overrides });
async function rewrite(archive, change, zipOptions = {}) {
  const zip = await JSZip.loadAsync(archive);
  const metadata = JSON.parse(await zip.file('progress.json').async('string'));
  change(metadata, zip);
  zip.file('progress.json', JSON.stringify(metadata));
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE', ...zipOptions });
}
const clone = value => structuredClone(value);
function offsets(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  const central = view.getUint32(end + 16, true);
  const nextCentral = central + 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  return { view, end, central, nextCentral };
}

test('complete progress roundtrips original Word, Unicode name, settings, selection and mapping without cached HTML', async () => {
  const original = options();
  const encoded = await createWorkProgress(original);
  const zip = await JSZip.loadAsync(encoded, { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), ['progress.json', 'source.docx']);
  const saved = await readWorkProgress(new Blob([encoded]));
  assert.deepEqual(saved.source, original.input);
  assert.equal(saved.progress.format, 'campus-work-progress');
  assert.equal(saved.progress.version, 1);
  assert.equal(saved.progress.sourceName, original.name);
  assert.equal(saved.progress.params, params);
  assert.equal(saved.progress.selectedSectionId, 'research-purpose');
  assert.deepEqual(saved.progress.mapping, original.mapping);
  assert.match(saved.progress.sourceSha256, /^[a-f\d]{64}$/);
  assert.match(saved.progress.conversionSha256, /^[a-f\d]{64}$/);
  assert.notEqual(saved.progress.sourceSha256, saved.progress.conversionSha256);
  assert.equal(Object.hasOwn(saved.progress, 'fragment'), false);
  assert.equal(Object.hasOwn(saved.progress, 'jobId'), false);
  await validateRestoredProgress(saved.progress, result());
});

test('partial text and pending confirmation survive without promotion or URL requests', async () => {
  const mapping = snapshot(); mapping.urls['image-a.png'] = '地址尚未填完';
  mapping.orders[0].confirmed = false;
  mapping.orders[0].pendingFilenames = ['image-a.png'];
  mapping.orders[0].rows[0].selection = '';
  const saved = await readWorkProgress(await createWorkProgress(options({ mapping, selectedSectionId: 'whole' })));
  assert.deepEqual(saved.progress.mapping, mapping);
  assert.equal(saved.progress.selectedSectionId, 'whole');
});

test('source supports ArrayBuffer, typed-array subviews and Blob without including outside bytes', async () => {
  const surrounded = encoder.encode('outside SOURCE outside');
  const input = surrounded.subarray(8, 14);
  for (const source of [input, input.slice().buffer, new Blob([input])]) {
    const read = await readWorkProgress(await createWorkProgress(options({ input: source })));
    assert.equal(new TextDecoder().decode(read.source), 'SOURCE');
  }
});

test('save captures caller-owned source, mapping, parameters and conversion before asynchronous hashing', async () => {
  const original = options(); original.params = new URLSearchParams(params);
  const initialHash = await fingerprintConversion(original.result);
  const saving = createWorkProgress(original);
  original.input[0] ^= 0xff;
  original.mapping.urls['image-a.png'] = 'changed later';
  original.params.set('fontSize', '20');
  original.result.fragment += '<p>changed later</p>';
  const read = await readWorkProgress(await saving);
  assert.equal(new TextDecoder().decode(read.source), 'synthetic original Word bytes');
  assert.equal(read.progress.mapping.urls['image-a.png'], 'https://school.test/one.png');
  assert.equal(read.progress.params, params);
  assert.equal(read.progress.conversionSha256, initialHash);
});

test('fingerprint excludes job IDs, preview and diagnostic verification but includes converted identity fields', async () => {
  const original = result(); const hash = await fingerprintConversion(original);
  const transient = clone(original); transient.jobId = 'new-local-job'; transient.preview = '<p>new preview</p>';
  transient.sections[0].preview = '<p>other preview</p>'; transient.manifest.verification = 'changed'; transient.manifest.warnings = ['later warning'];
  assert.equal(await fingerprintConversion(transient), hash);
  for (const mutate of [value => { value.fragment += '<p>changed</p>'; }, value => { value.assets[0].width++; },
    value => { value.manifest.formulas[0].tex = 'x-y'; }, value => { value.manifest.options.fontSize = 16; },
    value => { value.sections[0].assetFilenames = []; }, value => { value.sections[0].fragment += 'changed'; }]) {
    const changed = clone(original); mutate(changed); assert.notEqual(await fingerprintConversion(changed), hash);
  }
});

test('fingerprint object key order is stable and array order stays significant', async () => {
  const original = result();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.manifest = Object.fromEntries(Object.entries(original.manifest).reverse());
  assert.equal(await fingerprintConversion(reordered), await fingerprintConversion(original));
  const second = clone(original.assets[0]); second.filename = 'image-b.png'; original.assets.push(second);
  const reversed = clone(original); reversed.assets.reverse();
  assert.notEqual(await fingerprintConversion(reversed), await fingerprintConversion(original));
});

test('restoration rejects changed conversion, unknown selection and contradictory settings', async () => {
  const { progress } = await readWorkProgress(await createWorkProgress(options()));
  const changed = result(); changed.fragment += 'different';
  await assert.rejects(validateRestoredProgress(progress, changed), /不一致/);
  await assert.rejects(validateRestoredProgress({ ...progress, selectedSectionId: 'missing' }, result()), /栏目/);
  await assert.rejects(validateRestoredProgress({ ...progress, params: params.replace('fontSize=14', 'fontSize=16') }, result()), /设置/);
  const wrongImageMode = result(); wrongImageMode.manifest.options.imageMode = 'mapped';
  const encoded = await createWorkProgress(options({ result: wrongImageMode }));
  const read = await readWorkProgress(encoded);
  await assert.rejects(validateRestoredProgress(read.progress, wrongImageMode), /设置|嵌入/);
});

test('source tampering is caught by source SHA even when ZIP CRC was recomputed', async () => {
  const encoded = await createWorkProgress(options());
  const modified = await rewrite(encoded, (_, zip) => zip.file('source.docx', encoder.encode('other original Word')));
  await assert.rejects(readWorkProgress(modified), /原 Word.*不一致|原 Word.*校验/);
});

test('metadata rejects unsupported format/version, unknown keys, invalid hashes and unsafe source names', async () => {
  const encoded = await createWorkProgress(options());
  for (const mutate of [p => { p.version = 2; }, p => { p.format = 'other-tool'; }, p => { p.extra = 'unexpected'; },
    p => { p.sourceSha256 = 'bad'; }, p => { p.conversionSha256 = 'bad'; }, p => { p.sourceName = '../word.docx'; },
    p => { p.sourceName = 'bad\u0000.docx'; }, p => { p.mapping = []; }, p => { p.selectedSectionId = ''; }]) {
    await assert.rejects(readWorkProgress(await rewrite(encoded, mutate)), /进度|版本|文件名|校验|栏目/);
  }
});

test('metadata rejects prototype-dangerous keys at any depth', async () => {
  const encoded = await createWorkProgress(options());
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const changed = await rewrite(encoded, p => { p.mapping.sources.push(JSON.parse(`{"${key}":{"polluted":true}}`)); });
    await assert.rejects(readWorkProgress(changed), /进度.*无效|进度.*危险/);
  }
});

test('metadata rejects unknown, missing, duplicate or unrepresentable conversion query settings', async () => {
  const encoded = await createWorkProgress(options());
  for (const query of [params + '&extra=1', params + '&fontSize=14', params.replace('&scale=3', ''),
    params.replace('fontSize=14', 'fontSize=12'), params.replace('formulaFormat=mathml', 'formulaFormat=svg'),
    params.replace('documentType=application', 'documentType=unknown'), params.replace('fontMode=word', 'fontMode=other')]) {
    await assert.rejects(readWorkProgress(await rewrite(encoded, p => { p.params = query; })), /设置/);
  }
});

test('local PNG settings remain representable in a progress file', async () => {
  const local = result(); local.manifest.options.formulaFormat = 'png';
  const read = await readWorkProgress(await createWorkProgress(options({ params: params.replace('mathml', 'png'), result: local })));
  assert.match(read.progress.params, /formulaFormat=png/);
  await validateRestoredProgress(read.progress, local);
});

test('empty, oversized source, oversized archive and oversized JSON fail before content decoding', async () => {
  await assert.rejects(createWorkProgress(options({ input: new Uint8Array() })), /Word.*空|Word.*无效/);
  await assert.rejects(createWorkProgress(options({ input: new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]) })), /20/);
  await assert.rejects(readWorkProgress(new Blob([new Uint8Array(38 * 1024 * 1024 + 1)])), /38/);
  await assert.rejects(createWorkProgress(options({ mapping: { version: 1, text: 'x'.repeat(16 * 1024 * 1024) } })), /16/);
});

test('truncated, encrypted, compressed, multipart and ZIP64 archives are rejected', async () => {
  const encoded = await createWorkProgress(options());
  await assert.rejects(readWorkProgress(encoded.subarray(0, encoded.length - 1)), /进度.*结构|进度.*损坏/);
  const compressed = await rewrite(encoded, () => {}, { compression: 'DEFLATE' });
  await assert.rejects(readWorkProgress(compressed), /STORE|压缩|进度.*结构/);
  for (const mutate of [({ view, central }) => { view.setUint16(central + 8, 1, true); },
    ({ view, end }) => { view.setUint16(end + 4, 1, true); }, ({ view, end }) => { view.setUint16(end + 10, 0xffff, true); },
    ({ view, end }) => { view.setUint32(end + 16, 0xffffffff, true); }]) {
    const changed = encoded.slice(); mutate(offsets(changed));
    await assert.rejects(readWorkProgress(changed), /进度.*结构|进度.*损坏|ZIP64|多卷|密码/);
  }
});

test('CRC, local/central disagreement, overlap and unsafe paths are rejected', async () => {
  const encoded = await createWorkProgress(options());
  const mutations = [
    ({ view, central }) => { view.setUint32(central + 16, 0, true); },
    ({ view, central }) => { view.setUint32(central + 24, view.getUint32(central + 24, true) + 1, true); },
    ({ view }) => { view.setUint16(6, 1, true); },
    ({ view }) => { view.setUint32(18, 999, true); },
    ({ view, nextCentral }) => { view.setUint32(nextCentral + 42, 0, true); },
    ({ view, central }) => { view.setUint8(central + 46, '/'.charCodeAt(0)); },
  ];
  for (const mutate of mutations) {
    const changed = encoded.slice(); mutate(offsets(changed));
    await assert.rejects(readWorkProgress(changed), /进度.*结构|进度.*损坏|校验|CRC/);
  }
});

test('extra or replaced entries are rejected without extracting arbitrary paths', async () => {
  const encoded = await createWorkProgress(options());
  await assert.rejects(readWorkProgress(await rewrite(encoded, (_, zip) => zip.file('extra.txt', 'extra'))), /进度.*结构|条目/);
  await assert.rejects(readWorkProgress(await rewrite(encoded, (_, zip) => { zip.remove('source.docx'); zip.file('other.docx', 'wrong'); })), /进度.*结构|条目/);
});

test('duplicate fixed paths and archives with hidden leading or trailing data are rejected', async () => {
  const encoded = await createWorkProgress(options());
  const duplicate = new JSZip(); duplicate.file('source.docx', 'one'); duplicate.file('sourcf.docx', 'two');
  const dupe = await duplicate.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const target = encoder.encode('sourcf.docx');
  for (let offset = 0; offset <= dupe.length - target.length; offset++) {
    if (target.every((byte, index) => byte === dupe[offset + index])) dupe[offset + 5] = 'e'.charCodeAt(0);
  }
  await assert.rejects(readWorkProgress(dupe), /进度.*结构/);
  const trailing = new Uint8Array(encoded.length + 1); trailing.set(encoded);
  await assert.rejects(readWorkProgress(trailing), /进度.*结构/);
  const leading = new Uint8Array(encoded.length + 1); leading.set(encoded, 1);
  const view = new DataView(leading.buffer); const end = leading.length - 22;
  const central = view.getUint32(end + 16, true) + 1; view.setUint32(end + 16, central, true);
  const second = central + 46 + view.getUint16(central + 28, true);
  for (const entry of [central, second]) view.setUint32(entry + 42, view.getUint32(entry + 42, true) + 1, true);
  await assert.rejects(readWorkProgress(leading), /进度.*结构/);
});

test('invalid UTF-8 and invalid JSON fail as metadata errors', async () => {
  const encoded = await createWorkProgress(options());
  const zip = await JSZip.loadAsync(encoded);
  for (const bytes of [new Uint8Array([0xc3, 0x28]), encoder.encode('{ invalid json')]) {
    zip.file('progress.json', bytes);
    await assert.rejects(readWorkProgress(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })), /进度.*无效|进度.*损坏/);
  }
});

test('excessive metadata nesting and cyclic export data fail clearly', async () => {
  const encoded = await createWorkProgress(options());
  const deep = {}; let cursor = deep;
  for (let i = 0; i < 40; i++) { cursor.next = {}; cursor = cursor.next; }
  await assert.rejects(readWorkProgress(await rewrite(encoded, p => { p.mapping.deep = deep; })), /进度.*无效|进度.*复杂/);
  const cyclic = snapshot(); cyclic.circular = cyclic;
  await assert.rejects(createWorkProgress(options({ mapping: cyclic })), /进度.*无效|进度.*复杂/);
});
