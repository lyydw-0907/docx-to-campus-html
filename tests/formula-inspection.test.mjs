import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { collectFormulaWarnings, createFormulaInspection } from '../public/formula-inspection.js';

const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pixels = 'data:image/png;base64,AQIDBA==';
const math = tex => `<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>x</mi><annotation encoding="application/x-tex">${escape(tex)}</annotation></semantics></math>`;
const image = (tex, width = 20, height = 10, src = pixels) => `<img src="${src}" alt="${escape(tex)}" width="${width}" height="${height}"/>`;
const html = content => `<html><head><title>合成原始预览</title></head><body>${content}</body></html>`;
const formulas = (tex = ['x', 'y']) => tex.map((tex, position) => ({ index: position + 1, tex, format: 'mathml' }));
const result = (tex = ['x', 'y']) => ({
  preview: html(tex.map((tex, position) => `<p>附近正文 ${position + 1} ${math(tex)}</p>`).join('')),
  fragment: '<p>原始可复制内容</p>', sections: [{ id: 'elsewhere', fragment: '另一栏目的原始 HTML' }],
  manifest: { options: { formulaFormat: 'mathml', imageMode: 'embedded' }, formulas: formulas(tex), warnings: [] },
});

// xmldom is already installed by the converter. Its XML parser is sufficient
// for deterministic DOM tests; the root browser acceptance covers HTML parsing.
// The browser-only CSP prefix is stripped before parsing the XHTML fixture.
const parseDocument = source => {
  assert.match(source, /^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:;/);
  return new DOMParser().parseFromString(source.replace(/^<meta[^>]*>/, ''), 'application/xhtml+xml');
};
const inspect = (source, index, parser = parseDocument) => createFormulaInspection(source, index, { parseDocument: parser });
const parsePreview = preview => new DOMParser().parseFromString(preview.replace(/^<!doctype html>\s*/i, ''), 'application/xhtml+xml');

test('warning actions preserve exact plain text and deduplicate by complete message', () => {
  const source = result();
  const warning = '第 2 个公式：检查 <img onerror="alert(1)"> 和 α。';
  source.manifest.warnings = [warning, warning, '一般提示', '一般提示', '第1个公式含 #', '第2个公式的另一条提示', null, 2, ''];
  assert.deepEqual(collectFormulaWarnings(source), {
    actionable: [{ message: warning, index: 2 }, { message: '第1个公式含 #', index: 1 }, { message: '第2个公式的另一条提示', index: 2 }],
    general: ['一般提示'],
  });
});

test('out-of-range, ambiguous and noncanonical references stay general notes', () => {
  const source = result();
  const general = ['第 3 个公式超出范围', '第 0 个公式', '第 -1 个公式', '第 1.5 个公式', '第 01 个公式', '第 ２ 个公式', '第 x 个公式',
    '第 1 个公式和第 2 个公式', '第 1、2 个公式', '第 1 个公式；第 x 个公式', '第 1 个公式及第 1 个公式', '公式 1 提示', '第 9007199254740993 个公式'];
  source.manifest.warnings = general;
  assert.deepEqual(collectFormulaWarnings(source), { actionable: [], general });
});

test('missing, empty and malformed formula manifests never produce actions', () => {
  for (const invalid of [undefined, null, {}, [], [{ index: 1 }], [{ index: 1, tex: '' }], [{ index: 2, tex: 'x' }], [{ index: 1, tex: 'x' }, { index: 1, tex: 'y' }], Array(2)]) {
    const source = { manifest: { formulas: invalid, warnings: ['第 1 个公式：待检查'] } };
    assert.deepEqual(collectFormulaWarnings(source), { actionable: [], general: source.manifest.warnings });
    const inspection = inspect(source, 1);
    assert.equal(inspection.available, false);
    assert.match(inspection.reason, /公式清单/);
    assert.equal(inspection.preview, '');
    assert.equal(inspection.anchor, '');
  }
  assert.deepEqual(collectFormulaWarnings(undefined), { actionable: [], general: [] });
  assert.deepEqual(collectFormulaWarnings({ manifest: { formulas: formulas(), warnings: '第 1 个公式' } }), { actionable: [], general: [] });
});

