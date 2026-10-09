import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import sharp from 'sharp';
import { load } from 'cheerio';
import { createServer, mapExport, mapSectionCopy } from '../src/server.mjs';
import { resolvePandocPath } from '../src/convert.mjs';
import { makeDemoDocx } from '../src/fixtures.mjs';
import { resolveImageScope } from '../src/image-scope.mjs';

let pandocAvailable = true;
try { await promisify(execFile)(await resolvePandocPath(), ['--version']); } catch { pandocAvailable = false; }
const requiresPandoc = { skip: pandocAvailable ? false : 'Install Pandoc for scoped copy HTTP integration tests.' };

function sectionResult() {
  const assets = ['a', 'b'].map(name => ({ filename: `image-${name}.png`, mime: 'image/png', kind: 'image', data: Buffer.from(`synthetic-${name}`) }));
  const image = index => `<img src="data:image/png;base64,${assets[index].data.toString('base64')}" width="80" height="40" style="vertical-align:-2px">`;
  const math = '<math display="inline"><msub><mi>x</mi><mn>1</mn></msub></math>';
  const sections = [
    { id: 'research-purpose', title: '研究目的', kind: 'field', sourceHeading: '研究目的', fragment: `<p style="text-indent:2em">合成目的。${math}</p>`, assetFilenames: [], formulaCount: 1, imageCount: 0 },
    { id: 'research-content', title: '研究内容', kind: 'field', sourceHeading: '研究内容', fragment: `<p style="text-align:center">${math}${image(0)}</p>`, assetFilenames: [assets[0].filename], formulaCount: 1, imageCount: 1 },
    { id: 'schedule', title: '项目研究进度安排', kind: 'field', fragment: `<p>${image(1)}</p>`, assetFilenames: [assets[1].filename], formulaCount: 0, imageCount: 1 },
    { id: 'unassigned-1', title: '参考文献', kind: 'unassigned', fragment: '<p>合成参考条目。</p>', assetFilenames: [], formulaCount: 0, imageCount: 0 },
    { id: 'expected-results', title: '预期成果', kind: 'field', fragment: '<p> \n&nbsp;&#160;</p>', assetFilenames: [], formulaCount: 0, imageCount: 0 },
  ].map(section => ({ ...section, preview: `<!doctype html><html><body>${section.fragment}</body></html>` }));
  const fragment = sections.map(section => section.fragment).join('');
  return { assets, sections, fragment, preview: `<!doctype html><html><body>${fragment}</body></html>`, manifest: { formulas: [{ index: 1 }, { index: 2 }], options: { imageMode: 'embedded' }, warnings: [], verification: 'unverified' } };
}

const urls = { 'image-a.png': 'https://school.example.test/a.png', 'image-b.png': 'https://school.example.test/b.png' };

test('scoped mapped copy preserves the selected field metadata, mathematics, dimensions and original result', () => {
  const result = sectionResult();
  const before = structuredClone(result);
  const selected = result.sections[1];
  const copied = mapSectionCopy(result, selected.id, urls);
  const expected = mapExport(result, 'mapped', urls).sections[1];
  const { preview, ...bodyOnly } = expected;
  assert.deepEqual(copied, bodyOnly);
  const parsed = load(copied.fragment, null, false);
  assert.equal(parsed('img').attr('src'), urls['image-a.png']);
  assert.equal(parsed('img').attr('width'), '80');
  assert.equal(parsed('img').attr('height'), '40');
  assert.equal(parsed('img').attr('style'), 'vertical-align:-2px');
  assert.equal(parsed('p').attr('style'), 'text-align:center');
  assert.equal(parsed('math').length, 1);
  assert.equal(Object.hasOwn(copied, 'preview'), false);
  assert.deepEqual(structuredClone(result), before);
});

test('scoped copy never reads whole-document HTML, other field bodies or any preview', () => {
  const result = sectionResult();
  const failIfRead = () => { throw new Error('Unselected HTML was read'); };
  Object.defineProperty(result, 'fragment', { enumerable: true, get: failIfRead });
  Object.defineProperty(result, 'preview', { enumerable: true, get: failIfRead });
  for (const section of result.sections) {
    Object.defineProperty(section, 'preview', { enumerable: true, get: failIfRead });
    if (section.id !== 'research-purpose') Object.defineProperty(section, 'fragment', { enumerable: true, get: failIfRead });
  }
  const copied = mapSectionCopy(result, 'research-purpose', urls);
  assert.equal(copied.fragment, result.sections[0].fragment);
  assert.equal(Object.hasOwn(copied, 'preview'), false);
});

