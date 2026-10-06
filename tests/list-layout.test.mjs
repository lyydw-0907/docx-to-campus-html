import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { makeDemoDocx } from '../src/fixtures.mjs';
import { convertDocx, normalizeListParagraphStyles, resolvePandocPath, sanitizeHtml } from '../src/convert.mjs';

const paragraph = text => ({ t: 'Para', c: [{ t: 'Str', c: text }] });
const ordered = items => ({ t: 'OrderedList', c: [[3, { t: 'Decimal' }, { t: 'Period' }], items] });
const sourceStyle = 'font-size:16px;text-align:justify;text-indent:-20px;margin-left:2em;margin-right:0.5em';

test('native list paragraphs remove duplicate left and hanging indent without changing block structure', () => {
  const body = paragraph('Body');
  const first = paragraph('First');
  const continuation = paragraph('Continuation');
  continuation.t = 'Plain';
  const nested = paragraph('Nested');
  const quoted = paragraph('Quote');
  const cell = paragraph('Cell');
  const note = paragraph('Note');
  first.c.push({ t: 'Note', c: [note] });
  const blocks = [body, ordered([[first, continuation, { t: 'Div', c: [['', [], []], [{ t: 'BulletList', c: [[nested]] }]] }, { t: 'BlockQuote', c: [quoted] }, { t: 'Table', c: [cell] }]])];
  const original = structuredClone(blocks);
  const styles = new Map([body, first, continuation, nested, quoted, cell, note].map(node => [node, sourceStyle]));
  normalizeListParagraphStyles(blocks, styles);
  assert.deepEqual(blocks, original, 'Layout must not rewrite list semantics or text');
  for (const node of [first, continuation, nested]) {
    assert.doesNotMatch(styles.get(node), /text-indent|margin-left/);
    assert.match(styles.get(node), /font-size:16px;text-align:justify/);
    assert.match(styles.get(node), /margin-right:0\.5em/);
  }
  for (const node of [body, quoted, cell, note]) assert.equal(styles.get(node), sourceStyle);
});

test('a Div-wrapped direct list paragraph is normalized while other Div paragraphs retain indentation', () => {
  const item = paragraph('Wrapped item');
  const body = paragraph('Wrapped body');
  const div = node => ({ t: 'Div', c: [['', [], []], [node]] });
  const styles = new Map([[item, 'text-indent:44.2px;margin-left:0.5em;font-size:20px'], [body, sourceStyle]]);
  normalizeListParagraphStyles([div(body), ordered([[div(item)]])], styles);
  assert.equal(styles.get(item), 'font-size:20px');
  assert.equal(styles.get(body), sourceStyle);
});

test('safe list HTML uses one native indent and preserves numeric starts and marker formats', () => {
  const html = sanitizeHtml('<ol start="7" type="A" style="list-style-type:upper-alpha;list-style-position:inside;padding:99px;text-indent:-20px"><li style="text-indent:2em">First<ul><li>Nested</li></ul></li><li>Second</li></ol>');
  const $ = load(html, null, false);
  assert.equal($('ol').attr('start'), '7');
  assert.equal($('ol').attr('type'), 'A');
  assert.match($('ol').attr('style'), /list-style-type:upper-alpha/);
  for (const element of $('ol,ul').toArray()) {
    const style = $(element).attr('style');
    assert.match(style, /list-style-position:outside/);
    assert.match(style, /padding:0px 0px 0px 2em/);
    assert.match(style, /text-indent:0px/);
    assert.doesNotMatch(style, /99px/);
  }
  for (const element of $('li').toArray()) assert.match($(element).attr('style'), /text-indent:0px/);
  assert.equal($('ol').children('li').length, 2);
  assert.equal($('ul').children('li').length, 1);
});

