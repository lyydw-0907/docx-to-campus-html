import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { extractOMMLLayout, applyOMMLLimits, applyOMMLLimitCommands } from '../src/omml-layout.mjs';

const namespace = 'http://www.w3.org/1998/Math/MathML';
const math = (body, display = 'inline') => `<math xmlns="${namespace}" display="${display}"><semantics>${body}<annotation encoding="application/x-tex">\\sum_{i=1}^{2} a &amp; b − \\#</annotation></semantics></math>`;
const limits = (operator, limitLocation) => ({ operator, limitLocation });
const apply = (body, naries, display) => applyOMMLLimits(math(body, display), { naries });

test('extracts source n-ary order, explicit locations and only whole single-row eqArr wrappers', () => {
  const xml = '<w:document xmlns:w="w" xmlns:m="m"><w:p><m:oMathPara><m:oMath><m:eqArr><m:eqArrPr/><m:e><m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:e><m:nary><m:naryPr><m:chr m:val="∫"/><m:limLoc m:val="subSup"/></m:naryPr></m:nary></m:e></m:nary></m:e></m:eqArr></m:oMath></m:oMathPara></w:p><w:p><m:oMath><m:r><m:t>x</m:t></m:r><m:eqArr><m:e/></m:eqArr><m:nary><m:naryPr><m:chr m:val="∏"/></m:naryPr></m:nary></m:oMath></w:p><w:p><m:oMath><m:eqArr><m:e/><m:e/></m:eqArr></m:oMath></w:p></w:document>';
  assert.deepEqual(extractOMMLLayout(xml), [
    { naries: [limits('∑', 'undOvr'), limits('∫', 'subSup')], eqArrSingleRow: true },
    { naries: [limits('∏', null)], eqArrSingleRow: false },
    { naries: [], eqArrSingleRow: false },
  ]);
});

test('restores inline under/over limits and disables movement within an array cell', () => {
  const result = apply('<mtable><mtr><mtd><msubsup><mo>∑</mo><mi>i</mi><mn>2</mn></msubsup></mtd></mtr></mtable>', [limits('∑', 'undOvr')]);
  const $ = load(result.html, { xmlMode: true });
  assert.equal($('math').attr('display'), 'inline');
  assert.equal($('munderover').length, 1);
  assert.equal($('msubsup').length, 0);
  assert.equal($('mo').attr('movablelimits'), 'false');
  assert.equal(result.changes[0].beforeTag, 'msubsup');
  assert.equal(result.changes[0].afterTag, 'munderover');
  assert.deepEqual(result.warnings, []);
});

test('restores display side limits for an explicitly side-positioned integral', () => {
  const result = apply('<munderover accent="false" accentunder="false"><mo>∫</mo><mn>0</mn><mn>1</mn></munderover>', [limits('∫', 'subSup')], 'block');
  const $ = load(result.html, { xmlMode: true });
  assert.equal($('math').attr('display'), 'block');
  assert.equal($('msubsup').length, 1);
  assert.equal($('munderover').length, 0);
  assert.equal($('msubsup').attr('accent'), undefined);
  assert.equal($('msubsup').attr('accentunder'), undefined);
});

test('matches two source n-aries individually while leaving ordinary variable scripts untouched', () => {
  const result = apply('<mrow><msub><mi>x</mi><mi>t</mi></msub><msubsup><mo>∑</mo><mi>i</mi><mn>2</mn></msubsup><mo>+</mo><munder><mrow><mstyle><mo>∏</mo></mstyle></mrow><mi>j</mi></munder><msup><mi>q</mi><mn>2</mn></msup></mrow>', [limits('∑', 'undOvr'), limits('∏', 'subSup')]);
  const $ = load(result.html, { xmlMode: true });
  assert.equal($('munderover > mo').text(), '∑');
  assert.equal($('msub').length, 2);
  assert.equal($('msub').first().children().first().text(), 'x');
  assert.equal($('msup > mi').text(), 'q');
  assert.equal(result.changes.length, 2);
});