test('MathML inspection verifies all original annotations and targets whole-document order', () => {
  const source = result(['α <img onerror="bad"> & β', String.raw`\frac{a}{b}`]);
  const before = JSON.stringify(source);
  const inspection = inspect(source, 2);
  assert.equal(inspection.available, true);
  assert.equal(inspection.index, 2);
  assert.equal(inspection.tex, String.raw`\frac{a}{b}`);
  assert.equal(inspection.reason, '');
  assert.match(inspection.anchor, /^[a-z][a-z0-9-]+$/);
  const document = parsePreview(inspection.preview);
  const nodes = Array.from(document.getElementsByTagName('math'));
  assert.equal(nodes[0].getAttribute('id'), null);
  assert.equal(nodes[1].getAttribute('id'), inspection.anchor);
  assert.equal(document.getElementsByTagName('annotation')[0].textContent, 'α <img onerror="bad"> & β');
  assert.equal(document.getElementsByTagName('img').length, 0, 'HTML-like TeX remains text');
  assert.match(document.getElementsByTagName('body')[0].textContent, /附近正文 1[\s\S]*附近正文 2/);
  assert.equal(JSON.stringify(source), before, 'inspection must not modify export, sections, manifest or preview');
});

test('highlight IDs are unique and :target styles exist only in the clone', () => {
  const source = result();
  source.preview = html(`<p id="campus-formula-inspection-2">原有锚点</p><p id="campus-formula-inspection-2-2">原有锚点二</p>${math('x')}${math('y')}`);
  const inspection = inspect(source, 2);
  assert.equal(inspection.anchor, 'campus-formula-inspection-2-3');
  assert.match(inspection.preview, /#campus-formula-inspection-2-3:target\{outline:3px/);
  assert.doesNotMatch(source.preview, /:target/);
  const ids = Array.from(parsePreview(inspection.preview).getElementsByTagName('*')).map(node => node.getAttribute('id')).filter(Boolean);
  assert.equal(ids.filter(id => id === inspection.anchor).length, 1);
});

test('MathML count, every annotation and manifest index identity must match before targeting', () => {
  const scenarios = [
    source => { source.preview = html(math('x')); },
    source => { source.preview = html(math('x') + math('y') + math('z')); },
    source => { source.preview = html(math('y') + math('x')); },
    source => { source.preview = html('<math><mi>x</mi></math>' + math('y')); },
    source => { source.preview = html(math('x').replace('</semantics>', '<annotation encoding="application/x-tex">x</annotation></semantics>') + math('y')); },
    source => { delete source.manifest.formulas[0].index; },
    source => { source.manifest.formulas.reverse(); },
  ];
  for (const modify of scenarios) {
    const source = result();
    modify(source);
    const inspection = inspect(source, 2);
    assert.equal(inspection.available, false);
    assert.equal(inspection.preview, '');
    assert.equal(inspection.anchor, '');
    assert.match(inspection.reason, /清单|位置/);
  }
});

test('invalid indices, missing previews and failed parsers give readable fallback reasons', () => {
  for (const index of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 3]) {
    const inspection = inspect(result(), index);
    assert.equal(inspection.available, false);
    assert.match(inspection.reason, /编号/);
    assert.equal(inspection.preview, '');
    assert.equal(inspection.anchor, '');
  }
  const source = result();
  assert.match(inspect({ ...source, preview: '' }, 1).reason, /预览/);
  for (const parser of [() => { throw new Error('synthetic failure'); }, () => null, () => ({})]) {
    const inspection = inspect(source, 1, parser);
    assert.equal(inspection.tex, 'x');
    assert.equal(inspection.available, false);
    assert.match(inspection.reason, /解析/);
  }
  assert.match(createFormulaInspection(source, 1, { parseDocument: 'invalid' }).reason, /解析器/);
  assert.equal(createFormulaInspection(source, 1).available, false, 'Node has no default browser DOM parser');
});

test('inspection CSP and clone remove external and active resources while retaining embedded images', () => {
  const source = result(['x']);
  source.preview = `<html><head><meta http-equiv="Content-Security-Policy" content="img-src https:"/><meta http-equiv="refresh" content="0;url=https://school.test/"/><base href="https://school.test/"/><link rel="stylesheet" href="https://school.test/x.css"/><script>bad()</script></head><body onload="bad()"><p>原始上下文${math('x')}</p>${image('嵌入图片')}${image('外部图片', 20, 10, 'https://school.test/x.png')}<iframe src="https://school.test/"></iframe><a href="https://school.test/">链接文本</a></body></html>`;
  const inspection = inspect(source, 1);
  assert.equal(inspection.available, true);
  const document = parsePreview(inspection.preview);
  const policy = document.getElementsByTagName('head')[0].firstChild;
  assert.equal(policy.tagName, 'meta');
  assert.equal(policy.getAttribute('http-equiv'), 'Content-Security-Policy');
  assert.match(policy.getAttribute('content'), /default-src 'none'; img-src data: blob:;/);
  assert.match(policy.getAttribute('content'), /script-src 'none'/);
  assert.match(policy.getAttribute('content'), /base-uri 'none'; form-action 'none'/);
  assert.equal(document.getElementsByTagName('meta').length, 1);
  for (const tag of ['script', 'iframe', 'base', 'link']) assert.equal(document.getElementsByTagName(tag).length, 0);
  assert.equal(document.getElementsByTagName('img')[0].getAttribute('src'), pixels);
  assert.equal(document.getElementsByTagName('img')[1].getAttribute('src'), null);
  assert.equal(document.getElementsByTagName('a')[0].getAttribute('href'), null);
  assert.equal(document.getElementsByTagName('body')[0].getAttribute('onload'), null);
});

