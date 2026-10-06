import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareFragments, safeImageUrl } from '../src/probe.mjs';

test('reopened source exposes stripped styles, math and image dimensions', () => {
  const report = compareFragments('<p style="font-size:16px">正文<img src="data:image/png;base64,AAAA" width="20" height="10"></p><math><mi>x</mi></math>', '<p>正文<img src="/school/image.png"></p>x');
  assert.equal(report.textPreserved, true);
  assert.equal(report.unchangedImageSources, 0);
  assert.equal(report.imagesWithDimensionsAfter, 0);
  assert.equal(report.rows.find(row => row.feature === 'math').status, 'reduced');
  assert.equal(report.rows.find(row => row.feature === 'font-size:16px').status, 'reduced');
  assert.equal(report.verification, 'source-compared-only');
});

test('serialization and insignificant text spacing do not imply lost content', () => {
  const report = compareFragments('<p style="font-size: 16px;line-height:1.8">a b</p>', '<p style="line-height:1.8; font-size:16px;">a  b</p>');
  assert.equal(report.textPreserved, true);
  assert.ok(report.rows.every(row => row.status === 'unchanged'));
});

test('a significant space between words is not treated as preserved when removed', () => {
  const report = compareFragments('<p>a b</p>', '<p>ab</p>');
  assert.equal(report.textPreserved, false);
  assert.equal(compareFragments('<p>  a\n\t b </p>', '<p>a b</p>').textPreserved, true);
});

test('changed image attribute dimensions are reported even when both attributes remain', () => {
  const report = compareFragments('<img src="/a.png" width="20" height="10">', '<img src="/a.png" width="200" height="100">');
  assert.equal(report.imagesWithDimensionsBefore, 1);
  assert.equal(report.imagesWithDimensionsAfter, 1);
  assert.equal(report.unchangedImageSources, 1);
  assert.equal(report.imageChanges.length, 1);
  const [change] = report.imageChanges;
  assert.equal(change.match, 'source');
  assert.equal(change.index, 1);
  assert.equal(change.afterIndex, 1);
  assert.equal(change.before.width, '20');
  assert.equal(change.before.height, '10');
  assert.equal(change.after.width, '200');
  assert.equal(change.after.height, '100');
  assert.deepEqual(change.changes, ['width', 'height']);
  assert.equal(change.status, 'geometry-changed');
  assert.equal(report.verification, 'source-compared-only');
});

test('per-image style widths, heights and baseline values are compared', () => {
  const report = compareFragments(
    '<img src="/a.png" width="20" height="10" style="width:20px;height:10px;vertical-align:-2px">',
    '<img src="/a.png" width="20" height="10" style="height:100px;width:200px;vertical-align:middle">',
  );
  const [change] = report.imageChanges;
  assert.deepEqual(change.changes, ['style.width', 'style.height', 'style.verticalAlign']);
  assert.equal(change.before.style.width, '20px');
  assert.equal(change.after.style.width, '200px');
  assert.equal(change.before.style.height, '10px');
  assert.equal(change.after.style.height, '100px');
  assert.equal(change.before.style.verticalAlign, '-2px');
  assert.equal(change.after.style.verticalAlign, 'middle');
});

test('retained image sources take priority over order when images are moved', () => {
  const report = compareFragments(
    '<img src="/a.png" width="20" height="10"><img src="/b.png" width="40" height="30">',
    '<img src="/b.png" width="40" height="30"><img src="/a.png" width="200" height="100">',
  );
  const change = report.imageChanges.find(image => image.before.src === '/a.png');
  assert.equal(change.match, 'source');
  assert.equal(change.index, 1);
  assert.equal(change.afterIndex, 2);
  assert.equal(change.after.src, '/a.png');
  assert.equal(change.after.width, '200');
  assert.equal(report.imageChanges.find(image => image.before.src === '/b.png').status, 'reordered');
});

