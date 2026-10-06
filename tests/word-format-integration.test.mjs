import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { makeDemoDocx } from '../src/fixtures.mjs';
import { convertDocx, resolvePandocPath, sanitizeHtml } from '../src/convert.mjs';

let available = true;
try { await promisify(execFile)(await resolvePandocPath(), ['--version']); } catch { available = false; }
const requiresPandoc = { skip: available ? false : 'Install Pandoc to verify actual Word formatting conversion.' };
const xmlText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const run = (text, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
const p = (content, properties = '') => `<w:p><w:pPr>${properties}</w:pPr>${content}</w:p>`;

async function formattedDocx() {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const original = await zip.file('word/document.xml').async('string');
  const inline = original.match(/<m:oMath>[\s\S]*?<\/m:oMath>/)[0];
  const display = original.match(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/)[0];
  const drawing = original.match(/<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/)[0];
  const content = [
    p(run('Source heading'), '<w:pStyle w:val="Heading1"/>'),
    p(run('First line paragraph ') + run('large text', '<w:rStyle w:val="Large"/>'), '<w:pStyle w:val="Indented"/>'),
    p(run('Zero first line ') + inline, '<w:pStyle w:val="Indented"/><w:ind w:firstLine="0" w:firstLineChars="0"/>'),
    p(drawing, '<w:jc w:val="center"/><w:ind w:firstLine="0"/>'),
    p(run('Figure caption'), '<w:pStyle w:val="Caption"/>'),
    p(display + run('(7)', '<w:sz w:val="30"/>'), '<w:pStyle w:val="LargeParagraph"/>'),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>${p(run('Table heading'))}</w:tc></w:tr><w:tr><w:tc>${p(run('Cell indented'), '<w:ind w:firstLine="420"/><w:jc w:val="center"/>')}</w:tc></w:tr></w:tbl>`
  ].join('');
  zip.file('word/document.xml', original.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${content}</w:body>`));
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="utf-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Indented"><w:name w:val="Indented"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLineChars="200"/><w:jc w:val="both"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="character" w:styleId="Large"><w:name w:val="Large"/><w:rPr><w:sz w:val="28"/></w:rPr></w:style></w:styles>`);
  const styles = await zip.file('word/styles.xml').async('string');
  zip.file('word/styles.xml', styles.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="LargeParagraph"><w:name w:val="LargeParagraph"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="30"/></w:rPr></w:style></w:styles>'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const scopedStyle = ($, text) => $('p,div').filter((_, node) => $(node).text() === text).last().parents().addBack().map((_, node) => $(node).attr('style') || '').get().join(';');

test('generated indentation and varied math sizes survive safe HTML sanitization', () => {
  const input = '<div style="text-indent:2em;margin-left:0.5em;margin-right:8px;font-size:16px;text-align:center;background-image:url(https://example.test/x)"><p>safe</p></div><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><annotation encoding="application/x-tex">x</annotation></math>';
  const html = sanitizeHtml(input, { fontSize: 14, allowMathML: true, mathMLFormulas: [{ tex: 'x', fontSize: 20 }] });
  assert.match(html, /text-indent:2em/);
  assert.match(html, /margin-left:0.5em/);
  assert.match(html, /margin-right:8px/);
  assert.match(html, /font-size:20px/);
  assert.doesNotMatch(html, /url\(|background-image/);
});

test('source Word paragraph and mixed run formatting survives actual MathML conversion', requiresPandoc, async () => {
  const input = await formattedDocx();
  const result = await convertDocx(input, { formulaFormat: 'mathml', fontMode: 'word', fontSize: 14 });
  const $ = load(result.fragment, null, false);
  assert.equal(result.manifest.options.fontMode, 'word');
  assert.match($('h1').attr('style'), /font-size:21\.333px/);
  assert.match(scopedStyle($, 'First line paragraph large text'), /text-indent:2em/);
  assert.match(scopedStyle($, 'First line paragraph large text'), /text-align:justify/);
  assert.match($('span').filter((_, n) => $(n).text() === 'large text').attr('style'), /font-size:18\.667px/);
  assert.match(scopedStyle($, 'Figure caption'), /text-align:center/);
  assert.match(scopedStyle($, 'Figure caption'), /font-size:13\.333px/);
  assert.match($('img').closest('div[style]').attr('style'), /text-align:center/);
  assert.match(scopedStyle($, 'Cell indented'), /text-indent:28px/);
  assert.equal(result.manifest.formulas.length, 2);
  assert.equal(result.manifest.formulas[0].fontSize, 16);
  assert.equal(result.manifest.formulas[1].fontSize, 20);
  assert.match($('math').first().attr('style'), /font-size:16px/);
  assert.match($('math').last().attr('style'), /font-size:20px/);
  assert.ok($('td').filter((_, n) => $(n).text() === '(7)').length);
  assert.doesNotMatch(result.fragment, /Campus|campus_fmt|custom-style/);
  const again = await convertDocx(input, { formulaFormat: 'mathml', fontMode: 'word', fontSize: 14 });
  assert.equal(again.fragment, result.fragment, 'Original format restoration is deterministic for expired-job recovery');
});

test('uniform size override retains Word alignment and indentation in PNG mode', requiresPandoc, async () => {
  const result = await convertDocx(await formattedDocx(), { formulaFormat: 'png', fontMode: 'uniform', fontSize: 18 });
  const $ = load(result.fragment, null, false);
  assert.deepEqual(result.manifest.formulas.map(f => f.fontSize), [18, 18]);
  assert.equal($('math').length, 0);
  assert.match(scopedStyle($, 'First line paragraph large text'), /text-indent:2em/);
  assert.match(scopedStyle($, 'Figure caption'), /text-align:center/);
  assert.match($('img').filter((_, n) => $(n).attr('alt') === 'x_{1} = \\frac{a + b}{c}').attr('style'), /display:inline-block/);
  assert.ok(result.assets.some(asset => asset.kind === 'formula'));
});

test('lone inline formulas use paragraph centering instead of fixed Word indents in MathML and PNG', requiresPandoc, async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const original = await zip.file('word/document.xml').async('string');
  const inline = original.match(/<m:oMath>[\s\S]*?<\/m:oMath>/)[0];
  const content = [
    p(inline + run('  ', '<w:sz w:val="24"/>'), '<w:jc w:val="both"/><w:ind w:firstLineChars="1400" w:rightChars="50"/>'),
    p(inline + run('. ', '<w:sz w:val="24"/>'), '<w:jc w:val="both"/><w:ind w:firstLineChars="400" w:left="120"/>'),
    p(run('In context ') + inline + run(' remains inline.'), '<w:ind w:firstLineChars="200"/>')
  ].join('');
  zip.file('word/document.xml', original.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${content}</w:body>`));
  const input = await zip.generateAsync({ type: 'nodebuffer' });
  for (const formulaFormat of ['mathml', 'png']) {
    const result = await convertDocx(input, { formulaFormat, fontMode: 'word', fontSize: 14 });
    const $ = load(result.fragment, null, false);
    assert.deepEqual(result.manifest.formulas.map(formula => formula.display), [false, false, false], 'Centering does not change mathematical display style');
    const centered = $('div[style*="text-align:center"]').filter((_, node) => $(node).children('p').length);
    assert.equal(centered.length, 2);
    centered.each((_, node) => {
      assert.match($(node).attr('style'), /text-indent:0px/);
      assert.match($(node).attr('style'), /margin-left:0px/);
      assert.match($(node).attr('style'), /margin-right:0px/);
    });
    assert.ok(centered.last().children('p').text().trimEnd().endsWith('.'), 'Trailing punctuation is retained');
    assert.match(scopedStyle($, 'In context ' + (formulaFormat === 'png' ? '' : $('math').last().text()) + ' remains inline.'), /text-indent:2em/);
    assert.doesNotMatch(result.fragment, /text-indent:(?:14|4)em/);
    assert.equal(formulaFormat === 'mathml' ? $('math[display="inline"]').length : $('img').length, 3);
  }
});
