import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { extractMathMLBatch, MATHML_NAMESPACE, sanitizeMathML } from '../src/mathml.mjs';

function math(body, tex = '') { return `<math xmlns="${MATHML_NAMESPACE}"><semantics>${body}<annotation encoding="application/x-tex">${tex}</annotation></semantics></math>`; }

test('safe MathML preserves nested fractions, roots, matrices and mathematical attributes', () => {
  const tex = 'original−TeX';
  const source = math('<mrow><mfrac linethickness="0"><mfrac><mi>a</mi><mi>b</mi></mfrac><msqrt><mi>c</mi></msqrt></mfrac><mo stretchy="true" form="prefix">(</mo><mtable columnalign="left right" columnspacing="0.5em"><mtr><mtd columnalign="left" style="text-align:left"><msubsup><mi>T</mi><mi>i</mi><mi>j</mi></msubsup></mtd><mtd><mover><mi>v</mi><mo accent="true">→</mo></mover></mtd></mtr></mtable><mo stretchy="true" form="postfix">)</mo></mrow>', tex);
  const result = sanitizeMathML(source, { fontSize: 14, display: true, expectedTex: tex });
  const $ = load(result.html, { xmlMode: true });
  assert.equal($('math').attr('xmlns'), MATHML_NAMESPACE);
  assert.equal($('math').attr('display'), 'block');
  assert.match($('math').attr('style'), /font-size:14px/);
  assert.equal($('mfrac').length, 2);
  assert.equal($('mfrac').first().attr('linethickness'), '0');
  assert.equal($('mtable').attr('columnspacing'), '0.5em');
  assert.equal($('mtd').first().attr('columnalign'), 'left');
  assert.equal($('mo[accent="true"]').text(), '→');
  assert.equal($('annotation').text(), tex);
});

test('minus normalization changes operators and standalone minus mi only, never text or original TeX', () => {
  const tex = 'a−b';
  const result = sanitizeMathML(math('<mrow><mi>a</mi><mo>−</mo><mi>b</mi><mi>−</mi><mi>x</mi><mi>name−part</mi><mtext>正文−变量</mtext><mn>−1</mn></mrow>', tex), { expectedTex: tex });
  const $ = load(result.html, { xmlMode: true });
  assert.equal($('mo').length, 2);
  assert.equal($('mo').map((_, element) => $(element).text()).get().join(''), '--');
  assert.equal($('mi').last().text(), 'name−part');
  assert.equal($('mtext').text(), '正文−变量');
  assert.equal($('mn').text(), '−1');
  assert.equal($('annotation').text(), tex);
  assert.equal(result.compatibilityChanges.length, 2);
  assert.equal(result.compatibilityChanges[1].afterTag, 'mo');
  const ascii = sanitizeMathML(math('<mrow><mi>-</mi><mi>x</mi></mrow>', '-x'));
  assert.match(ascii.html, /<mo>-<\/mo><mi>x<\/mi>/);
  assert.equal(ascii.compatibilityChanges[0].beforeText, '-');
});

test('MathML strips executable nodes, annotation-xml, events and URL attributes', () => {
  const result = sanitizeMathML(math('<mrow onclick="bad()"><mi href="https://example.test" xlink:href="javascript:bad()">x</mi><mo style="background-image:url(https://example.test/x)">+</mo><mi>y</mi><script>bad()</script><annotation-xml encoding="text/html"><img src="https://example.test/x" onerror="bad()"/></annotation-xml></mrow>', 'x+y'));
  assert.doesNotMatch(result.html, /script|onclick|href|url\(|annotation-xml|img|onerror|https:/);
  assert.match(result.html, /<mi>x<\/mi>/);
  assert.match(result.html, /<mi>y<\/mi>/);
  assert.equal(result.texAnnotation, 'x+y');
});

test('unknown/error mathematical structures and damaged arity fail explicitly', () => {
  assert.throws(() => sanitizeMathML(math('<merror><mtext>bad</mtext></merror>')), /不支持数学结构 merror/);
  assert.throws(() => sanitizeMathML(math('<maction><mi>x</mi></maction>')), /不支持数学结构 maction/);
  assert.throws(() => sanitizeMathML(math('<mfrac><mi>x</mi></mfrac>')), /子节点数量无效/);
  assert.throws(() => sanitizeMathML('<math xmlns="https://foreign.test"><mi>x</mi></math>'), /命名空间/);
  assert.throws(() => sanitizeMathML(math('<mi>x</mi>', 'changed'), { expectedTex: 'original' }), /annotation 缺失或被改写/);
});

test('batch extraction checks counts, source order, display type and original annotations', () => {
  const first = math('<mfrac><mi>a</mi><mi>b</mi></mfrac>', 'a/b');
  const second = math('<msup><mi>x</mi><mn>2</mn></msup>', 'x^2');
  const result = extractMathMLBatch(`<p>${first}</p><p>${second}</p>`, [{ tex: 'a/b', display: false }, { tex: 'x^2', display: true }]);
  assert.equal(result.length, 2);
  assert.match(result[0].html, /display="inline"/);
  assert.match(result[1].html, /display="block"/);
  assert.throws(() => extractMathMLBatch(first, [{ tex: 'a/b', display: false }, { tex: 'x^2', display: true }]), /数量不一致/);
  assert.throws(() => extractMathMLBatch(first, [{ tex: 'wrong', display: false }]), /annotation/);
});

test('Windows Pandoc line-ending translation restores exact original matrix TeX without ignoring whitespace', () => {
  const original = '\\begin{matrix}\na &amp; b \\\\\nc &amp; d\n\\end{matrix}';
  const tex = original.replaceAll('&amp;', '&');
  const result = sanitizeMathML(math('<mi>x</mi>', original.replaceAll('\n', '\r\n')), { expectedTex: tex });
  assert.equal(result.texAnnotation, tex);
  assert.ok(!result.texAnnotation.includes('\r'));
  assert.throws(() => sanitizeMathML(math('<mi>x</mi>', original.replace('a &amp;', 'a  &amp;')), { expectedTex: tex }), /annotation 缺失或被改写/);
});

test('batch extraction keeps separate source formula sizes and rejects invalid per-formula size', () => {
  const html = math('<mi>x</mi>', 'x') + math('<mi>y</mi>', 'y');
  const result = extractMathMLBatch(html, [{ tex: 'x', display: false, fontSize: 16 }, { tex: 'y', display: true, fontSize: 20 }], { fontSize: 14 });
  assert.match(result[0].html, /font-size:16px/);
  assert.match(result[1].html, /font-size:20px/);
  assert.throws(() => extractMathMLBatch(math('<mi>x</mi>', 'x'), [{ tex: 'x', display: false, fontSize: 0 }]), /字号无效/);
});