test('requires matching count and operator sequence before changing any candidate', () => {
  const input = math('<msubsup><mo>∑</mo><mi>i</mi><mn>2</mn></msubsup>');
  for (const naries of [[limits('∏', 'undOvr')], [limits('∑', 'undOvr'), limits('∏', 'subSup')]]) {
    const result = applyOMMLLimits(input, { naries });
    assert.equal(result.html, input);
    assert.deepEqual(result.changes, []);
    assert.equal(result.warnings.length, 1);
  }
  const two = math('<msub><mo>∑</mo><mi>i</mi></msub><msub><mo>∏</mo><mi>j</mi></msub>');
  const swapped = applyOMMLLimits(two, { naries: [limits('∏', 'undOvr'), limits('∑', 'undOvr')] });
  assert.equal(swapped.html, two);
  assert.equal(swapped.warnings.length, 1);
});

test('preserves TeX annotation, characters and content outside the matched operator', () => {
  const body = '<mrow><mi>θ</mi><mo>−</mo><msub><mo>∑</mo><mi>i</mi></msub><mtext>ln &amp; 中文</mtext></mrow>';
  const input = math(body);
  const result = applyOMMLLimits(input, { naries: [limits('∑', 'undOvr')] });
  const before = load(input, { xmlMode: true });
  const after = load(result.html, { xmlMode: true });
  assert.equal(after('annotation').text(), before('annotation').text());
  assert.equal(after('mi').text(), before('mi').text());
  assert.equal(after('mtext').text(), before('mtext').text());
  assert.equal(after('mo').first().text(), '−');
});

test('keeps already-correct under/over constructs and forces explicit non-movable limits', () => {
  const result = apply('<mover><mo movablelimits="true">∑</mo><mn>2</mn></mover>', [limits('∑', 'undOvr')]);
  const $ = load(result.html, { xmlMode: true });
  assert.equal($('mover').length, 1);
  assert.equal($('mo').attr('movablelimits'), 'false');
  assert.equal(result.changes[0].beforeTag, result.changes[0].afterTag);
  const repeat = applyOMMLLimits(result.html, { naries: [limits('∑', 'undOvr')] });
  assert.equal(repeat.html, result.html);
  assert.deepEqual(repeat.changes, []);
});

test('already-correct block under/over trees stay byte-for-byte unchanged unless an ancestor is compact', () => {
  const input = math('<munderover><mo>∑</mo><mi>i</mi><mn>2</mn></munderover>', 'block');
  const result = applyOMMLLimits(input, { naries: [limits('∑', 'undOvr')] });
  assert.deepEqual(result, { html: input, changes: [], warnings: [] });
  const compact = math('<mstyle displaystyle="false"><munderover><mo>∑</mo><mi>i</mi><mn>2</mn></munderover></mstyle>', 'block');
  const adjusted = applyOMMLLimits(compact, { naries: [limits('∑', 'undOvr')] });
  assert.equal(load(adjusted.html, { xmlMode: true })('mo').attr('movablelimits'), 'false');
  assert.equal(adjusted.changes.length, 1);
});

test('automatic compact subexpressions restore already-under limits in fractions, root indexes and non-base scripts', () => {
  const sum = '<munderover><mo>∑</mo><mi>i</mi><mn>3</mn></munderover>';
  // These contexts were also measured in Edge: without movablelimits=false,
  // the lower bound appears to the right despite using a munderover element.
  const contexts = [
    `<mfrac>${sum}<mi>x</mi></mfrac>`,
    `<mfrac><mi>x</mi>${sum}</mfrac>`,
    `<mfrac><msqrt>${sum}</msqrt><mi>x</mi></mfrac>`,
    `<mroot><mi>x</mi>${sum}</mroot>`,
    `<msub><mi>x</mi>${sum}</msub>`,
    `<msup><mi>x</mi>${sum}</msup>`,
    `<msubsup><mi>x</mi><mi>j</mi>${sum}</msubsup>`,
    `<munder><mi>x</mi>${sum}</munder>`,
    `<mover><mi>x</mi>${sum}</mover>`,
    `<munderover><mi>x</mi><mi>j</mi>${sum}</munderover>`,
    `<mmultiscripts><mi>x</mi>${sum}<none/></mmultiscripts>`,
  ];
  for (const body of contexts) {
    const result = apply(body, [limits('∑', 'undOvr')], 'block');
    const $ = load(result.html, { xmlMode: true });
    assert.equal($('mo').attr('movablelimits'), 'false', body);
    assert.equal(result.changes.length, 1, body);
    assert.equal(result.changes[0].beforeTag, 'munderover', body);
    assert.equal(result.changes[0].afterTag, 'munderover', body);
  }
});