function pngResult(tex = ['x', 'y']) {
  const source = result(tex);
  source.manifest.options.formulaFormat = 'png';
  source.manifest.formulas = tex.map((tex, position) => ({ index: position + 1, tex, filename: `${tex}.png`, width: 20.123456, height: 10 }));
  source.preview = html(tex.map((tex, position) => `<p>图片附近正文 ${position + 1}${image(tex, 20.123)}</p>`).join(''));
  return source;
}

test('PNG inspection uses exact descriptors in occurrence order, allowing deduplicated assets', () => {
  const source = pngResult(['x', 'x', 'y']);
  source.preview = html(`${image('普通图片', 80, 40)}<p>第一次 ${image('x', 20.123)}</p><p>第二次 ${image('x', 20.123)}</p><p>第三次 ${image('y', 20.123)}</p>`);
  const before = JSON.stringify(source);
  const inspection = inspect(source, 2);
  assert.equal(inspection.available, true);
  assert.equal(inspection.tex, 'x');
  const images = parsePreview(inspection.preview).getElementsByTagName('img');
  assert.equal(images[1].getAttribute('id'), null);
  assert.equal(images[2].getAttribute('id'), inspection.anchor);
  assert.equal(images[1].getAttribute('src'), images[2].getAttribute('src'));
  assert.equal(JSON.stringify(source), before);
});

test('ambiguous PNG counts, descriptors, order or nonlocal sources never create false anchors', () => {
  const scenarios = [
    source => { source.preview = html(image('x', 20.123)); },
    source => { source.preview = source.preview.replace('</body>', `${image('x', 20.123)}</body>`); },
    source => { source.preview = html(image('y', 20.123) + image('x', 20.123)); },
    source => { source.preview = html(image('x', 20.124) + image('y', 20.123)); },
    source => { source.preview = html(image('x', 20.123) + image('y', 20.123, 11)); },
    source => { source.preview = html(math('x') + image('x', 20.123) + image('y', 20.123)); },
    source => { delete source.manifest.formulas[0].width; },
    source => { source.preview = html(image('x', 20.123) + image('y', 20.123, 10, 'https://school.test/y.png')); },
  ];
  for (const modify of scenarios) {
    const source = pngResult();
    modify(source);
    const inspection = inspect(source, 2);
    assert.equal(inspection.available, false);
    assert.equal(inspection.tex, 'y');
    assert.equal(inspection.anchor, '');
    assert.equal(inspection.preview, '');
    assert.match(inspection.reason, /位置|本地嵌入/);
  }
});

test('school mappings, pasted HTML and selected section content never supply inspection context', () => {
  const source = result(['x']);
  source.preview = html(`<p>原始完整文档 ${math('x')}</p>`);
  source.schoolHtml = '<img src="https://school.test/private.png">';
  source.urls = { 'x.png': 'https://school.test/mapped.png' };
  source.sections = [{ id: 'other', preview: html('<p>当前选中的其他栏目</p>') }];
  const inspection = inspect(source, 1);
  assert.equal(inspection.available, true);
  assert.match(inspection.preview, /原始完整文档/);
  assert.doesNotMatch(inspection.preview, /school\.test|当前选中的其他栏目/);
  for (const mode of ['mapped', 'files']) {
    source.manifest.options.imageMode = mode;
    assert.equal(inspect(source, 1).available, false);
    assert.match(inspect(source, 1).reason, /原始嵌入图片预览/);
  }
  source.manifest.options.imageMode = 'embedded';
  source.manifest.options.formulaFormat = 'svg';
  assert.match(inspect(source, 1).reason, /格式/);
});
