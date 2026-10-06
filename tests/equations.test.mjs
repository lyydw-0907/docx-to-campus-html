import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeEquationParagraph, analyzeStandaloneMathParagraph, cleanIncompleteEquationMarker } from '../src/equations.mjs';

const math = (tex, mode = 'DisplayMath') => ({ t: 'Math', c: [{ t: mode }, tex] });
const str = c => ({ t: 'Str', c });

test('source font spans around number text preserve standalone equation detection', () => {
  const formula = math('x+y');
  const number = { t: 'Span', c: [['', [], [['style', 'font-size:20px']]], [str('(7)')]] };
  const plan = analyzeEquationParagraph([formula, number]);
  assert.equal(plan.math, formula);
  assert.equal(plan.number, '(7)');
  const bad = { t: 'Span', c: [['', [], []], [{ t: 'Image', c: [] }]] };
  assert.equal(analyzeEquationParagraph([formula, bad]), null);
});

test('only a source-confirmed single Word equation array with a completed statement cleans a bare marker', () => {
  const tex = String.raw`\begin{array}{r}F=x+1.\#\end{array}`;
  assert.deepEqual(cleanIncompleteEquationMarker(tex, { eqArrSingleRow: true }), { renderTex: 'F=x+1.', wrapperRemoved: 'single-row-array', kind: 'incomplete-word-number-marker-removed' });
  assert.equal(cleanIncompleteEquationMarker(tex, { eqArrSingleRow: false }), null);
  for (const body of [String.raw`F=x+1\#`, String.raw`F=x+1.\#(2`, String.raw`F=x+1.\#(2)`, String.raw`F=\#`, String.raw`F=x.\\G=y.\#`, String.raw`F=x&\#`, String.raw`F=\text{\#}.`]) {
    assert.equal(cleanIncompleteEquationMarker(`\\begin{array}{r}${body}\\end{array}`, { eqArrSingleRow: true }), null, body);
  }
  assert.equal(cleanIncompleteEquationMarker(String.raw`F=x+1.\#`, { eqArrSingleRow: true }), null);
});

test('complete Word hash markers leave the source AST unchanged', () => {
  const node = math(String.raw`\theta_{t}=\theta_{0}+\eta\ln(1+s),\eta>0.\#(1)`);
  const original = structuredClone(node);
  const plan = analyzeEquationParagraph([node]);
  assert.equal(plan.math, node);
  assert.equal(plan.renderTex, String.raw`\theta_{t}=\theta_{0}+\eta\ln(1+s),\eta>0.`);
  assert.equal(plan.number, '(1)');
  assert.equal(plan.markerSource, 'math-tail');
  assert.equal(plan.display, true);
  assert.deepEqual(node, original);
});

test('fullwidth labels and Word escaped spaces retain label characters', () => {
  assert.equal(analyzeEquationParagraph([math('x=1＃（２）')]).number, '（２）');
  assert.equal(analyzeEquationParagraph([math(String.raw`x=1\ \#\ (\ 3\ )\ `)]).number, '( 3 )');
  assert.equal(analyzeEquationParagraph([math(String.raw`x=1\ \#\ (\ 3\ )\ `)]).renderTex, 'x=1');
  assert.equal(analyzeEquationParagraph([math(String.raw`x=1\#(2.3)`)]).number, '(2.3)');
  assert.equal(analyzeEquationParagraph([math(String.raw`x=1\#(2-3)`)]).number, '(2-3)');
});

test('paragraph hash labels accept separate formatted runs', () => {
  const node = math('x=1');
  const plan = analyzeEquationParagraph([node, { t: 'Space' }, { t: 'Strong', c: [str('#(')] }, { t: 'Emph', c: [str('5)')] }]);
  assert.equal(plan.number, '(5)');
  assert.equal(plan.renderTex, 'x=1');
  assert.equal(plan.markerSource, 'paragraph-text');
  assert.equal(analyzeEquationParagraph([node, str('＃（５）')]).number, '（５）');
});