test('rewritten URLs use tentative order matching without claiming image support failed', () => {
  const report = compareFragments(
    '<img src="data:image/png;base64,AAAA" width="20" height="10">',
    '<img src="https://school.example/upload/1.png" width="20" height="10">',
  );
  const [change] = report.imageChanges;
  assert.equal(change.match, 'order');
  assert.equal(change.status, 'source-rewritten');
  assert.deepEqual(change.changes, ['src']);
  assert.match(change.note, /推测对应关系/);
  assert.match(change.note, /不能据此判定图片支持失败/);
  assert.equal(report.verification, 'source-compared-only');
});

test('unchanged image dimensions and normalized style serialization generate no changes', () => {
  const report = compareFragments(
    '<img src="/a.png" width="20" height="10" style="width: 20px; height:10px;vertical-align:-2px">',
    '<img src="/a.png" height="10" width="20" style="vertical-align: -2px;HEIGHT:10px;WIDTH:20PX;">',
  );
  assert.deepEqual(report.imageChanges, []);
});

test('missing and added images preserve dimensions without inventing confirmed matches', () => {
  const removed = compareFragments('<p><img src="/a.png" width="20" height="10"></p>', '<p> </p>');
  assert.equal(removed.imageChanges[0].match, 'missing');
  assert.equal(removed.imageChanges[0].after, null);
  assert.equal(removed.imageChanges[0].before.width, '20');
  const added = compareFragments('<p> </p>', '<p><img src="/b.png" width="40" height="30"></p>');
  assert.equal(added.imageChanges[0].match, 'added');
  assert.equal(added.imageChanges[0].before, null);
  assert.equal(added.imageChanges[0].after.width, '40');
});

test('removed table span and changed text are measurable', () => {
  const report = compareFragments('<table><tr><td colspan="2">原文</td></tr></table>', '<table><tr><td>新文</td></tr></table>');
  assert.equal(report.textPreserved, false);
  assert.equal(report.rows.find(row => row.feature === 'colspan:2').status, 'reduced');
});

test('school image mapping accepts only absolute HTTP(S), without credentials', () => {
  assert.equal(safeImageUrl('https://dxscxcy.hzau.edu.cn/image/example.png'), 'https://dxscxcy.hzau.edu.cn/image/example.png');
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,AA', '/relative.png', 'https://user:password@example.org/a.png']) assert.throws(() => safeImageUrl(url));
});

const math = (presentation, annotation = '', attributes = '') => `<math xmlns="http://www.w3.org/1998/Math/MathML" ${attributes}><semantics>${presentation}${annotation ? `<annotation encoding="application/x-tex">${annotation}</annotation>` : ''}</semantics></math>`;

test('source without formulas retains the existing report and has an empty math comparison', () => {
  const report = compareFragments('<p>a b</p>', '<p>a  b</p>');
  assert.equal(report.mathCountBefore, 0);
  assert.equal(report.mathCountAfter, 0);
  assert.equal(report.mathPreserved, true);
  assert.deepEqual(report.mathChanges, []);
  assert.ok(Array.isArray(report.rows));
  assert.equal(report.verification, 'source-compared-only');
});

test('MathML formatting indentation and attribute order do not change semantics', () => {
  const before = math('<mfrac linethickness="1px" displaystyle="true"><mi>a</mi><mi>b</mi></mfrac>', '\\frac{a}{b}', 'display="block"');
  const after = '<math display="block" xmlns="http://www.w3.org/1998/Math/MathML">\n <semantics>\n  <mfrac displaystyle="true" linethickness="1px">\n   <mi>a</mi>\n   <mi>b</mi>\n  </mfrac>\n  <annotation encoding="application/x-tex">\\frac{a}{b}</annotation>\n </semantics>\n</math>';
  const report = compareFragments(before, after);
  assert.equal(report.mathCountBefore, 1);
  assert.equal(report.mathCountAfter, 1);
  assert.equal(report.mathPreserved, true);
  assert.deepEqual(report.mathChanges, []);
});