test('scoped copy validates only its pictures and ignores missing or invalid unrelated mappings', () => {
  const result = sectionResult();
  assert.equal(mapSectionCopy(result, 'research-purpose', {}).fragment, result.sections[0].fragment);
  assert.equal(mapSectionCopy(result, 'research-purpose', { 'image-b.png': 'javascript:alert(1)' }).id, 'research-purpose');
  const partial = { 'image-a.png': urls['image-a.png'] };
  assert.equal(load(mapSectionCopy(result, 'research-content', partial).fragment, null, false)('img').attr('src'), partial['image-a.png']);
  assert.equal(mapSectionCopy(result, 'research-content', { ...partial, 'image-b.png': 'javascript:alert(1)' }).id, 'research-content');
  assert.throws(() => mapSectionCopy(result, 'schedule', partial), /image-b\.png/);
  assert.throws(() => mapSectionCopy(result, 'research-content', {}), /image-a\.png/);
  assert.throws(() => mapSectionCopy(result, 'research-content', { 'image-a.png': 'javascript:alert(1)' }));
  assert.equal(mapSectionCopy(result, 'research-content', {
    'image-a.png': 'https://SCHOOL.EXAMPLE.TEST:443/same.png', 'image-b.png': 'https://school.example.test/same.png',
  }).id, 'research-content');
  result.sections[1].assetFilenames.push('image-b.png');
  assert.throws(() => mapSectionCopy(result, 'research-content', {
    'image-a.png': 'https://SCHOOL.EXAMPLE.TEST:443/same.png', 'image-b.png': 'https://school.example.test/same.png',
  }), /图片地址重复/);
  assert.equal(mapSectionCopy(result, 'research-purpose', urls).id, 'research-purpose');
});

test('trusted scope resolver rejects malformed metadata and allows one shared asset in different fields', () => {
  const result = sectionResult();
  const section = result.sections[1];
  result.sections[2].assetFilenames = [...section.assetFilenames];
  for (const id of [section.id, result.sections[2].id]) assert.deepEqual(resolveImageScope(result, id).assets, [result.assets[0]]);
  assert.deepEqual(resolveImageScope(result).assetFilenames, ['image-a.png', 'image-b.png']);
  assert.deepEqual(resolveImageScope(result, 'whole').assetFilenames, ['image-a.png', 'image-b.png']);
  for (const value of [undefined, null, {}, ['missing.png'], ['image-a.png', 'image-a.png'], [1]]) {
    section.assetFilenames = value;
    assert.throws(() => resolveImageScope(result, section.id), /栏目图片与转换清单不一致/);
  }
  section.assetFilenames = ['image-a.png'];
  result.sections.push({ ...section });
  assert.throws(() => resolveImageScope(result, section.id), /栏目图片与转换清单不一致/);
  result.sections.pop(); result.assets.push({ ...result.assets[0] });
  assert.throws(() => resolveImageScope(result, section.id), /栏目图片与转换清单不一致/);
});

test('scoped copy refuses unknown and empty fields', () => {
  const result = sectionResult();
  for (const id of ['whole-check', 'unknown']) assert.throws(() => mapSectionCopy(result, id, urls), /栏目不存在/);
  for (const id of [undefined, null, 1, [], {}, '']) assert.throws(() => mapSectionCopy(result, id, urls), /复制栏目标识无效/);
  assert.throws(() => mapSectionCopy(result, 'expected-results', urls), /没有正文/);
  result.sections[4].fragment = '<math><mi>x</mi></math>';
  assert.equal(mapSectionCopy(result, 'expected-results', urls).fragment, result.sections[4].fragment);
  result.sections[4].fragment = '<hr>';
  assert.equal(mapSectionCopy(result, 'expected-results', urls).fragment, '<hr>');
});