test('existing separate digit and parenthesized labels keep their text', () => {
  for (const label of ['(1)', '（１）', '2', '2.1', '(2-1)']) {
    assert.equal(analyzeEquationParagraph([math('x=1'), str(label)]).number, label);
  }
  const node = math('x=1');
  assert.deepEqual(analyzeEquationParagraph([node]), { math: node, number: '', renderTex: 'x=1', display: true });
  assert.equal(analyzeEquationParagraph([math('f(x)=(1)')]).number, '');
});

test('a standalone inline equation is promoted only with an explicit hash label', () => {
  assert.equal(analyzeEquationParagraph([math(String.raw`x=1\#(1)`, 'InlineMath')]).display, true);
  assert.equal(analyzeEquationParagraph([math('x=1', 'InlineMath'), str('#(2)')]).number, '(2)');
  assert.equal(analyzeEquationParagraph([math('x=1', 'InlineMath')]), null);
  assert.equal(analyzeEquationParagraph([math('x=1', 'InlineMath'), str('(2)')]), null);
  assert.equal(analyzeEquationParagraph([str('其中'), math(String.raw`x=1\#(1)`, 'InlineMath'), str('成立')]), null);
});

test('complete markers outside arrays preserve their entire mathematical body', () => {
  const body = String.raw`\begin{array}{r}x=1\\y=2\end{array}`;
  const plan = analyzeEquationParagraph([math(body + String.raw`\#(10)`)]);
  assert.equal(plan.number, '(10)');
  assert.equal(plan.renderTex, body);
  assert.equal(analyzeEquationParagraph([math(String.raw`\{x=1\}\#(2)`)]).renderTex, String.raw`\{x=1\}`);
});

test('single-row single-column equation arrays separate an explicit tail number', () => {
  const tex = '\\begin{array}{r}\nx=1\\#(1)\n\\end{array}';
  const node = math(tex);
  const original = structuredClone(node);
  const plan = analyzeEquationParagraph([node]);
  assert.equal(plan.math, node);
  assert.equal(plan.number, '(1)');
  assert.equal(plan.renderTex, 'x=1');
  assert.equal(plan.wrapperRemoved, 'single-row-array');
  assert.equal(plan.markerSource, 'math-tail');
  assert.equal(plan.display, true);
  assert.deepEqual(node, original);
  const fullwidth = analyzeEquationParagraph([math(String.raw`\begin{array}{r}x=1＃（２）\end{array}`)]);
  assert.equal(fullwidth.number, '（２）');
  assert.equal(fullwidth.renderTex, 'x=1');
  const inline = analyzeEquationParagraph([math(tex, 'InlineMath')]);
  assert.equal(inline.display, true);
  assert.equal(inline.wrapperRemoved, 'single-row-array');
  assert.equal(analyzeEquationParagraph([math(String.raw`\begin{array}{r}x=\&+1\#(2)\end{array}`)]).renderTex, String.raw`x=\&+1`);
});

test('actual matrices, multiple rows and repeated equation-array labels stay intact', () => {
  for (const tex of [
    String.raw`\begin{array}{r}x&=1\#(1)\end{array}`,
    String.raw`\begin{array}{rr}x=1\#(1)\end{array}`,
    String.raw`\begin{array}{r}x=1\\y=2\#(2)\end{array}`,
    String.raw`\begin{array}{r}x=1\#(1)\\y=2\#(2)\end{array}`,
    String.raw`\begin{array}{r}\begin{matrix}1&2\end{matrix}\#(1)\end{array}`,
    String.raw`\begin{array}{r}\begin{array}{r}x=1\end{array}\#(1)\end{array}`,
    String.raw`\begin{array}{r}x=1\#(1)\#(2)\end{array}`,
    String.raw`\begin{array}{r}x=1\#\end{array}`,
    String.raw`\begin{array}{r}x=\#(1)\end{array}`,
    String.raw`\begin{array}{r}x=\text{\#(1)}\end{array}`,
    String.raw`x+\begin{array}{r}y=1\#(1)\end{array}`,
  ]) assert.equal(analyzeEquationParagraph([math(tex)]), null, tex);
  const numbered = String.raw`\begin{array}{r}x=1\#(1)\end{array}`;
  assert.equal(analyzeEquationParagraph([str('其中'), math(numbered, 'InlineMath'), str('成立')]), null);
  assert.equal(analyzeEquationParagraph([math(numbered), str('(1)')]), null);
  assert.equal(analyzeEquationParagraph([math(String.raw`\begin{array}{r}x=1\end{array}`, 'InlineMath')]), null);
});