test('square roots, root bases and script bases retain normal block limits without unnecessary changes', () => {
  const sum = '<munderover><mo>∑</mo><mi>i</mi><mn>3</mn></munderover>';
  const contexts = [
    `<msqrt>${sum}</msqrt>`,
    `<mroot>${sum}<mn>3</mn></mroot>`,
    `<msub>${sum}<mi>j</mi></msub>`,
    `<msup>${sum}<mi>j</mi></msup>`,
    `<munder>${sum}<mi>j</mi></munder>`,
    `<mover>${sum}<mi>j</mi></mover>`,
    // scriptlevel controls depth/font scaling without imposing compact style.
    `<mstyle scriptlevel="1">${sum}</mstyle>`,
  ];
  for (const body of contexts) {
    const input = math(body, 'block');
    assert.deepEqual(applyOMMLLimits(input, { naries: [limits('∑', 'undOvr')] }), { html: input, changes: [], warnings: [] }, body);
  }
});

test('nearest displaystyle overrides automatic and inherited compact contexts in either direction', () => {
  const sum = '<munderover><mo>∑</mo><mi>i</mi><mn>3</mn></munderover>';
  const normalContexts = [
    `<mstyle displaystyle="false"><mstyle displaystyle="true">${sum}</mstyle></mstyle>`,
    `<mfrac><mstyle displaystyle="true">${sum}</mstyle><mi>x</mi></mfrac>`,
    `<mroot><mi>x</mi><mstyle displaystyle="true">${sum}</mstyle></mroot>`,
    `<mtable displaystyle="true"><mtr><mtd>${sum}</mtd></mtr></mtable>`,
  ];
  for (const body of normalContexts) {
    const input = math(body, 'block');
    assert.deepEqual(applyOMMLLimits(input, { naries: [limits('∑', 'undOvr')] }), { html: input, changes: [], warnings: [] }, body);
  }
  const inlineOverride = math(`<mstyle displaystyle="true">${sum}</mstyle>`, 'inline');
  assert.equal(applyOMMLLimits(inlineOverride, { naries: [limits('∑', 'undOvr')] }).html, inlineOverride);
  const rootOverride = math(sum, 'block').replace('display="block"', 'display="block" displaystyle="false"');
  assert.equal(load(applyOMMLLimits(rootOverride, { naries: [limits('∑', 'undOvr')] }).html, { xmlMode: true })('mo').attr('movablelimits'), 'false');
  const nestedFalse = apply(`<mstyle displaystyle="true"><mstyle displaystyle="false">${sum}</mstyle></mstyle>`, [limits('∑', 'undOvr')], 'block');
  assert.equal(load(nestedFalse.html, { xmlMode: true })('mo').attr('movablelimits'), 'false');
});

test('unknown locations and missing source characters never trigger a guessed rewrite', () => {
  const input = math('<msub><mo>∑</mo><mi>i</mi></msub>');
  assert.deepEqual(applyOMMLLimits(input, { naries: [limits('∑', null)] }), { html: input, changes: [], warnings: [] });
  const missing = applyOMMLLimits(input, { naries: [limits(null, 'undOvr')] });
  assert.equal(missing.html, input);
  assert.equal(missing.warnings.length, 1);
});