test('scoped copy rejects a selected image that is absent from the source asset list', () => {
  const result = sectionResult();
  result.sections[1].fragment = '<p><img src="data:image/png;base64,dW5rbm93bg=="></p>';
  assert.throws(() => mapSectionCopy(result, 'research-content', urls), /资产清单不一致/);
});

test('legacy documents without sections support scoped whole-body copy without preview or manifest', () => {
  const result = sectionResult();
  delete result.sections;
  const mapped = mapSectionCopy(result, 'whole', urls);
  assert.equal(mapped.fragment, mapExport(result, 'mapped', urls).fragment);
  assert.deepEqual(mapped.assetFilenames, result.assets.map(asset => asset.filename));
  assert.equal(mapped.formulaCount, 2);
  assert.equal(mapped.imageCount, 2);
  assert.equal(mapped.kind, 'whole');
  assert.equal(Object.hasOwn(mapped, 'preview'), false);
  assert.equal(Object.hasOwn(mapped, 'manifest'), false);
  assert.throws(() => mapSectionCopy(result, 'research-purpose', urls), /栏目不存在/);
  result.fragment = '<p>&nbsp;</p>';
  assert.throws(() => mapSectionCopy(result, 'whole', urls), /没有正文/);
});

test('whole-body copy with fields preserves the original cover, unassigned content, formulas and image dimensions', () => {
  const result = sectionResult();
  result.fragment = `<header>合成封面</header>${result.fragment}<footer>合成签名</footer>`;
  const before = structuredClone(result);
  const whole = mapSectionCopy(result, 'whole', urls);
  assert.equal(whole.fragment, mapExport(result, 'mapped', urls).fragment);
  assert.deepEqual(Object.keys(whole).sort(), ['id', 'title', 'kind', 'assetFilenames', 'formulaCount', 'imageCount', 'fragment'].sort());
  assert.equal(whole.id, 'whole'); assert.equal(whole.kind, 'whole'); assert.equal(whole.title, '整篇文档');
  assert.equal(whole.formulaCount, 2); assert.equal(whole.imageCount, 2);
  assert.deepEqual(whole.assetFilenames, result.assets.map(asset => asset.filename));
  const parsed = load(whole.fragment, null, false);
  assert.equal(parsed('header').text(), '合成封面'); assert.equal(parsed('footer').text(), '合成签名');
  assert.match(parsed.text(), /合成参考条目/);
  assert.equal(parsed('math').length, 2); assert.equal(parsed('img').length, 2);
  parsed('img').each((_, image) => {
    assert.equal(parsed(image).attr('width'), '80'); assert.equal(parsed(image).attr('height'), '40');
    assert.equal(parsed(image).attr('style'), 'vertical-align:-2px');
  });
  assert.deepEqual(structuredClone(result), before);
});

test('whole-body copy never reads previews or reconstructs content from field bodies', () => {
  const result = sectionResult();
  const expected = mapExport(result, 'mapped', urls).fragment;
  const failIfRead = () => { throw new Error('Unneeded preview or field HTML was read'); };
  Object.defineProperty(result, 'preview', { enumerable: true, get: failIfRead });
  for (const section of result.sections) {
    Object.defineProperty(section, 'preview', { enumerable: true, get: failIfRead });
    Object.defineProperty(section, 'fragment', { enumerable: true, get: failIfRead });
  }
  const whole = mapSectionCopy(result, 'whole', urls);
  assert.equal(whole.fragment, expected);
  assert.equal(Object.hasOwn(whole, 'preview'), false); assert.equal(Object.hasOwn(whole, 'manifest'), false);
});

test('whole-body copy validates all image mappings and rejects unknown image sources', () => {
  const result = sectionResult();
  assert.throws(() => mapSectionCopy(result, 'whole', {}), /填写图片地址/);
  assert.throws(() => mapSectionCopy(result, 'whole', { 'image-a.png': urls['image-a.png'] }), /image-b\.png/);
  assert.throws(() => mapSectionCopy(result, 'whole', { ...urls, 'image-b.png': 'javascript:alert(1)' }));
  assert.throws(() => mapSectionCopy(result, 'whole', {
    'image-a.png': 'https://SCHOOL.EXAMPLE.TEST:443/same.png', 'image-b.png': 'https://school.example.test/same.png',
  }), /图片地址重复/);
  result.fragment += '<img src="data:image/png;base64,dW5rbm93bg==">';
  assert.throws(() => mapSectionCopy(result, 'whole', urls), /资产清单不一致/);
});

