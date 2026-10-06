import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { load } from 'cheerio';
import sharp from 'sharp';
import { createServer, mapExport } from '../src/server.mjs';
import { resolvePandocPath } from '../src/convert.mjs';
import { makeDemoDocx } from '../src/fixtures.mjs';

let pandocAvailable = true;
try { await promisify(execFile)(await resolvePandocPath(), ['--version']); } catch { pandocAvailable = false; }
const requiresPandoc = { skip: pandocAvailable ? false : 'Install Pandoc or set PANDOC_PATH for the MathML HTTP integration test.' };

async function twoImageDocx() {
  const docx = await JSZip.loadAsync(await makeDemoDocx());
  const original = await docx.file('word/media/demo.png').async('nodebuffer');
  const second = await sharp(original).tint('#e08020').png().toBuffer();
  const document = await docx.file('word/document.xml').async('string');
  const imageRun = document.match(/<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/)[0];
  const secondRun = imageRun.replace('rIdImage', 'rIdImage2').replace('id="1"', 'id="2"').replace('demo.png', 'demo-second.png');
  docx.file('word/document.xml', document.replace(imageRun, `${imageRun}</w:p><w:p>${secondRun}`));
  const relationships = await docx.file('word/_rels/document.xml.rels').async('string');
  docx.file('word/_rels/document.xml.rels', relationships.replace('</Relationships>', '<Relationship Id="rIdImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/demo-second.png"/></Relationships>'));
  docx.file('word/media/demo-second.png', second);
  return { docx: await docx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), images: [original, second] };
}