test('list starts, marker types and CSS remain allowlisted', () => {
  const $ = load(sanitizeHtml('<ol start="1e3" type="bad" style="list-style-type:url(https://example.test);list-style-image:url(x)"><li>x</li></ol><ol start="9007199254740992" type="i"><li>y</li></ol><ol start="-2" type="1"><li>z</li></ol>'), null, false);
  assert.equal($('ol').eq(0).attr('start'), undefined);
  assert.equal($('ol').eq(0).attr('type'), undefined);
  assert.equal($('ol').eq(1).attr('start'), undefined);
  assert.equal($('ol').eq(1).attr('type'), 'i');
  assert.equal($('ol').eq(2).attr('start'), '-2');
  assert.doesNotMatch($.html(), /url\(|list-style-image/);
});

let available = true;
try { await promisify(execFile)(await resolvePandocPath(), ['--version']); } catch { available = false; }
const requiresPandoc = { skip: available ? false : 'Install Pandoc to verify actual Word list conversion.' };

async function listDocx() {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const original = await zip.file('word/document.xml').async('string');
  const p = (text, properties = '') => `<w:p><w:pPr>${properties}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const num = (id, level = 0) => `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr>`;
  const common = '<w:pStyle w:val="IndentedList"/>';
  const body = [
    p('Body paragraph', common),
    p('Positive first-line item', common + num(1) + '<w:ind w:firstLine="663" w:left="120" w:right="120"/>'),
    p('Hanging item', common + num(1) + '<w:ind w:hanging="300" w:left="120" w:right="120"/>'),
    p('Nested bullet item', common + num(2, 1) + '<w:ind w:hangingChars="200" w:leftChars="200"/>'),
    p('After nested item', common + num(1)),
    p('Tail paragraph', common),
  ].join('');
  zip.file('word/document.xml', original.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`));
  const styles = await zip.file('word/styles.xml').async('string');
  zip.file('word/styles.xml', styles.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="IndentedList"><w:name w:val="IndentedList"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLineChars="200" w:leftChars="50" w:rightChars="50"/><w:jc w:val="both"/></w:pPr></w:style></w:styles>'));
  zip.file('word/numbering.xml', '<?xml version="1.0" encoding="utf-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  zip.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>'));
  const types = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('Word positive and hanging list indents do not compete with native markers in original-size mode', requiresPandoc, async () => {
  const result = await convertDocx(await listDocx(), { formulaFormat: 'mathml', fontMode: 'word', fontSize: 14 });
  const $ = load(result.fragment, null, false);
  assert.equal($('ol').first().attr('start'), '7');
  assert.equal($('ol').children('li').length, 3);
  assert.equal($('li ul li').length, 1);
  for (const element of $('li > div').toArray()) {
    const style = $(element).attr('style');
    assert.doesNotMatch(style, /text-indent|margin-left/);
    assert.match(style, /font-size:16px/);
    assert.match(style, /text-align:justify/);
  }
  for (const text of ['Body paragraph', 'Tail paragraph']) {
    const para = $('p').filter((_, node) => $(node).text() === text);
    assert.match(para.parent().attr('style'), /text-indent:2em;margin-left:0.5em;margin-right:0.5em/);
  }
  assert.deepEqual($('ol').first().children('li').children('div').children('p').map((_, node) => $(node).text()).get(), ['Positive first-line item', 'Hanging item', 'After nested item']);
  assert.doesNotMatch(result.fragment, /CampusFormatting|custom-style/);
});

test('uniform-size conversion uses the same normalized native list layout', requiresPandoc, async () => {
  const result = await convertDocx(await listDocx(), { formulaFormat: 'mathml', fontMode: 'uniform', fontSize: 18 });
  const $ = load(result.fragment, null, false);
  assert.equal($('ol').first().attr('start'), '7');
  for (const element of $('li > div').toArray()) assert.doesNotMatch($(element).attr('style'), /text-indent|margin-left|font-size/);
  assert.match($('p').filter((_, node) => $(node).text() === 'Body paragraph').parent().attr('style'), /text-indent:2em/);
});