test('hashes inside groups, text, arrays and multiple rows are preserved', () => {
  for (const tex of [
    String.raw`x=\text{\#(1)}`,
    String.raw`{x=1\#(1)}`,
    String.raw`\begin{array}{r}x=1\#(1)\\y=2\#(2)\end{array}`,
    String.raw`\begin{array}{r}x=1\\\#(2)\end{array}`,
    String.raw`x=1\\y=2\#(2)`,
    String.raw`f(x\#(1))=0`,
  ]) assert.equal(analyzeEquationParagraph([math(tex)]), null, tex);
});

test('empty or incomplete mathematical operands are never removed', () => {
  for (const tex of [
    String.raw`\#(1)`, String.raw`=\#(1)`, String.raw`f(x)=\#(15)`,
    String.raw`x+\#(1)`, String.raw`x-\#(1)`, String.raw`x*\#(1)`,
    String.raw`x\cdot\#(1)`, String.raw`f(x\#(1)`,
  ]) assert.equal(analyzeEquationParagraph([math(tex)]), null, tex);
  assert.equal(analyzeEquationParagraph([math('x='), str('#(1)')]), null);
});

test('incomplete, repeated and nonnumeric labels are never removed', () => {
  for (const tex of [
    String.raw`x=1\#`, String.raw`x=1\#()`, String.raw`x=1\#(A)`,
    String.raw`x=1\#(1`, String.raw`x=1\#(1)\#(2)`,
    String.raw`x=1\#(1) prose`, String.raw`x=1\#1`,
  ]) assert.equal(analyzeEquationParagraph([math(tex)]), null, tex);
  for (const label of ['#', '#(1', '#(A)', '#(1)#(2)', '(1) prose']) {
    assert.equal(analyzeEquationParagraph([math('x=1'), str(label)]), null, label);
  }
  assert.equal(analyzeEquationParagraph([math(String.raw`x=1\#(1)`), str('(1)')]), null);
});

test('a hash operand after relation or binary operators is not converted into a number', () => {
  for (const operator of [String.raw`\sim`, String.raw`\simeq`, String.raw`\otimes`, String.raw`\oplus`, String.raw`\propto`, String.raw`\subseteq`, '∼', '≃', '≅', '∝', '⊕', '⊗']) {
    const tex = `x${operator}\\#(2)`;
    assert.equal(analyzeEquationParagraph([math(tex)]), null, tex);
    assert.equal(analyzeEquationParagraph([math(tex, 'InlineMath')]), null, tex);
  }
});

test('unsupported paragraph content and invalid TeX structure stay untouched', () => {
  for (const inlines of [
    [math('x=1'), math('y=2')],
    [math('x=1'), { t: 'Image', c: [] }],
    [math('x=1'), { t: 'Strong', c: [{ t: 'Code', c: [] }] }],
    [math(String.raw`x={1\#(2)`)],
    [math(String.raw`\begin{array}{r}x=1\end{matrix}\#(2)`)],
    [math(String.raw`\begin x=1\#(2)`)],
    [{ t: 'Math', c: [{ t: 'DisplayMath' }, ''] }],
  ]) assert.equal(analyzeEquationParagraph(inlines), null);
});