async function sectionedDocx() {
  const docx = await JSZip.loadAsync(await makeDemoDocx());
  const heading = (text, level = 1) => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  let document = await docx.file('word/document.xml').async('string');
  document = document.replace('大创申报转换示例', '研究目的')
    .replace('<w:tbl>', `${heading('研究目的', 2)}<w:p><w:r><w:t>同名内层标题的合成正文。</w:t></w:r></w:p>${heading('研究内容')}<w:tbl>`)
    .replace('<w:sectPr>', `${heading('参考文献')}<w:p><w:r><w:t>合成参考条目。</w:t></w:r></w:p><w:sectPr>`);
  docx.file('word/document.xml', document);
  const styles = await docx.file('word/styles.xml').async('string');
  docx.file('word/styles.xml', styles.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>'));
  return docx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('URL export keeps formula dimensions and requires complete safe mappings', () => {
  const data = Buffer.from('synthetic-asset');
  const image = `<img src="data:image/png;base64,${data.toString('base64')}" width="20" height="10" style="vertical-align:-2px">`;
  const result = { fragment: `<p>${image}</p>`, preview: `<!doctype html><html><body>${image}</body></html>`, assets: [{ filename: 'formula.png', mime: 'image/png', data }], manifest: { options: { imageMode: 'embedded' }, warnings: [], verification: 'unverified' } };
  assert.throws(() => mapExport(result, 'mapped', {}), /填写图片地址/);
  assert.throws(() => mapExport(result, 'mapped', { 'formula.png': 'javascript:alert(1)' }));
  const mapped = mapExport(result, 'mapped', { 'formula.png': 'https://school.example/uploads/formula.png' });
  assert.match(mapped.fragment, /src="https:\/\/school.example\/uploads\/formula.png"/);
  assert.match(mapped.fragment, /vertical-align:-2px/);
  assert.equal(mapped.manifest.options.imageMode, 'mapped');
  assert.equal(mapped.manifest.verification, 'unverified');
  assert.ok(!JSON.stringify(mapped.manifest).includes('school.example'));
});

function twoAssetExportResult() {
  const assets = ['a', 'b'].map(name => ({ filename: `image-${name}.png`, mime: 'image/png', kind: 'image', data: Buffer.from(`synthetic-image-${name}`) }));
  const images = assets.map(asset => `<img src="data:${asset.mime};base64,${asset.data.toString('base64')}" width="20" height="10">`).join('');
  const fragment = `<p><math><mi>x</mi></math>${images}</p>`;
  return { fragment, preview: `<!doctype html><html><body>${fragment}</body></html>`, assets, manifest: { options: { imageMode: 'embedded' }, warnings: [], verification: 'unverified' } };
}

test('mapped export rejects two distinct source images assigned the same uploaded URL', () => {
  const result = twoAssetExportResult();
  const urls = { 'image-a.png': 'https://school.example.test/uploads/same.png', 'image-b.png': 'https://school.example.test/uploads/same.png' };
  assert.throws(() => mapExport(result, 'mapped', urls), /图片地址重复：image-a\.png 与 image-b\.png/);
  assert.equal(mapExport(result, 'embedded', urls).fragment, result.fragment);
});

test('mapped export detects duplicate URLs after normalizing host case and default ports', () => {
  const result = twoAssetExportResult();
  for (const [first, second] of [
    ['https://SCHOOL.EXAMPLE.TEST/uploads/same.png', 'https://school.example.test/uploads/same.png'],
    ['https://school.example.test:443/uploads/same.png', 'https://school.example.test/uploads/same.png'],
    ['http://SCHOOL.EXAMPLE.TEST:80/uploads/same.png', 'http://school.example.test/uploads/same.png'],
  ]) {
    assert.throws(() => mapExport(result, 'mapped', { 'image-a.png': first, 'image-b.png': second }), /图片地址重复/);
  }
});

test('mapped export accepts distinct normalized URLs without changing image positions or mathematics', () => {
  const result = twoAssetExportResult();
  const urls = { 'image-a.png': 'https://SCHOOL.EXAMPLE.TEST:443/uploads/a.png', 'image-b.png': 'https://school.example.test/uploads/b.png' };
  const mapped = mapExport(result, 'mapped', urls);
  const before = load(result.fragment, null, false);
  const after = load(mapped.fragment, null, false);
  const preview = load(mapped.preview);
  assert.deepEqual(after('img').toArray().map(image => after(image).attr('src')), ['https://school.example.test/uploads/a.png', 'https://school.example.test/uploads/b.png']);
  assert.deepEqual(after('img').toArray().map(image => [after(image).attr('width'), after(image).attr('height')]), [['20', '10'], ['20', '10']]);
  assert.deepEqual(after('math').toArray().map(math => after.html(math)), before('math').toArray().map(math => before.html(math)));
  assert.deepEqual(preview('img').toArray().map(image => preview(image).attr('src')), after('img').toArray().map(image => after(image).attr('src')));
  assert.equal(mapped.manifest.options.imageMode, 'mapped');
  assert.equal(mapped.manifest.verification, 'unverified');
  assert.equal(result.manifest.options.imageMode, 'embedded');
});

test('mapped export rewrites each section and its preview while preserving section metadata and source data', () => {
  const result = twoAssetExportResult();
  const original = load(result.fragment, null, false);
  const fragments = [
    `<p style="text-indent:2em"><math><mi>x</mi></math>${original.html(original('img').eq(0))}</p>`,
    `<p style="text-align:center">${original.html(original('img').eq(1))}</p>`,
    '<p>合成参考条目。</p>',
  ];
  result.sections = fragments.map((fragment, index) => ({
    id: ['purpose', 'research-content', 'unassigned-1'][index],
    title: ['研究目的', '研究内容', '参考文献'][index], kind: index === 2 ? 'unassigned' : 'field',
    sourceHeading: ['研究目的', '研究内容', '参考文献'][index], fragment,
    preview: `<!doctype html><html><body>${fragment}</body></html>`,
    assetFilenames: index < 2 ? [result.assets[index].filename] : [], formulaCount: index === 0 ? 1 : 0, imageCount: index < 2 ? 1 : 0,
  }));
  const unchanged = structuredClone(result.sections);
  const urls = { 'image-a.png': 'https://school.example.test/sections/a.png', 'image-b.png': 'https://school.example.test/sections/b.png' };
  const embedded = mapExport(result, 'embedded');
  assert.equal(embedded.sections, result.sections);
  const mapped = mapExport(result, 'mapped', urls);
  assert.equal(mapped.sections.length, 3);
  for (const [index, section] of mapped.sections.entries()) {
    const { fragment, preview, ...metadata } = section;
    const { fragment: originalFragment, preview: originalPreview, ...originalMetadata } = unchanged[index];
    assert.deepEqual(metadata, originalMetadata);
    const after = load(fragment, null, false);
    const before = load(originalFragment, null, false);
    assert.deepEqual(after('math').toArray().map(node => after.html(node)), before('math').toArray().map(node => before.html(node)));
    assert.deepEqual(after('p').toArray().map(node => after(node).attr('style')), before('p').toArray().map(node => before(node).attr('style')));
    assert.deepEqual(after('img').toArray().map(node => after(node).attr('src')), section.assetFilenames.map(filename => urls[filename]));
    const rendered = load(preview);
    assert.deepEqual(rendered('img').toArray().map(node => rendered(node).attr('src')), section.assetFilenames.map(filename => urls[filename]));
    assert.equal(load(originalPreview)('img').length, rendered('img').length);
  }
  assert.deepEqual(result.sections, unchanged);
  assert.doesNotMatch(JSON.stringify(mapped.manifest), /school\.example|合成参考/);
});

test('mapped section exports require image consistency in both fragment and preview and support legacy results', () => {
  const result = twoAssetExportResult();
  const urls = { 'image-a.png': 'https://school.example.test/a.png', 'image-b.png': 'https://school.example.test/b.png' };
  assert.deepEqual(mapExport(result, 'embedded').sections, []);
  assert.deepEqual(mapExport(result, 'mapped', urls).sections, []);
  result.sections = [{ id: 'purpose', title: '研究目的', kind: 'field', fragment: '<p>合成正文。</p>' }];
  assert.equal(Object.hasOwn(mapExport(result, 'mapped', urls).sections[0], 'preview'), false);
  result.sections[0].fragment = '<p><img src="data:image/png;base64,dW5rbm93bg=="></p>';
  assert.throws(() => mapExport(result, 'mapped', urls), /资产清单不一致/);
  result.sections[0].fragment = '<p>合成正文。</p>';
  result.sections[0].preview = '<!doctype html><html><body><img src="https://external.example.test/unknown.png"></body></html>';
  assert.throws(() => mapExport(result, 'mapped', urls), /资产清单不一致/);
});

test('local HTTP API refuses foreign origins, forged host and malformed payloads', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/api/compare`, { method: 'POST', headers: { Origin: 'https://external.example' }, body: '{}' })).status, 403);
    const forgedStatus = await new Promise((resolve, reject) => {
      const request = http.get(base, { headers: { Host: 'external.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(forgedStatus, 403);
    assert.equal((await fetch(`${base}/api/compare`, { method: 'POST', body: 'invalid JSON' })).status, 400);
    const unknownId = '00000000-0000-0000-0000-000000000000';
    for (const [route, method] of [['import-images', 'POST'], ['upload-images', 'GET']]) {
      const missing = await fetch(`${base}/api/${route}/${unknownId}`, { method, ...(method === 'POST' ? { body: '{"html":"<p>test</p>"}' } : {}) });
      assert.equal(missing.status, 410);
      const unavailable = await missing.json();
      assert.equal(unavailable.code, 'JOB_EXPIRED');
      assert.match(unavailable.error, /本地转换结果已过期/);
    }
    const before = '<p style="font-size:16px">文本</p>';
    const compared = await fetch(`${base}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ before, after: '<p>文本</p>' }) });
    assert.equal(compared.status, 200);
    assert.equal((await compared.json()).verification, 'source-compared-only');
    const empty = await fetch(`${base}/api/convert`, { method: 'POST', body: '' });
    assert.equal(empty.status, 400);
    const invalidFormat = await fetch(`${base}/api/convert?formulaFormat=script`, { method: 'POST', body: 'nonempty' });
    assert.equal(invalidFormat.status, 400);
    assert.match((await invalidFormat.json()).error, /mathml.*png/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('conversion API rejects invalid font modes before reading or converting the document', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const fontMode of ['unknown', 'WORD', '', '14']) {
      const params = new URLSearchParams({ fontMode, fontSize: 'invalid', formulaFormat: 'script' });
      const response = await fetch(`${base}/api/convert?${params}`, { method: 'POST', body: '' });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /字号模式.*word.*uniform/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('conversion API passes Word font mode and keeps uniform as its compatible default', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const docx = await makeDemoDocx();
    for (const [fontMode, expectedMode, expectedMathSize] of [['word', 'word', '16px'], [undefined, 'uniform', '14px']]) {
      const params = new URLSearchParams({ formulaFormat: 'mathml', fontSize: '14' });
      if (fontMode) params.set('fontMode', fontMode);
      const response = await fetch(`${base}/api/convert?${params}`, { method: 'POST', body: docx });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.manifest.options.fontMode, expectedMode);
      assert.equal(result.manifest.options.fontSize, 14);
      assert.equal(result.manifest.verification, 'unverified');
      const html = load(result.fragment, null, false);
      assert.equal(html('math').length, 2);
      for (const math of html('math').toArray()) assert.match(math.attribs.style, new RegExp(`(?:^|;)font-size:${expectedMathSize}(?:;|$)`));
      assert.equal(result.assets.length, 1);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('MathML API exports native equations and maps only the ordinary Word image', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const converted = await fetch(`${base}/api/convert?formulaFormat=mathml&fontSize=14`, { method: 'POST', body: await makeDemoDocx() });
    assert.equal(converted.status, 200);
    const result = await converted.json();
    const before = load(result.fragment, null, false);
    assert.equal(result.manifest.options.formulaFormat, 'mathml');
    assert.equal(result.manifest.verification, 'unverified');
    assert.equal(before('math').length, 2);
    assert.equal(before('math annotation').length, 2);
    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0].kind, 'image');
    assert.equal(result.assets[0].uploadFilename, `01-${result.assets[0].filename}`);
    assert.ok(!Object.hasOwn(result.manifest.assets[0], 'uploadFilename'));
    const urls = { [result.assets[0].filename]: 'https://school.example.test/synthetic.png' };
    const exported = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify({ mode: 'mapped', urls }) });
    assert.equal(exported.status, 200);
    const zip = await JSZip.loadAsync(await exported.arrayBuffer(), { checkCRC32: true });
    const fragment = await zip.file('fragment.html').async('string');
    const after = load(fragment, null, false);
    assert.equal(after('img').attr('src'), urls[result.assets[0].filename]);
    assert.deepEqual(after('math').toArray().map(el => after.html(el)), before('math').toArray().map(el => before.html(el)));
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(manifest.options.formulaFormat, 'mathml');
    assert.equal(manifest.options.imageMode, 'mapped');
    assert.doesNotMatch(JSON.stringify(manifest), /school\.example/);
    assert.match(await zip.file('使用说明.txt').async('string'), /原生 MathML/);
    assert.equal(Object.values(zip.files).filter(item => !item.dir && item.name.startsWith('assets/')).length, 1);

    const docx = await JSZip.loadAsync(await makeDemoDocx());
    const body = await docx.file('word/document.xml').async('string');
    docx.file('word/document.xml', body.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, ''));
    const noImageResponse = await fetch(`${base}/api/convert?formulaFormat=mathml&fontSize=14`, { method: 'POST', body: await docx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) });
    assert.equal(noImageResponse.status, 200);
    const noImages = await noImageResponse.json();
    assert.equal(noImages.assets.length, 0);
    const unnecessaryUpload = await fetch(`${base}/api/upload-images/${noImages.jobId}`);
    assert.equal(unnecessaryUpload.status, 400);
    assert.match((await unnecessaryUpload.json()).error, /无需上传/);
    assert.equal(load(noImages.fragment)('math').length, 2);
    const nativeExport = await fetch(`${base}/api/export/${noImages.jobId}`, { method: 'POST', body: JSON.stringify({ mode: 'embedded' }) });
    const nativeZip = await JSZip.loadAsync(await nativeExport.arrayBuffer(), { checkCRC32: true });
    assert.equal(await nativeZip.file('fragment.html').async('string'), noImages.fragment);
    const usage = await nativeZip.file('使用说明.txt').async('string');
    assert.match(usage, /本包不含图片/);
    assert.match(usage, /尚未完成学校保存回读/);
    assert.doesNotMatch(usage, /行内公式对齐尚未解决/);
    assert.ok(!Object.keys(nativeZip.files).some(name => name.startsWith('assets/')));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('conversion, mapped JSON and archives keep confirmed field bodies separate from unassigned content', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const converted = await fetch(`${base}/api/convert?formulaFormat=mathml&fontMode=word&fontSize=14`, { method: 'POST', body: await sectionedDocx() });
    assert.equal(converted.status, 200);
    const result = await converted.json();
    assert.deepEqual(result.sections.map(({ title, kind }) => [title, kind]), [['研究目的', 'field'], ['研究内容', 'field'], ['参考文献', 'unassigned']]);
    const [purpose, content, references] = result.sections;
    const purposeHtml = load(purpose.fragment, null, false);
    assert.equal(purposeHtml('h1').length, 0);
    assert.equal(purposeHtml('h2').text(), '研究目的');
    assert.match(purposeHtml.text(), /同名内层标题的合成正文/);
    assert.equal(purpose.formulaCount, 2);
    assert.equal(purpose.imageCount, 0);
    assert.deepEqual(purpose.assetFilenames, []);
    assert.equal(content.formulaCount, 0);
    assert.equal(content.imageCount, 1);
    assert.deepEqual(content.assetFilenames, [result.assets[0].filename]);
    assert.match(load(references.fragment).text(), /合成参考条目/);
    assert.doesNotMatch(purpose.fragment + content.fragment, /合成参考条目/);
    const whole = load(result.fragment, null, false);
    assert.deepEqual(result.sections.flatMap(section => {
      const parsed = load(section.fragment, null, false);
      return parsed('math').toArray().map(node => parsed.html(node));
    }), whole('math').toArray().map(node => whole.html(node)));

    const exportOptions = async options => {
      const response = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify(options) });
      assert.equal(response.status, 200);
      return response;
    };
    const embedded = await JSZip.loadAsync(await (await exportOptions({ mode: 'embedded' })).arrayBuffer(), { checkCRC32: true });
    assert.equal(await embedded.file('fragment.html').async('string'), result.fragment);
    assert.equal(await embedded.file('preview.html').async('string'), result.preview);
    assert.deepEqual(JSON.parse(await embedded.file('manifest.json').async('string')), result.manifest);
    const index = JSON.parse(await embedded.file('sections/index.json').async('string'));
    assert.equal(index.length, 3);
    assert.deepEqual(index.map(({ id, title, kind }) => [id, title, kind]), result.sections.map(({ id, title, kind }) => [id, title, kind]));
    assert.match(index[2].destination, /待确认归属/);
    assert.doesNotMatch(JSON.stringify(index), /合成参考条目|同名内层标题的合成正文|data:image|<!doctype/i);
    for (const [position, section] of result.sections.entries()) {
      assert.equal(await embedded.file(`sections/${section.id}.html`).async('string'), section.fragment);
      assert.equal(await embedded.file(`sections/${section.id}-preview.html`).async('string'), section.preview);
      assert.equal(index[position].fragmentFile, `sections/${section.id}.html`);
      assert.equal(index[position].previewFile, `sections/${section.id}-preview.html`);
    }
    const embeddedUsage = await embedded.file('使用说明.txt').async('string');
    assert.match(embeddedUsage, /分别复制到对应学校编辑框/);
    assert.match(embeddedUsage, /蓝色栏目名称由学校自动显示/);
    assert.match(embeddedUsage, /不要将.*整篇内容粘贴到单个栏目/);

    const urls = { [result.assets[0].filename]: 'https://school.example.test/section-image.png' };
    const mappedJson = await (await exportOptions({ mode: 'mapped', format: 'json', urls })).json();
    const mappedZip = await JSZip.loadAsync(await (await exportOptions({ mode: 'mapped', urls })).arrayBuffer(), { checkCRC32: true });
    assert.equal(mappedJson.sections.length, 3);
    assert.doesNotMatch(JSON.stringify(mappedJson.manifest), /school\.example|section-image/);
    const mappedIndex = JSON.parse(await mappedZip.file('sections/index.json').async('string'));
    assert.deepEqual(mappedIndex, index);
    for (const [position, section] of mappedJson.sections.entries()) {
      assert.equal(section.id, result.sections[position].id);
      assert.equal(await mappedZip.file(`sections/${section.id}.html`).async('string'), section.fragment);
      assert.equal(await mappedZip.file(`sections/${section.id}-preview.html`).async('string'), section.preview);
      const after = load(section.fragment, null, false);
      const before = load(result.sections[position].fragment, null, false);
      assert.deepEqual(after('math').toArray().map(node => after.html(node)), before('math').toArray().map(node => before.html(node)));
      assert.equal(after('img').length, before('img').length);
      for (const image of after('img').toArray()) assert.equal(after(image).attr('src'), urls[result.assets[0].filename]);
    }
    const sourceImage = await fetch(`${base}/api/assets/${result.jobId}/${result.assets[0].filename}`);
    assert.deepEqual(await mappedZip.file(`assets/${result.assets[0].filename}`).async('nodebuffer'), Buffer.from(await sourceImage.arrayBuffer()));
    assert.equal(await mappedZip.file('fragment.html').async('string'), mappedJson.fragment);
    assert.match(await mappedZip.file('使用说明.txt').async('string'), /已替换图片地址/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('image import API resolves uploaded names, offers order candidates without exporting them, and packages only image bytes', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fixture = await twoImageDocx();
    const converted = await fetch(`${base}/api/convert?formulaFormat=mathml&fontSize=14`, { method: 'POST', body: fixture.docx });
    assert.equal(converted.status, 200);
    const result = await converted.json();
    assert.equal(result.assets.length, 2);
    assert.deepEqual(result.assets.map((asset, index) => asset.uploadFilename), result.assets.map((asset, index) => `${String(index + 1).padStart(2, '0')}-${asset.filename}`));
    const route = `${base}/api/import-images/${result.jobId}`;
    const importHtml = async (html, pageUrl) => {
      const response = await fetch(route, { method: 'POST', body: JSON.stringify({ html, ...(pageUrl === undefined ? {} : { pageUrl }) }) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const [first, second] = result.assets;
    const exact = await importHtml(`<img src="https://school.example.test/uploads/${first.filename}?v=1"><img src="/uploads/${second.uploadFilename}">`, 'https://school.example.test/System/Edit');
    assert.equal(exact.detectedCount, 2);
    assert.deepEqual(exact.matches, [
      { filename: first.filename, url: `https://school.example.test/uploads/${first.filename}?v=1`, method: 'filename' },
      { filename: second.filename, url: `https://school.example.test/uploads/${second.uploadFilename}`, method: 'uploadFilename' },
    ]);
    assert.deepEqual(exact.unmatchedAssets, []);
    assert.equal(exact.orderReady, false);
    const opaque = await importHtml('<img src="https://school.example.test/uploads/a.png"><img src="https://school.example.test/uploads/b.png">');
    assert.equal(opaque.orderReady, true);
    assert.deepEqual(opaque.matches, []);
    assert.deepEqual(opaque.orderCandidates, [
      { filename: first.filename, url: 'https://school.example.test/uploads/a.png', index: 1 },
      { filename: second.filename, url: 'https://school.example.test/uploads/b.png', index: 2 },
    ]);
    const notMapped = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify({ mode: 'mapped', urls: {} }) });
    assert.equal(notMapped.status, 400);
    assert.match((await notMapped.json()).error, /填写图片地址/);
    const unsafe = await importHtml(`<img src="javascript:alert(1)"><img src="https://school.example.test/uploads/${second.uploadFilename}">`);
    assert.equal(unsafe.matches.length, 1);
    assert.equal(unsafe.matches[0].filename, second.filename);
    assert.equal(unsafe.orderReady, false);
    assert.match(unsafe.warnings.join('\n'), /不安全/);
    assert.ok(!JSON.stringify(unsafe.matches).includes('javascript'));

    const upload = await fetch(`${base}/api/upload-images/${result.jobId}`);
    assert.equal(upload.status, 200);
    assert.equal(upload.headers.get('Content-Type'), 'application/zip');
    const imagesZip = await JSZip.loadAsync(await upload.arrayBuffer(), { checkCRC32: true });
    assert.deepEqual(Object.keys(imagesZip.files), [first.uploadFilename, second.uploadFilename, '上传顺序.txt']);
    for (const [index, asset] of result.assets.entries()) {
      const zipped = await imagesZip.file(asset.uploadFilename).async('nodebuffer');
      const served = await fetch(`${base}/api/assets/${result.jobId}/${asset.filename}`);
      assert.deepEqual(zipped, Buffer.from(await served.arrayBuffer()));
      assert.deepEqual(zipped, fixture.images[index]);
    }
    const instructions = await imagesZip.file('上传顺序.txt').async('string');
    assert.match(instructions, /按文件名开头的编号逐张/);
    assert.match(instructions, /排列顺序仍需检查/);
    assert.doesNotMatch(instructions, /这是一份合成测试文档/);
    assert.ok(!Object.keys(imagesZip.files).some(name => /\.html$|\.json$|\.docx$/i.test(name)));

    const unchanged = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: '{"mode":"embedded"}' });
    const unchangedZip = await JSZip.loadAsync(await unchanged.arrayBuffer(), { checkCRC32: true });
    assert.equal(await unchangedZip.file('fragment.html').async('string'), result.fragment);
    assert.deepEqual(JSON.parse(await unchangedZip.file('manifest.json').async('string')), result.manifest);
    assert.doesNotMatch(await unchangedZip.file('manifest.json').async('string'), /school\.example/);
    assert.match(await unchangedZip.file('使用说明.txt').async('string'), /一次复制学校编辑器.*HTML 源码/);
    const urls = Object.fromEntries(exact.matches.map(({ filename, url }) => [filename, url]));
    const mapped = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify({ mode: 'mapped', urls }) });
    const mappedZip = await JSZip.loadAsync(await mapped.arrayBuffer(), { checkCRC32: true });
    const after = load(await mappedZip.file('fragment.html').async('string'), null, false);
    const before = load(result.fragment, null, false);
    assert.deepEqual(after('math').toArray().map(el => after.html(el)), before('math').toArray().map(el => before.html(el)));
    const mappedManifest = JSON.parse(await mappedZip.file('manifest.json').async('string'));
    assert.deepEqual(mappedManifest.formulas, result.manifest.formulas);
    assert.deepEqual(mappedManifest.assets, result.manifest.assets);
    assert.equal(mappedManifest.verification, 'unverified');
    const jsonResponse = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify({ mode: 'mapped', format: 'json', urls }) });
    assert.equal(jsonResponse.status, 200);
    assert.equal(jsonResponse.headers.get('Content-Type'), 'application/json; charset=utf-8');
    const jsonExport = await jsonResponse.json();
    assert.deepEqual(Object.keys(jsonExport), ['fragment', 'manifest', 'sections']);
    assert.deepEqual(jsonExport.sections, []);
    assert.equal(Object.hasOwn(jsonExport, 'preview'), false);
    assert.equal(jsonExport.fragment, await mappedZip.file('fragment.html').async('string'));
    const jsonMath = load(jsonExport.fragment, null, false);
    assert.deepEqual(jsonMath('math').toArray().map(el => jsonMath.html(el)), before('math').toArray().map(el => before.html(el)));
    assert.deepEqual(jsonMath('img').toArray().map(el => jsonMath(el).attr('src')), result.assets.map(({ filename }) => urls[filename]));
    assert.deepEqual(jsonExport.manifest.formulas, result.manifest.formulas);
    assert.equal(jsonExport.manifest.verification, 'unverified');
    assert.doesNotMatch(JSON.stringify(jsonExport.manifest), /school\.example/);
    for (const invalidOptions of [{ mode: 'mapped', format: 'unknown', urls }, { mode: 'embedded', format: 'json' }, { mode: 'mapped', format: null, urls }]) {
      const invalidFormat = await fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify(invalidOptions) });
      assert.equal(invalidFormat.status, 400);
      assert.match((await invalidFormat.json()).error, /图片导出格式无效/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('image import API rejects malformed payloads, oversized HTML and foreign origins', requiresPandoc, async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const converted = await fetch(`${base}/api/convert?formulaFormat=mathml`, { method: 'POST', body: await makeDemoDocx() });
    assert.equal(converted.status, 200);
    const { jobId } = await converted.json();
    const route = `${base}/api/import-images/${jobId}`;
    for (const payload of ['invalid JSON', 'null', '[]', '{}', '{"html":[]}', '{"html":"<img>","pageUrl":null}', '{"html":"<img>","pageUrl":[]}', '{"html":"<img>","pageUrl":"javascript:alert(1)"}']) {
      const response = await fetch(route, { method: 'POST', body: payload });
      assert.equal(response.status, 400);
      const { error } = await response.json();
      assert.match(error, /源码|地址/);
      assert.doesNotMatch(error, /Cannot read|TypeError/);
    }
    const overHtml = await fetch(route, { method: 'POST', body: JSON.stringify({ html: 'a'.repeat(2 * 1024 * 1024 + 1) }) });
    assert.equal(overHtml.status, 400);
    const htmlError = (await overHtml.json()).error;
    assert.match(htmlError, /2 MB/);
    assert.doesNotMatch(htmlError, /Word/);
    const overBody = await fetch(route, { method: 'POST', body: ' '.repeat(4 * 1024 * 1024 + 1) });
    assert.equal(overBody.status, 400);
    assert.match((await overBody.json()).error, /4 MB/);
    assert.equal((await fetch(route, { method: 'POST', headers: { Origin: 'https://external.example' }, body: '{"html":"<img>"}' })).status, 403);
    assert.equal((await fetch(`${base}/api/upload-images/${jobId}`, { headers: { Origin: 'https://external.example' } })).status, 403);
    for (const payload of ['null', '[]', '{"mode":"mapped","urls":null}', '{"mode":"mapped","urls":[]}']) {
      const invalidExport = await fetch(`${base}/api/export/${jobId}`, { method: 'POST', body: payload });
      assert.equal(invalidExport.status, 400);
      assert.match((await invalidExport.json()).error, /图片导出选项无效/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('missing local jobs consistently identify expired conversion state', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const missing = '00000000-0000-4000-8000-000000000000';
  try {
    for (const [route, init] of [
      [`/api/import-images/${missing}`, { method: 'POST', body: '{"html":"<p></p>"}' }],
      [`/api/upload-images/${missing}`, {}],
      [`/api/assets/${missing}/missing.png`, {}],
      [`/api/export/${missing}`, { method: 'POST', body: '{"mode":"embedded"}' }],
    ]) {
      const response = await fetch(`${base}${route}`, init);
      assert.equal(response.status, 410);
      const error = await response.json();
      assert.equal(error.code, 'JOB_EXPIRED');
      assert.match(error.error, /已过期/);
    }
    const module = await fetch(`${base}/job-recovery.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('Content-Type'), /javascript/);
    const sectionsModule = await fetch(`${base}/section-view.js`);
    assert.equal(sectionsModule.status, 200);
    assert.match(sectionsModule.headers.get('Content-Type'), /javascript/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a concurrent upload is rejected before its body can bypass the conversion lock', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = http.request(`${base}/api/convert`, { method: 'POST', headers: { 'Content-Length': '3' } });
  const completed = new Promise((resolve, reject) => { request.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject); });
  try {
    request.write('n');
    // Ensure the first request's headers/body start reach the server before the second upload.
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await fetch(`${base}/api/convert`, { method: 'POST', body: 'bad' });
    assert.equal(second.status, 409);
    request.end('ot');
    assert.equal(await completed, 400);
    assert.equal((await fetch(`${base}/api/convert`, { method: 'POST', body: 'bad' })).status, 400);
  } finally { request.destroy(); await new Promise(resolve => server.close(resolve)); }
});