test('school-style Unicode minus damage is detected even with intact TeX and identical tag counts', () => {
  const before = math('<mrow><mi>−</mi><mi>b</mi><mo>±</mo><msqrt><mrow><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></mrow></msqrt></mrow>', '-b\\pm\\sqrt{b^2-4ac}');
  const after = before.replaceAll('−', '?');
  const report = compareFragments(before, after);
  assert.equal(report.mathPreserved, false);
  assert.ok(report.rows.every(row => row.status === 'unchanged'));
  const [change] = report.mathChanges;
  assert.equal(change.index, 1);
  assert.equal(change.structurePreserved, true);
  assert.equal(change.tokensPreserved, false);
  assert.equal(change.annotationPreserved, true);
  assert.equal(change.tokenChanges.length, 2);
  assert.equal(change.before.annotationCount, 1);
  assert.equal(change.before.tokenCount, 9);
  for (const token of change.tokenChanges) {
    assert.equal(token.before.text, '−');
    assert.equal(token.after.text, '?');
    assert.deepEqual(token.before.codePoints, ['U+2212']);
    assert.deepEqual(token.after.codePoints, ['U+003F']);
    assert.equal(token.before.namespace, 'http://www.w3.org/1998/Math/MathML');
    assert.ok(Array.isArray(token.path));
  }
});

test('compatibility minus must be present in both sources rather than silently treated as Unicode minus', () => {
  const compatible = math('<mrow><mo>-</mo><mi>x</mi></mrow>', '-x');
  assert.equal(compareFragments(compatible, compatible).mathPreserved, true);
  assert.equal(compareFragments(math('<mrow><mo>−</mo><mi>x</mi></mrow>', '-x'), compatible).mathPreserved, false);
});

test('a fraction structure changed to a row is detected despite preserved text and leaf counts', () => {
  const report = compareFragments(math('<mfrac><mi>a</mi><mi>b</mi></mfrac>'), math('<mrow><mi>a</mi><mi>b</mi></mrow>'));
  assert.equal(report.textPreserved, true);
  assert.equal(report.mathPreserved, false);
  assert.equal(report.mathChanges[0].structurePreserved, false);
  assert.equal(report.mathChanges[0].tokensPreserved, true);
  assert.ok(report.mathChanges[0].structureChanges.some(change => change.before?.tag === 'mfrac' && change.after?.tag === 'mrow'));
});

test('formula order and numerator/denominator token positions are compared', () => {
  const a = math('<mfrac><mi>a</mi><mi>b</mi></mfrac>');
  const b = math('<mfrac><mi>b</mi><mi>a</mi></mfrac>');
  const report = compareFragments(a + b, b + a);
  assert.equal(report.mathCountBefore, 2);
  assert.equal(report.mathCountAfter, 2);
  assert.equal(report.mathPreserved, false);
  assert.deepEqual(report.mathChanges.map(change => change.index), [1, 2]);
  assert.ok(report.mathChanges.every(change => change.structurePreserved && !change.tokensPreserved));
  assert.notDeepEqual(report.mathChanges[0].tokenChanges[0].path, report.mathChanges[0].tokenChanges[1].path);
});

test('semantic MathML attribute values are compared without lowercasing or dropping namespaces', () => {
  const report = compareFragments(
    math('<mstyle displaystyle="true"><mo movablelimits="true">∑</mo><mfrac linethickness="1px"><mi mathvariant="bold">x</mi><mn>2</mn></mfrac></mstyle>', '', 'display="block"'),
    math('<mstyle displaystyle="false"><mo movablelimits="false">∑</mo><mfrac linethickness="0"><mi mathvariant="normal">x</mi><mn>2</mn></mfrac></mstyle>', '', 'display="inline"'),
  );
  assert.equal(report.mathPreserved, false);
  assert.equal(report.mathChanges[0].structurePreserved, false);
  assert.equal(report.mathChanges[0].tokensPreserved, true);
  assert.equal(report.mathChanges[0].annotationPreserved, true);
  assert.equal(report.mathChanges[0].structureChanges.length, 5);
  assert.ok(report.mathChanges[0].structureChanges.every(change => change.changes.includes('attributes')));
  const href = compareFragments(math('<mi xlink:href="#a">x</mi>'), math('<mi href="#a">x</mi>'));
  const [attribute] = href.mathChanges[0].structureChanges[0].before.attributes;
  assert.equal(attribute.name, 'href');
  assert.equal(attribute.namespace, 'http://www.w3.org/1999/xlink');
  assert.equal(attribute.prefix, 'xlink');
});