test('image-free whole-body copy keeps exact HTML and rejects an empty complete document', () => {
  const result = sectionResult(); result.assets = [];
  result.fragment = '<header title="&#x4E2D;">合成封面</header><p>A&#160;B <math><mi>x</mi></math></p>\n';
  assert.equal(mapSectionCopy(result, 'whole').fragment, result.fragment);
  result.fragment = '<p> \n&nbsp;&#160;</p>';
  assert.throws(() => mapSectionCopy(result, 'whole'), /没有正文/);
});

test('mapping image-free HTML preserves its exact original text and MathML serialization', () => {
  const result = sectionResult();
  result.sections[0].fragment = '<p title="&#x4E2D;" style="font-size:14px">A&#160;B <math><mi>x</mi></math></p>\n';
  const expected = result.sections[0].fragment;
  assert.equal(mapSectionCopy(result, 'research-purpose', urls).fragment, expected);
  assert.equal(mapExport(result, 'mapped', urls).sections[0].fragment, expected);
});

test('unassigned mapped copy preserves the full original heading, formatted body, MathML and metadata', () => {
  const result = sectionResult(); const original = result.sections[3];
  original.sourceHeading = '参考文献'; original.formulaCount = 1;
  original.fragment = '<h2 style="font-weight:bold">参考文献</h2><p title="&#x4E2D;" style="font-size:14px">[1] 合成作者。<em>合成题名</em> A&#160;B <math><mi>x</mi></math></p>\n';
  const before = structuredClone(result);
  const copied = mapSectionCopy(result, original.id, urls);
  const { preview, ...expected } = original;
  assert.deepEqual(copied, expected);
  assert.equal(copied.fragment, original.fragment);
  assert.equal(copied.kind, 'unassigned'); assert.equal(copied.title, '参考文献');
  assert.equal(Object.hasOwn(copied, 'preview'), false); assert.equal(Object.hasOwn(copied, 'manifest'), false);
  assert.deepEqual(structuredClone(result), before);
});

test('unassigned body-only copy does not read whole HTML, another section body or any preview', () => {
  const result = sectionResult(); const original = result.sections[3]; const expected = original.fragment;
  const failIfRead = () => { throw new Error('Unselected HTML or preview was read'); };
  Object.defineProperty(result, 'fragment', { enumerable: true, get: failIfRead });
  Object.defineProperty(result, 'preview', { enumerable: true, get: failIfRead });
  for (const section of result.sections) {
    Object.defineProperty(section, 'preview', { enumerable: true, get: failIfRead });
    if (section !== original) Object.defineProperty(section, 'fragment', { enumerable: true, get: failIfRead });
  }
  assert.equal(mapSectionCopy(result, original.id, urls).fragment, expected);
});

test('image-bearing unassigned copy validates its shared image and preserves source dimensions', () => {
  const result = sectionResult(); const original = result.sections[3];
  original.fragment = `<h2>附加材料</h2>${result.sections[1].fragment}`;
  original.assetFilenames = [result.assets[0].filename]; original.formulaCount = 1; original.imageCount = 1;
  assert.throws(() => mapSectionCopy(result, original.id, {}), /填写图片地址/);
  assert.equal(mapSectionCopy(result, original.id, { 'image-a.png': urls['image-a.png'] }).id, original.id);
  assert.equal(mapSectionCopy(result, original.id, { ...urls, 'image-b.png': 'javascript:alert(1)' }).id, original.id);
  assert.equal(mapSectionCopy(result, original.id, {
    'image-a.png': 'https://SCHOOL.EXAMPLE.TEST:443/same.png', 'image-b.png': 'https://school.example.test/same.png',
  }).id, original.id);
  const copied = mapSectionCopy(result, original.id, urls);
  const { preview, ...expected } = mapExport(result, 'mapped', urls).sections[3];
  assert.deepEqual(copied, expected);
  const parsed = load(copied.fragment, null, false);
  assert.equal(parsed('h2').text(), '附加材料'); assert.equal(parsed('math').length, 1);
  assert.equal(parsed('img').attr('src'), urls['image-a.png']);
  assert.equal(parsed('img').attr('width'), '80'); assert.equal(parsed('img').attr('height'), '40');
  assert.equal(parsed('img').attr('style'), 'vertical-align:-2px');
  original.fragment += '<img src="data:image/png;base64,dW5rbm93bg==">';
  assert.throws(() => mapSectionCopy(result, original.id, urls), /资产清单不一致/);
});

