import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { convertDocx } from '../src/convert.mjs';
import { convertDocxWithRuntime } from '../src/convert-core.mjs';
import { makeProgressDemoDocx } from '../src/fixtures.mjs';

test('real progress DOCX passes its selected form to shared conversion, field exports and manifest', async () => {
  const result = await convertDocx(await makeProgressDemoDocx(), { documentType: 'progress', formulaFormat: 'mathml', fontMode: 'word', fontSize: 14 });
  assert.equal(result.manifest.options.documentType, 'progress');
  assert.deepEqual(result.sections.map(section => section.id), ['progress-check', 'later-work-plan']);
  assert.deepEqual(result.manifest.sectioning, { fields: 2, unassigned: 0 });
  assert.deepEqual(result.sections.map(section => section.formulaCount), [2, 1]);
  assert.deepEqual(result.sections.map(section => section.imageCount), [1, 0]);
  const first = load(result.sections[0].fragment, {}, false);
  const second = load(result.sections[1].fragment, {}, false);
  assert.equal(first('h1').length, 0);
  assert.equal(second('h1').length, 0);
  assert.equal(first('mfrac').length, 1);
  assert.equal(first('img').length, 1);
  assert.equal(second('msup').length, 1);
  assert.match(second('p').first().closest('div').attr('style'), /text-indent:2em/);
  assert.match(first('p').first().closest('div').attr('style'), /text-indent:2em/);
  assert.ok(second('strong,b').text().includes('下一阶段先核对模型结果'));
  assert.deepEqual(result.sections[0].assetFilenames, [result.assets[0].filename]);
  assert.deepEqual(result.sections[1].assetFilenames, []);
  assert.ok(result.fragment.includes('项目进展检查'), 'whole-document export retains the source field labels');
  assert.ok(result.fragment.includes('项目后期具体工作计划'));
});

test('progress report contents remain whole when the default application form has no matching school fields', async () => {
  const result = await convertDocx(await makeProgressDemoDocx(), { formulaFormat: 'mathml' });
  assert.equal(result.manifest.options.documentType, 'application');
  assert.deepEqual(result.sections, []);
  assert.equal(load(result.fragment)('math').length, 3);
  assert.equal(load(result.fragment)('img').length, 1);
  assert.ok(result.fragment.includes('项目后期具体工作计划'));
  assert.ok(result.manifest.warnings.some(warning => warning.includes('未找到至少两个')));
});

test('invalid form choices fail before inspecting the DOCX or initializing a conversion engine', async () => {
  let runtimeStarted = false;
  const runtime = { createSession() { runtimeStarted = true; throw new Error('unexpected engine start'); } };
  for (const documentType of ['report', '', null, 1, {}]) {
    await assert.rejects(convertDocxWithRuntime(Buffer.alloc(0), { documentType }, runtime), /学校表单/);
  }
  assert.equal(runtimeStarted, false);
});
