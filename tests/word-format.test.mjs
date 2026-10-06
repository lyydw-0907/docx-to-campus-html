import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { prepareWordFormatting, restoreWordFormatting } from '../src/word-format.mjs';
import { makeDemoDocx } from '../src/fixtures.mjs';
import { resolvePandocPath } from '../src/convert.mjs';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const styles = content => `<w:styles xmlns:w="${WORD_NS}">${content}</w:styles>`;
const defaults = '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="1"><w:name w:val="默认正文"/></w:style>';
const run = (text, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`;
const paragraph = (text, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${text}</w:p>`;
const mathRun = size => `<m:r>${size ? `<w:rPr><w:sz w:val="${size}"/></w:rPr>` : ''}<m:t>x</m:t></m:r>`;
const equation = (controlSize, runSize) => `<m:oMath><m:sSup><m:sSupPr>${controlSize ? `<m:ctrlPr><w:rPr><w:sz w:val="${controlSize}"/></w:rPr></m:ctrlPr>` : ''}</m:sSupPr><m:e>${mathRun(runSize)}</m:e><m:sup>${mathRun(runSize)}</m:sup></m:sSup></m:oMath>`;
const mathNode = tex => ({ t: 'Math', c: [{ t: 'InlineMath' }, tex] });
const textNode = text => ({ t: 'Str', c: text });
const attributes = label => ['', [], [['custom-style', label]]];
const wrapper = (label, blocks) => ({ t: 'Div', c: [attributes(label), blocks] });
const span = (label, inlines) => ({ t: 'Span', c: [attributes(label), inlines] });

async function document(body, styleXml = styles(defaults), extra = {}) {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const original = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', original.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`));
  if (styleXml === null) {
    zip.remove('word/styles.xml');
    zip.remove('word/_rels/document.xml.rels');
    const types = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', types.replace(/<Override PartName="\/word\/styles.xml"[^>]*\/>/, ''));
  } else zip.file('word/styles.xml', styleXml);
  for (const [name, data] of Object.entries(extra)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const formats = prepared => [...prepared.paragraphFormats.values()];
const labels = prepared => [...prepared.paragraphFormats.keys()];
function allNodes(value, type) {
  if (Array.isArray(value)) return value.flatMap(item => allNodes(item, type));
  if (!value || typeof value !== 'object') return [];
  return [...(value.t === type ? [value] : []), ...Object.values(value).flatMap(item => allNodes(item, type))];
}

test('resolves document defaults, actual default style ID, basedOn properties and direct zero resets', async () => {
  const styleXml = styles(defaults +
    '<w:style w:type="paragraph" w:styleId="Base"><w:name w:val="正文基类"/><w:basedOn w:val="1"/><w:pPr><w:ind w:firstLineChars="200" w:left="240" w:right="360"/><w:jc w:val="both"/></w:pPr><w:rPr><w:sz w:val="30"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="继承正文"/><w:basedOn w:val="Base"/><w:pPr><w:ind w:left="480"/></w:pPr></w:style>');
  const input = await document(paragraph(run('Synthetic'), '<w:pStyle w:val="Derived"/><w:ind w:right="0"/>'), styleXml);
  const before = Buffer.from(input);
  const prepared = await prepareWordFormatting(input, { fontMode: 'word', fontSize: 16 });
  assert.deepEqual(input, before);
  assert.equal(formats(prepared)[0].css, 'font-size:20px;text-align:justify;text-indent:2em;margin-left:32px;margin-right:0px');
  const zip = await JSZip.loadAsync(prepared.input);
  const $styles = load(await zip.file('word/styles.xml').async('string'), { xmlMode: true });
  const newStyle = $styles('w\\:style').toArray().find(style => style.attribs['w:styleId'] === labels(prepared)[0]);
  assert.equal($styles(newStyle).children('w\\:basedOn').attr('w:val'), 'Derived');
  const defaultPrepared = await prepareWordFormatting(await document(paragraph(run('Default'))), { fontMode: 'word' });
  const defaultZip = await JSZip.loadAsync(defaultPrepared.input);
  const defaultStyles = await defaultZip.file('word/styles.xml').async('string');
  assert.match(defaultStyles, /<w:basedOn w:val="1"\/>/);
});

test('inherits each indentation attribute and prioritizes character units and hanging indentation', async () => {
  const body = paragraph(run('Indented'), '<w:ind w:firstLine="480" w:firstLineChars="200" w:hanging="180" w:hangingChars="150" w:left="540" w:leftChars="250" w:right="240"/>') +
    paragraph(run('Reset'), '<w:ind w:firstLineChars="0" w:hangingChars="0" w:leftChars="0"/>');
  const prepared = await prepareWordFormatting(await document(body), { fontMode: 'uniform', fontSize: 18 });
  assert.equal(formats(prepared)[0].css, 'text-indent:-1.5em;margin-left:2.5em;margin-right:16px');
  assert.equal(formats(prepared)[1].css, 'text-indent:0em;margin-left:0em');
});

test('paragraph mark run properties do not become text or math font defaults', async () => {
  const prepared = await prepareWordFormatting(await document(paragraph(run('Text') + equation(), '<w:rPr><w:sz w:val="144"/></w:rPr>')), { fontMode: 'word' });
  assert.equal(formats(prepared)[0].fontSize, 16);
  assert.deepEqual(formats(prepared)[0].mathFontSizes, [16]);
  assert.equal([...prepared.runFormats.values()][0].fontSize, 16);
  assert.equal(prepared.warnings.length, 0);
});

test('restores mixed text sizes and inherited character styles without changing the paragraph indent base', async () => {
  const styleXml = styles(defaults + '<w:style w:type="character" w:styleId="Small"><w:name w:val="小字"/><w:rPr><w:sz w:val="21"/></w:rPr></w:style><w:style w:type="character" w:styleId="Child"><w:name w:val="继承小字"/><w:basedOn w:val="Small"/></w:style>');
  const prepared = await prepareWordFormatting(await document(paragraph(run('A', '<w:rStyle w:val="Child"/>') + run('B', '<w:sz w:val="31"/>'), '<w:ind w:firstLineChars="200"/>'), styleXml), { fontMode: 'word' });
  const runLabels = [...prepared.runFormats.keys()];
  const para = { t: 'Para', c: [span(runLabels[0], [textNode('A')]), span(runLabels[1], [textNode('B')])] };
  const ast = { blocks: [wrapper(labels(prepared)[0], [para])] };
  const restored = restoreWordFormatting(ast, prepared);
  assert.equal(ast.blocks[0], para);
  assert.equal(restored.paragraphStyles.get(para), 'font-size:16px;text-indent:2em');
  assert.deepEqual(para.c.map(node => node.c[0]), [['', [], [['style', 'font-size:14px;font-weight:normal']]], ['', [], [['style', 'font-size:20.667px;font-weight:normal']]]]);
  assert.doesNotMatch(JSON.stringify(ast), /CampusFormatting|custom-style/);
});

test('uniform mode removes source font sizes and retains source bold, indentation and alignment', async () => {
  const prepared = await prepareWordFormatting(await document(paragraph(run('Bold', '<w:b/><w:sz w:val="42"/>') + equation(30), '<w:jc w:val="center"/><w:ind w:firstLine="240"/>')), { fontMode: 'uniform', fontSize: 18 });
  const math = mathNode('x^x');
  const bold = { t: 'Strong', c: [textNode('Bold')] };
  const para = { t: 'Para', c: [span([...prepared.runFormats.keys()][0], [bold]), math] };
  const ast = { blocks: [wrapper(labels(prepared)[0], [para])] };
  const restored = restoreWordFormatting(ast, prepared);
  assert.equal(para.c[0].t, 'Strong');
  assert.equal(para.c[0].c[0].c[0][2][0][1], 'font-weight:bold');
  assert.deepEqual(para.c[0].c[0].c[1], [textNode('Bold')]);
  assert.equal(para.c[1], math);
  assert.equal(restored.paragraphStyles.get(para), 'text-align:center;text-indent:16px');
  assert.equal(restored.mathFontSizes.get(math), 18);
});

test('uses consistent native control or mathematical run sizes without changing OMML internals', async () => {
  const sourceMath = equation(30, 24) + equation(undefined, 27) + equation();
  const input = await document(paragraph(sourceMath));
  const prepared = await prepareWordFormatting(input, { fontMode: 'word', fontSize: 14 });
  assert.deepEqual(formats(prepared)[0].mathFontSizes, [20, 18, 16]);
  const before = await (await JSZip.loadAsync(input)).file('word/document.xml').async('string');
  const after = await (await JSZip.loadAsync(prepared.input)).file('word/document.xml').async('string');
  assert.deepEqual(after.match(/<m:oMath>[\s\S]*?<\/m:oMath>/g), before.match(/<m:oMath>[\s\S]*?<\/m:oMath>/g));
  const maths = [mathNode('a'), mathNode('b'), mathNode('c')];
  const ast = { blocks: [wrapper(labels(prepared)[0], [{ t: 'Para', c: maths }])] };
  assert.deepEqual([...restoreWordFormatting(ast, prepared).mathFontSizes.values()], [20, 18, 16]);
});

test('a paragraph math-count mismatch falls back for every formula rather than shifting source sizes', async () => {
  const prepared = await prepareWordFormatting(await document(paragraph(equation(21) + equation(30))), { fontMode: 'word' });
  const math = mathNode('only-one-survived');
  const ast = { blocks: [wrapper(labels(prepared)[0], [{ t: 'Para', c: [math] }])] };
  const restored = restoreWordFormatting(ast, prepared);
  assert.equal(restored.mathFontSizes.get(math), 16);
  assert.match(restored.warnings.join('\n'), /所有公式使用段落字号/);
});

test('math-only font spans unwrap while confirmed native control sizes remain authoritative', async () => {
  const prepared = await prepareWordFormatting(await document(paragraph(run('Source', '<w:sz w:val="21"/>') + equation(30))), { fontMode: 'word' });
  const math = mathNode('x');
  const para = { t: 'Para', c: [span([...prepared.runFormats.keys()][0], [math])] };
  const ast = { blocks: [wrapper(labels(prepared)[0], [para])] };
  const restored = restoreWordFormatting(ast, prepared);
  assert.deepEqual(para.c, [math]);
  assert.equal(restored.mathFontSizes.get(math), 20);
});

test('restores Header style, table Plain paragraphs and centered captions while retaining structural attributes', async () => {
  const input = await document(paragraph(run('Heading'), '<w:jc w:val="right"/>') + paragraph(run('Cell'), '<w:ind w:left="120"/>') + paragraph(run('Caption'), '<w:jc w:val="center"/>'));
  const prepared = await prepareWordFormatting(input, { fontMode: 'word' });
  const [headingLabel, cellLabel, captionLabel] = labels(prepared);
  const header = { t: 'Header', c: [1, ['original-id', ['keep-class', headingLabel], [['data-test', 'keep'], ['custom-style', headingLabel]]], [textNode('Heading')]] };
  const cell = { t: 'Plain', c: [textNode('Cell')] };
  const caption = { t: 'Para', c: [textNode('Caption')] };
  const table = { t: 'Table', c: [{ blocks: [wrapper(cellLabel, [cell])] }] };
  const ast = { blocks: [header, table, wrapper(captionLabel, [caption])] };
  const restored = restoreWordFormatting(ast, prepared);
  assert.equal(header.t, 'Header');
  assert.deepEqual(header.c[1], ['original-id', ['keep-class'], [['data-test', 'keep'], ['style', 'font-size:16px;text-align:right;font-weight:normal']]]);
  assert.equal(ast.blocks[1], table);
  assert.equal(table.c[0].blocks[0], cell);
  assert.equal(restored.paragraphStyles.get(cell), 'font-size:16px;margin-left:8px');
  assert.equal(restored.paragraphStyles.get(caption), 'font-size:16px;text-align:center');
});

test('footnote mathematics has its own font sequence and empty paragraphs do not create unmatched-text warnings', async () => {
  const notes = `<w:footnotes xmlns:w="${WORD_NS}" xmlns:m="${MATH_NS}"><w:footnote w:type="separator" w:id="-1">${paragraph('')}</w:footnote><w:footnote w:id="1">${paragraph(equation(30))}</w:footnote></w:footnotes>`;
  const prepared = await prepareWordFormatting(await document(paragraph(equation(21)) + paragraph(''), styles(defaults), { 'word/footnotes.xml': notes }), { fontMode: 'word' });
  const [bodyLabel, , noteLabel] = labels(prepared);
  const bodyMath = mathNode('body');
  const noteMath = mathNode('note');
  const note = { t: 'Note', c: [wrapper(noteLabel, [{ t: 'Para', c: [noteMath] }])] };
  const ast = { blocks: [wrapper(bodyLabel, [{ t: 'Para', c: [bodyMath, note] }])] };
  const restored = restoreWordFormatting(ast, prepared);
  assert.equal(restored.mathFontSizes.get(bodyMath), 14);
  assert.equal(restored.mathFontSizes.get(noteMath), 20);
  assert.equal(restored.summary.unmatchedParagraphs, 0);
  assert.equal(restored.summary.unmatchedEmptyParagraphs, 1);
  assert.equal(restored.warnings.length, 0);
});

test('missing defaults and cyclic or unavailable styles are bounded and preserve direct formatting', async () => {
  const styleXml = styles('<w:style w:type="paragraph" w:styleId="A"><w:name w:val="A"/><w:basedOn w:val="B"/></w:style><w:style w:type="paragraph" w:styleId="B"><w:name w:val="B"/><w:basedOn w:val="A"/></w:style>');
  const body = paragraph(run('Cycle'), '<w:pStyle w:val="A"/><w:ind w:firstLineChars="200"/>') + paragraph(run('Missing'), '<w:pStyle w:val="Missing"/><w:jc w:val="center"/>');
  const prepared = await prepareWordFormatting(await document(body, styleXml), { fontMode: 'word', fontSize: 18 });
  assert.deepEqual(formats(prepared).map(format => format.css), ['font-size:18px;text-indent:2em', 'font-size:18px;text-align:center']);
  assert.match(prepared.warnings.join('\n'), /循环/);
  assert.match(prepared.warnings.join('\n'), /缺失/);
});

test('invalid source font sizes and unsupported alignment warn and use the selected font fallback', async () => {
  const styleXml = styles(defaults + '<w:style w:type="paragraph" w:styleId="Huge"><w:name w:val="Huge"/><w:rPr><w:sz w:val="144"/></w:rPr></w:style>');
  const prepared = await prepareWordFormatting(await document(paragraph(run('Fallback', '<w:sz w:val="bogus"/>'), '<w:pStyle w:val="Huge"/><w:jc w:val="distribute"/>'), styleXml), { fontMode: 'word', fontSize: 14 });
  assert.equal(formats(prepared)[0].css, 'font-size:14px');
  assert.equal([...prepared.runFormats.values()][0].fontSize, 14);
  assert.match(prepared.warnings.join('\n'), /范围内的字号/);
  assert.match(prepared.warnings.join('\n'), /无法精确恢复的段落对齐/);
  await assert.rejects(prepareWordFormatting(await document(paragraph(run('Mode'))), { fontMode: 'unknown' }), /word 或 uniform/);
});

test('legal DOCX without a styles part receives its relationship and content-type entry', async () => {
  const prepared = await prepareWordFormatting(await document(paragraph(run('No styles')), null), { fontMode: 'word', fontSize: 14 });
  const zip = await JSZip.loadAsync(prepared.input);
  assert.ok(zip.file('word/styles.xml'));
  assert.match(await zip.file('word/_rels/document.xml.rels').async('string'), /relationships\/styles/);
  assert.match(await zip.file('[Content_Types].xml').async('string'), /PartName="\/word\/styles\.xml"/);
  assert.equal(formats(prepared)[0].fontSize, 14);
});

test('namespace aliases and Unicode style IDs retain inheritance without modifying source math', async () => {
  const body = paragraph(run('Aliases') + equation(30), '<w:pStyle w:val="正文样式"/>');
  const input = await document(body, styles(defaults + '<w:style w:type="paragraph" w:styleId="正文样式"><w:name w:val="中文显示名"/><w:basedOn w:val="1"/><w:pPr><w:ind w:firstLineChars="200"/></w:pPr></w:style>'));
  const zip = await JSZip.loadAsync(input);
  for (const name of ['word/document.xml', 'word/styles.xml']) zip.file(name, (await zip.file(name).async('string')).replaceAll('xmlns:w=', 'xmlns:q=').replaceAll('w:', 'q:'));
  const aliased = await zip.generateAsync({ type: 'nodebuffer' });
  const prepared = await prepareWordFormatting(aliased, { fontMode: 'word' });
  assert.equal(formats(prepared)[0].css, 'font-size:16px;text-indent:2em');
  assert.deepEqual(formats(prepared)[0].mathFontSizes, [20]);
  assert.equal(prepared.warnings.length, 0);
  const output = await JSZip.loadAsync(prepared.input);
  const $ = load(await output.file('word/styles.xml').async('string'), { xmlMode: true });
  assert.equal($('w\\:style').filter((_, node) => node.attribs['w:styleId'] === labels(prepared)[0]).children('w\\:basedOn').attr('w:val'), '正文样式');
});

let pandocPath;
try { pandocPath = await resolvePandocPath(); execFileSync(pandocPath, ['--version'], { windowsHide: true, stdio: 'ignore' }); }
catch { pandocPath = undefined; }

test('real Pandoc keeps heading, list and table semantics while temporary formatting labels are removed', { skip: pandocPath ? false : 'Pandoc unavailable' }, async () => {
  const styleXml = styles(defaults + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="32"/></w:rPr></w:style>');
  const table = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr/>${paragraph(run('Cell'), '<w:ind w:firstLineChars="100"/>')}</w:tc></w:tr></w:tbl>`;
  const body = paragraph(run('Heading'), '<w:pStyle w:val="Heading1"/>') + paragraph(run('List item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') + table + paragraph(equation(30));
  const numbering = `<w:numbering xmlns:w="${WORD_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const prepared = await prepareWordFormatting(await document(body, styleXml, { 'word/numbering.xml': numbering }), { fontMode: 'word' });
  const ast = JSON.parse(execFileSync(pandocPath, ['--from=docx+styles', '--to=json'], { input: prepared.input, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).toString());
  const restored = restoreWordFormatting(ast, prepared);
  assert.equal(allNodes(ast.blocks, 'Header').length, 1);
  assert.equal(allNodes(ast.blocks, 'BulletList').length, 1);
  assert.equal(allNodes(ast.blocks, 'Table').length, 1);
  assert.equal(allNodes(ast.blocks, 'Math').length, 1);
  assert.equal([...restored.mathFontSizes.values()][0], 20);
  assert.ok([...restored.paragraphStyles.values()].some(css => css.includes('text-indent:1em')));
  assert.doesNotMatch(JSON.stringify(ast), /CampusFormatting/);
});
