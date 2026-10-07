import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { createServer } from '../src/server.mjs';
import { resolvePandocPath } from '../src/convert.mjs';
import { makeProgressDemoDocx } from '../src/fixtures.mjs';

let pandocAvailable = true;
try { await promisify(execFile)(await resolvePandocPath(), ['--version']); } catch { pandocAvailable = false; }
const requiresPandoc = { skip: pandocAvailable ? false : 'Install Pandoc for form-specific HTTP integration tests.' };

async function withServer(run) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('HTTP rejects unknown form choices before consuming empty or invalid DOCX bodies', async () => {
  await withServer(async base => {
    for (const value of ['unknown', '', 'Progress']) {
      const response = await fetch(`${base}/api/convert?documentType=${value}`, { method: 'POST', body: 'not a docx' });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /学校表单/);
    }
    const empty = await fetch(`${base}/api/convert?documentType=unknown`, { method: 'POST' });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /学校表单/);
  });
});

test('HTTP form-specific demo download returns the chosen synthetic Word and validates the form', async () => {
  await withServer(async base => {
    const progress = await fetch(`${base}/api/demo-docx?documentType=progress`);
    assert.equal(progress.status, 200);
    assert.match(progress.headers.get('Content-Disposition'), /progress-demo.docx/);
    const progressZip = await JSZip.loadAsync(await progress.arrayBuffer(), { checkCRC32: true });
    const xml = await progressZip.file('word/document.xml').async('string');
    assert.match(xml, /项目进展检查/);
    assert.match(xml, /项目后期具体工作计划/);
    for (const suffix of ['', '?documentType=application']) {
      const response = await fetch(`${base}/api/demo-docx${suffix}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Disposition'), /"demo.docx"/);
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      assert.match(await zip.file('word/document.xml').async('string'), /大创申报转换示例/);
    }
    assert.equal((await fetch(`${base}/api/demo-docx?documentType=unknown`)).status, 400);
  });
});

test('HTTP progress conversion returns two independent fields, scoped mapped copy and indexed ZIP while application remains the default', requiresPandoc, async () => {
  await withServer(async base => {
    const document = await makeProgressDemoDocx();
    const convert = query => fetch(`${base}/api/convert?formulaFormat=mathml&fontMode=word&fontSize=14${query}`, { method: 'POST', body: document });
    const converted = await convert('&documentType=progress');
    assert.equal(converted.status, 200);
    const result = await converted.json();
    assert.equal(result.manifest.options.documentType, 'progress');
    assert.equal(result.manifest.verification, 'unverified');
    assert.deepEqual(result.sections.filter(section => section.kind === 'field').map(section => section.id), ['progress-check', 'later-work-plan']);
    assert.equal(result.manifest.formulas.length, 3);
    assert.equal(result.assets.length, 1);
    const progress = result.sections.find(section => section.id === 'progress-check');
    const later = result.sections.find(section => section.id === 'later-work-plan');
    assert.match(progress.title, /^项目进展检查（/);
    assert.equal(progress.formulaCount, 2);
    assert.equal(progress.imageCount, 1);
    assert.equal(later.imageCount, 0);
    assert.equal(later.formulaCount, 1);
    assert.deepEqual(later.assetFilenames, []);
    assert.match(load(result.fragment, null, false).text(), /项目后期具体工作计划/);
    assert.ok(!load(later.fragment, null, false).text().includes('项目后期具体工作计划'), 'the school-provided outer title is removed from its body');
    const urls = Object.fromEntries(result.assets.map(asset => [asset.filename, 'https://school.example.test/synthetic-progress.png']));
    const post = options => fetch(`${base}/api/export/${result.jobId}`, { method: 'POST', body: JSON.stringify(options) });
    for (const id of ['progress-check', 'later-work-plan', 'whole']) {
      const response = await post({ mode: 'mapped', format: 'json', sectionId: id, urls });
      assert.equal(response.status, 200);
      const { section } = await response.json();
      assert.equal(section.id, id);
      assert.equal(Object.hasOwn(section, 'preview'), false);
      if (id !== 'later-work-plan') assert.equal(load(section.fragment, null, false)('img').attr('src'), urls[result.assets[0].filename]);
      if (id === 'progress-check') assert.equal(load(section.fragment, null, false)('math').length, 2);
    }
    const exported = await post({ mode: 'mapped', urls });
    assert.equal(exported.status, 200);
    const archive = await JSZip.loadAsync(await exported.arrayBuffer(), { checkCRC32: true });
    const index = JSON.parse(await archive.file('sections/index.json').async('string'));
    assert.deepEqual(index.filter(section => section.kind === 'field').map(section => section.id), ['progress-check', 'later-work-plan']);
    assert.equal(JSON.parse(await archive.file('manifest.json').async('string')).options.documentType, 'progress');
    assert.ok(archive.file('sections/progress-check.html'));
    assert.ok(archive.file('sections/later-work-plan.html'));
    const defaultResponse = await convert('');
    assert.equal(defaultResponse.status, 200);
    const defaultResult = await defaultResponse.json();
    assert.equal(defaultResult.manifest.options.documentType, 'application');
    assert.ok(!defaultResult.sections.some(section => ['progress-check', 'later-work-plan'].includes(section.id)));
    const explicitResponse = await convert('&documentType=application');
    assert.equal(explicitResponse.status, 200);
    const explicit = await explicitResponse.json();
    assert.equal(explicit.manifest.options.documentType, 'application');
    assert.deepEqual(explicit.sections, defaultResult.sections);
  });
});