test('TeX annotation text, encoding and removal are reported separately from presentation', () => {
  const source = math('<msup><mi>x</mi><mn>2</mn></msup>', 'x^2');
  for (const after of [source.replace('x^2', 'x^3'), source.replace('application/x-tex', 'text/plain'), source.replace('<annotation encoding="application/x-tex">x^2</annotation>', '')]) {
    const report = compareFragments(source, after);
    assert.equal(report.mathPreserved, false);
    assert.equal(report.mathChanges[0].tokensPreserved, true);
    assert.equal(report.mathChanges[0].annotationPreserved, false);
    assert.ok(report.mathChanges[0].annotationChanges.length > 0);
  }
  const textChange = compareFragments(source, source.replace('x^2', 'x^3')).mathChanges[0];
  assert.equal(textChange.structurePreserved, true);
  assert.ok(textChange.annotationChanges[0].before.records.some(record => record.text === 'x^2'));
});

test('annotation-xml payload changes are captured before general script/style removal', () => {
  const before = math('<mi>x</mi>').replace('</semantics>', '<annotation-xml encoding="text/html"><div><script>first</script><span>X</span></div></annotation-xml></semantics>');
  const after = before.replace('first', 'second');
  const report = compareFragments(before, after);
  assert.equal(report.textPreserved, true);
  assert.equal(report.mathPreserved, false);
  assert.equal(report.mathChanges[0].structurePreserved, true);
  assert.equal(report.mathChanges[0].tokensPreserved, true);
  assert.equal(report.mathChanges[0].annotationPreserved, false);
  assert.ok(report.mathChanges[0].annotationChanges[0].before.records.some(record => record.text === 'first'));
});

test('math tokens and annotations retain significant whitespace and exact Unicode code points', () => {
  for (const [before, after] of [
    [math('<mtext>a b</mtext>'), math('<mtext>ab</mtext>')],
    [math('<mtext>a  b</mtext>'), math('<mtext>a b</mtext>')],
    [math('<mi>𝑥</mi>'), math('<mi>x</mi>')],
    [math('<mi>a\u0301</mi>'), math('<mi>á</mi>')],
    [math('<mrow><mi>x</mi>\u00a0<mi>y</mi></mrow>'), math('<mrow><mi>x</mi><mi>y</mi></mrow>')],
  ]) assert.equal(compareFragments(before, after).mathPreserved, false);
  assert.equal(compareFragments(math('<mi>a\u0301</mi>'), math('<mi>á</mi>')).textPreserved, true);
  const source = math('<mi>x</mi>', ' x ');
  assert.equal(compareFragments(source, math('<mi>x</mi>', 'x')).mathChanges[0].annotationPreserved, false);
});

test('added and removed formulas identify missing before or after summaries', () => {
  const source = math('<mi>x</mi>');
  const removed = compareFragments(source, '<p>x</p>');
  assert.equal(removed.mathCountBefore, 1);
  assert.equal(removed.mathCountAfter, 0);
  assert.equal(removed.mathPreserved, false);
  assert.equal(removed.mathChanges[0].after, null);
  assert.equal(removed.mathChanges[0].tokensPreserved, false);
  const added = compareFragments('<p>x</p>', source);
  assert.equal(added.mathCountBefore, 0);
  assert.equal(added.mathCountAfter, 1);
  assert.equal(added.mathChanges[0].before, null);
  assert.equal(added.mathChanges[0].after.text, 'x');
});

test('compare input validation is retained for missing or invalid fragments', () => {
  for (const value of ['', ' \n ', null, undefined, {}, 42]) {
    assert.throws(() => compareFragments(value, '<p>x</p>'), /两份 HTML 源码/);
    assert.throws(() => compareFragments('<p>x</p>', value), /两份 HTML 源码/);
  }
});