test('empty unassigned sources and unsupported registered kinds stay unavailable to scoped copy', () => {
  const result = sectionResult(); const original = result.sections[3];
  original.fragment = '<div> \n&nbsp;&#160;</div>';
  assert.throws(() => mapSectionCopy(result, original.id, urls), /没有正文/);
  result.sections.push({ ...original, id: 'unknown-kind', kind: 'unexpected', fragment: '<p>unsupported content</p>' });
  assert.throws(() => mapSectionCopy(result, 'unknown-kind', urls), /栏目不存在/);
});

async function sectionedDocx() {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const heading = text => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const document = (await zip.file('word/document.xml').async('string'))
    .replace('大创申报转换示例', '研究目的')
    .replace('<w:tbl>', `${heading('研究内容')}<w:tbl>`)
    .replace('<w:sectPr>', `${heading('参考文献')}<w:p><w:r><w:t>合成参考条目。</w:t></w:r></w:p>${heading('预期成果')}<w:sectPr>`);
  zip.file('word/document.xml', document);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function multiImageDocx() {
  const zip = await JSZip.loadAsync(await sectionedDocx());
  const heading = text => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const source = await zip.file('word/document.xml').async('string');
  const imageParagraph = source.match(/<w:p><w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r><\/w:p>/)[0];
  const extra = imageParagraph.replaceAll('rIdImage', 'rIdImage2').replace('wp:docPr id="1"', 'wp:docPr id="2"');
  zip.file('word/document.xml', source.replace(heading('参考文献'), `${heading('项目研究进度安排')}${extra}${heading('参考文献')}`));
  const relations = await zip.file('word/_rels/document.xml.rels').async('string');
  zip.file('word/_rels/document.xml.rels', relations.replace('</Relationships>', '<Relationship Id="rIdImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/demo2.png"/></Relationships>'));
  zip.file('word/media/demo2.png', await sharp(await zip.file('word/media/demo.png').async('nodebuffer')).negate().png().toBuffer());
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('HTTP scoped import, upload and copy allow one imaged field before preparing the rest', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const converted = await fetch(`${base}/api/convert?formulaFormat=mathml`, { method: 'POST', body: await multiImageDocx() });
    assert.equal(converted.status, 200);
    const result = await converted.json();
    assert.equal(result.assets.length, 2);
    const content = result.sections.find(section => section.id === 'research-content');
    const schedule = result.sections.find(section => section.id === 'schedule');
    assert.equal(content.assetFilenames.length, 1); assert.equal(schedule.assetFilenames.length, 1);
    assert.notEqual(content.assetFilenames[0], schedule.assetFilenames[0]);
    const contentAsset = result.assets.find(asset => asset.filename === content.assetFilenames[0]);
    const scheduleAsset = result.assets.find(asset => asset.filename === schedule.assetFilenames[0]);
    assert.match(scheduleAsset.uploadFilename, /^02-/);
    const post = (route, data) => fetch(`${base}/api/${route}/${result.jobId}`, { method: 'POST', body: JSON.stringify(data) });
    const partialUrls = { [contentAsset.filename]: 'https://school.example.test/content.png' };
    const options = sectionId => ({ mode: 'mapped', format: 'json', sectionId, urls: partialUrls });
    assert.equal((await post('export', options('research-content'))).status, 200);
    assert.equal((await post('export', { ...options('research-content'), urls: { ...partialUrls, [scheduleAsset.filename]: 'javascript:alert(1)' } })).status, 200);
    assert.equal((await post('export', options('schedule'))).status, 400);
    assert.equal((await post('export', options('whole'))).status, 400);
    assert.equal((await post('export', { mode: 'mapped', urls: partialUrls })).status, 400);
    assert.equal((await post('export', { ...options('research-purpose'), urls: {} })).status, 200);
    assert.equal((await post('export', { ...options('unassigned-1'), urls: {} })).status, 200);
    const html = `<img src="https://school.example.test/upload/${scheduleAsset.uploadFilename}">`;
    const importedResponse = await post('import-images', { html, sectionId: 'schedule', assetFilenames: [contentAsset.filename] });
    assert.equal(importedResponse.status, 200);
    const imported = await importedResponse.json();
    assert.equal(imported.sectionId, 'schedule');
    assert.deepEqual(imported.assetFilenames, schedule.assetFilenames);
    assert.deepEqual(imported.matches, [{ filename: scheduleAsset.filename, url: `https://school.example.test/upload/${scheduleAsset.uploadFilename}`, method: 'uploadFilename' }]);
    assert.deepEqual(imported.unmatchedAssets, []);
    const allImport = await post('import-images', { html });
    assert.deepEqual((await allImport.json()).unmatchedAssets, [contentAsset.filename]);
    for (const sectionId of ['research-content', 'schedule', 'whole', undefined]) {
      const response = await fetch(`${base}/api/upload-images/${result.jobId}${sectionId === undefined ? '' : `?sectionId=${sectionId}`}`);
      assert.equal(response.status, 200);
      const zip = await JSZip.loadAsync(await response.arrayBuffer(), { checkCRC32: true });
      const expected = sectionId === 'research-content' ? [contentAsset.uploadFilename] : sectionId === 'schedule' ? [scheduleAsset.uploadFilename] : result.assets.map(asset => asset.uploadFilename);
      assert.deepEqual(Object.keys(zip.files).filter(name => name.endsWith('.png')), expected);
      for (const name of expected) assert.ok((await zip.file(name).async('uint8array')).length);
      const instructions = await zip.file('上传顺序.txt').async('string');
      for (const name of expected) assert.ok(instructions.includes(name));
      for (const asset of result.assets.filter(asset => !expected.includes(asset.uploadFilename))) assert.ok(!instructions.includes(asset.uploadFilename));
    }
    const noImages = await fetch(`${base}/api/upload-images/${result.jobId}?sectionId=research-purpose`);
    assert.equal(noImages.status, 400); assert.match((await noImages.json()).error, /不含图片/);
    for (const sectionId of ['', 'unknown', null, [], 1]) {
      assert.equal((await post('import-images', { html, sectionId })).status, 400);
      assert.equal((await post('export', { ...options(sectionId) })).status, 400);
      if (typeof sectionId === 'string') assert.equal((await fetch(`${base}/api/upload-images/${result.jobId}?sectionId=${sectionId}`)).status, 400);
    }
    const complete = { ...partialUrls, [scheduleAsset.filename]: 'https://school.example.test/schedule.png' };
    assert.equal((await post('export', { ...options('whole'), urls: complete })).status, 200);
    assert.equal((await post('export', { mode: 'mapped', urls: complete })).status, 200);
    const duplicate = { [contentAsset.filename]: 'https://SCHOOL.EXAMPLE.TEST:443/same.png', [scheduleAsset.filename]: 'https://school.example.test/same.png' };
    assert.equal((await post('export', { ...options('whole'), urls: duplicate })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('HTTP scoped JSON copies fields and unassigned bodies and preserves full JSON and ZIP export', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const converted = await fetch(`${base}/api/convert?formulaFormat=mathml`, { method: 'POST', body: await sectionedDocx() });
    assert.equal(converted.status, 200);
    const result = await converted.json();
    const mappedUrls = Object.fromEntries(result.assets.map((asset, index) => [asset.filename, `https://school.example.test/scoped-${index}.png`]));
    const post = options => fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify(options) });
    const allResponse = await post({ mode: 'mapped', format: 'json', urls: mappedUrls });
    assert.equal(allResponse.status, 200);
    const all = await allResponse.json();
    assert.deepEqual(Object.keys(all), ['fragment', 'manifest', 'sections']);
    for (const id of ['research-purpose', 'research-content', 'unassigned-1']) {
      const response = await post({ mode: 'mapped', format: 'json', urls: mappedUrls, sectionId: id });
      assert.equal(response.status, 200);
      const scoped = await response.json();
      assert.deepEqual(Object.keys(scoped), ['section']);
      const { preview, ...expected } = all.sections.find(section => section.id === id);
      assert.deepEqual(scoped.section, expected);
      assert.equal(Object.hasOwn(scoped.section, 'preview'), false);
      if (id === 'unassigned-1') {
        assert.equal(scoped.section.kind, 'unassigned'); assert.equal(scoped.section.title, '参考文献');
        const parsed = load(scoped.section.fragment, null, false);
        assert.ok(parsed('h1,h2,h3,h4,h5,h6').toArray().some(heading => parsed(heading).text() === '参考文献'));
        assert.match(scoped.section.fragment, /合成参考条目/);
      }
    }
    const wholeResponse = await post({ mode: 'mapped', format: 'json', urls: mappedUrls, sectionId: 'whole' });
    assert.equal(wholeResponse.status, 200);
    const whole = await wholeResponse.json();
    assert.deepEqual(Object.keys(whole), ['section']);
    assert.equal(whole.section.id, 'whole'); assert.equal(whole.section.kind, 'whole');
    assert.equal(whole.section.fragment, all.fragment);
    assert.deepEqual(whole.section.assetFilenames, result.assets.map(asset => asset.filename));
    assert.equal(whole.section.formulaCount, result.manifest.formulas.length);
    assert.equal(Object.hasOwn(whole.section, 'preview'), false);
    assert.equal(Object.hasOwn(whole.section, 'manifest'), false);
    const zipResponse = await post({ mode: 'mapped', urls: mappedUrls });
    assert.equal(zipResponse.status, 200);
    const archive = await JSZip.loadAsync(await zipResponse.arrayBuffer(), { checkCRC32: true });
    assert.equal(await archive.file('fragment.html').async('string'), all.fragment);
    for (const section of all.sections) {
      assert.equal(await archive.file(`sections/${section.id}.html`).async('string'), section.fragment);
      assert.equal(await archive.file(`sections/${section.id}-preview.html`).async('string'), section.preview);
    }
    for (const sectionId of ['unknown', 'expected-results']) {
      const response = await post({ mode: 'mapped', format: 'json', urls: mappedUrls, sectionId });
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
    const textOnly = await post({ mode: 'mapped', format: 'json', urls: {}, sectionId: 'research-purpose' });
    assert.equal(textOnly.status, 200);
    assert.equal((await textOnly.json()).section.id, 'research-purpose');
    const missing = await post({ mode: 'mapped', format: 'json', urls: {}, sectionId: 'research-content' });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /填写图片地址/);
    for (const options of [
      { mode: 'mapped', urls: mappedUrls, sectionId: 'research-content' },
      { mode: 'embedded', sectionId: 'research-content' },
      { mode: 'mapped', format: 'json', urls: mappedUrls, sectionId: null },
      { mode: 'mapped', format: 'json', urls: mappedUrls, sectionId: [] },
    ]) {
      const response = await post(options);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /栏目复制选项无效/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('HTTP scoped whole copy remains available for legacy demo documents without sections', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const converted = await fetch(`${base}/api/convert?formulaFormat=mathml`, { method: 'POST', body: await makeDemoDocx() });
    assert.equal(converted.status, 200);
    const result = await converted.json();
    assert.deepEqual(result.sections, []);
    const mappedUrls = Object.fromEntries(result.assets.map(asset => [asset.filename, 'https://school.example.test/demo.png']));
    const response = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify({ mode: 'mapped', format: 'json', sectionId: 'whole', urls: mappedUrls }) });
    assert.equal(response.status, 200);
    const scoped = await response.json();
    assert.deepEqual(Object.keys(scoped), ['section']);
    assert.equal(scoped.section.id, 'whole');
    assert.equal(scoped.section.formulaCount, result.manifest.formulas.length);
    assert.equal(Object.hasOwn(scoped.section, 'preview'), false);
    const parsed = load(scoped.section.fragment, null, false);
    assert.equal(parsed('img').attr('src'), mappedUrls[result.assets[0].filename]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