test('standalone alignment identifies an inline equation with trailing empty font spans without changing its math mode', () => {
  const formula = math(String.raw`e_i^{T*}=\frac{a}{b}`, 'InlineMath');
  const emptyFont = { t: 'Span', c: [['', [], [['style', 'font-size:14px']]], [str('\u00a0')]] };
  const inlines = [{ t: 'Space' }, formula, { t: 'Space' }, emptyFont];
  const before = structuredClone(inlines);
  assert.deepEqual(analyzeStandaloneMathParagraph(inlines), { math: formula });
  assert.deepEqual(inlines, before);
  assert.equal(formula.c[0].t, 'InlineMath');
  assert.equal(analyzeEquationParagraph(inlines), null);
});

test('standalone alignment retains nested source font spans, mathematical content and terminal punctuation', () => {
  for (const punctuation of ['.', '。', ',', '，', ';', '；']) {
    const formula = math('x=1', 'InlineMath');
    const formulaSpan = { t: 'Span', c: [['original', ['source-font'], [['style', 'font-size:20px']]], [formula]] };
    const punctuationSpan = { t: 'Span', c: [['', [], [['style', 'font-size:14px']]], [{ t: 'Strong', c: [str(punctuation)] }]] };
    const inlines = [formulaSpan, punctuationSpan];
    const before = structuredClone(inlines);
    assert.equal(analyzeStandaloneMathParagraph(inlines).math, formula);
    assert.deepEqual(inlines, before);
    assert.equal(punctuationSpan.c[1][0].c[0].c, punctuation);
  }
});

test('standalone alignment refuses prose, leading punctuation and numeric labels so existing numbering remains separate', () => {
  for (const tail of ['成立', '其中', '(1)', '（１）', '#(2)', '＃（３）', '2', '2.1', '(2-1)']) {
    assert.equal(analyzeStandaloneMathParagraph([math('x=1', 'InlineMath'), str(tail)]), null, tail);
  }
  assert.equal(analyzeStandaloneMathParagraph([str('其中'), math('x=1')]), null);
  assert.equal(analyzeStandaloneMathParagraph([str('.'), math('x=1')]), null);
  const formula = math('x=1');
  const numbered = [formula, str('(1)')];
  assert.equal(analyzeStandaloneMathParagraph(numbered), null);
  assert.equal(analyzeEquationParagraph(numbered).number, '(1)');
});

test('standalone alignment rejects multiple mathematics, images and unknown content including inside formatted spans', () => {
  const wrap = inlines => ({ t: 'Span', c: [['', [], []], inlines] });
  for (const inlines of [
    [], [str(' ')], [math('x=1'), math('y=2')], [wrap([math('x=1'), math('y=2')])],
    [math('x=1'), { t: 'Image', c: [] }], [math('x=1'), wrap([{ t: 'Image', c: [] }])],
    [math('x=1'), { t: 'RawInline', c: ['html', ''] }], [math('x=1'), { t: 'Code', c: [] }],
    [math('x=1'), { t: 'Note', c: [] }], [math('x=1'), { t: 'Unknown', c: [] }],
    [math('x=1'), { t: 'Span', c: [] }], [null], [math('', 'InlineMath')], [math('x=1', 'OtherMath')],
  ]) assert.equal(analyzeStandaloneMathParagraph(inlines), null);
});

test('standalone alignment accepts display mathematics and explicit whitespace without rewriting the original inlines', () => {
  const formula = math(String.raw`\sum_{i=1}^{n}x_i`, 'DisplayMath');
  const inlines = [{ t: 'SoftBreak' }, { t: 'Emph', c: [str('\t ')] }, formula, { t: 'LineBreak' }];
  const before = structuredClone(inlines);
  assert.equal(analyzeStandaloneMathParagraph(inlines).math, formula);
  assert.deepEqual(inlines, before);
});