test('one-sided bounds map in both directions and malformed script candidates remain untouched', () => {
  for (const [before, after, location] of [['msub', 'munder', 'undOvr'], ['msup', 'mover', 'undOvr'], ['munder', 'msub', 'subSup'], ['mover', 'msup', 'subSup']]) {
    const result = apply(`<${before}><mo>∑</mo><mi>i</mi></${before}>`, [limits('∑', location)]);
    assert.equal(load(result.html, { xmlMode: true })(after).length, 1);
  }
  const input = math('<msubsup><mo>∑</mo><mi>i</mi></msubsup>');
  const result = applyOMMLLimits(input, { naries: [limits('∑', 'undOvr')] });
  assert.equal(result.html, input);
  assert.equal(result.warnings.length, 1);
});

test('TeX restoration encodes each source location while retaining ordinary variable scripts', () => {
  const tex = String.raw`x_t^2 + \sum_{i=1}^{3} a_i + \prod_{j=1}^{4} b_j`;
  const result = applyOMMLLimitCommands(tex, { naries: [limits('∑', 'undOvr'), limits('∏', 'subSup')] });
  assert.equal(result.tex, String.raw`x_t^2 + \sum\limits_{i=1}^{3} a_i + \prod\nolimits_{j=1}^{4} b_j`);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(result.warnings, []);
});

test('existing TeX limit commands are replaced or kept without duplicating flags or losing whitespace', () => {
  const input = String.raw`\sum \nolimits _{i=1}^{3} + \int\limits_0^1 + \prod\displaylimits_{j=1}^{4}`;
  const result = applyOMMLLimitCommands(input, { naries: [limits('∑', 'undOvr'), limits('∫', 'subSup'), limits('∏', 'undOvr')] });
  assert.equal(result.tex, String.raw`\sum \limits _{i=1}^{3} + \int\nolimits_0^1 + \prod\limits_{j=1}^{4}`);
  const repeat = applyOMMLLimitCommands(result.tex, { naries: [limits('∑', 'undOvr'), limits('∫', 'subSup'), limits('∏', 'undOvr')] });
  assert.deepEqual(repeat, { tex: result.tex, changes: [], warnings: [] });
});

test('TeX candidate counts and symbols must match before any command changes', () => {
  const tex = String.raw`\sum_{i=1}^{3}`;
  for (const naries of [[limits('∏', 'undOvr')], [limits('∑', 'undOvr'), limits('∫', 'subSup')], [limits('★', 'undOvr')]]) {
    const result = applyOMMLLimitCommands(tex, { naries });
    assert.equal(result.tex, tex);
    assert.deepEqual(result.changes, []);
    assert.equal(result.warnings.length, 1);
  }
});

test('TeX matching excludes escaped slashes and longer command names and rejects duplicate modifiers', () => {
  const tex = String.raw`\\sum \summation x + \sum_{i=1}^{3}`;
  const result = applyOMMLLimitCommands(tex, { naries: [limits('∑', 'undOvr')] });
  assert.equal(result.tex, String.raw`\\sum \summation x + \sum\limits_{i=1}^{3}`);
  const ambiguous = String.raw`\sum\limits\nolimits_{i=1}^{3}`;
  const kept = applyOMMLLimitCommands(ambiguous, { naries: [limits('∑', 'undOvr')] });
  assert.equal(kept.tex, ambiguous);
  assert.equal(kept.warnings.length, 1);
});

test('TeX restoration respects unknown source locations and integral command distinctions', () => {
  const tex = String.raw`\iint_A f + \oint_C g + \bigcup_i A_i`;
  const result = applyOMMLLimitCommands(tex, { naries: [limits('∬', 'undOvr'), limits('∮', null), limits('⋃', 'subSup')] });
  assert.equal(result.tex, String.raw`\iint\limits_A f + \oint_C g + \bigcup\nolimits_i A_i`);
  assert.equal(result.changes.length, 2);
  const missing = applyOMMLLimitCommands(tex, { naries: [limits('∬', null)] });
  assert.deepEqual(missing, { tex, changes: [], warnings: [] });
});
