import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { makeDemoDocx } from '../src/fixtures.mjs';
import { convertDocx, resolvePandocPath } from '../src/convert.mjs';
import { prepareWordFormatting, restoreWordFormatting } from '../src/word-format.mjs';

const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run = (text, properties = '') => `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (content, properties = '') => `<w:p><w:pPr>${properties}</w:pPr>${content}</w:p>`;
const style = (id, type, properties = '', base = '', extra = '') => `<w:style w:type="${type}" w:styleId="${id}" ${extra}><w:name w:val="${id}"/>${base ? `<w:basedOn w:val="${base}"/>` : ''}<w:rPr>${properties}</w:rPr></w:style>`;
let available = true;
try { await promisify(execFile)(await resolvePandocPath(), ['--version'], { windowsHide: true }); } catch { available = false; }
const requiresPandoc = { skip: available ? false : 'Install Pandoc to check source bold conversion.' };

async function fixture() {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const original = await zip.file('word/document.xml').async('string');
  const math = original.match(/<m:oMath>[\s\S]*?<\/m:oMath>/)[0];
  const image = original.match(/<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/)[0];
  const list = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
  const body = [
    paragraph(run('Inherited char bold', '<w:rStyle w:val="StrongChild"/>')),
    paragraph(run('Inherited paragraph bold'), '<w:pStyle w:val="BoldBody"/>'),
    paragraph(run('Reset normal', '<w:b w:val="0"/>'), '<w:pStyle w:val="BoldBody"/>'),
    paragraph(run('Normal heading', '<w:b w:val="0"/>'), '<w:pStyle w:val="Heading1"/>'),
    paragraph(run('Inherited heading'), '<w:pStyle w:val="Heading1"/>'),
    paragraph(run('Category cancellation', '<w:rStyle w:val="StrongChild"/>'), '<w:pStyle w:val="BoldBody"/>'),
    paragraph(run('Default character ignored')),
    paragraph(run('Bold A', '<w:b/>') + run(' Normal B', '<w:b w:val="false"/>') + run(' Bold C', '<w:rStyle w:val="StrongChild"/>')),
    paragraph(run('Chinese normal 中文', '<w:b w:val="0"/><w:bCs/>') + run(' Forced complex', '<w:b w:val="0"/><w:bCs/><w:cs/>')),
    paragraph(run('Numbered bold item', '<w:rStyle w:val="StrongChild"/>'), list),
    paragraph(run('Numbered normal item', '<w:b w:val="0"/>'), list),
    paragraph(run('Math context ') + math + run(' remains normal.')),
    paragraph(image),
  ].join('');
  zip.file('word/document.xml', original.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`));
  zip.file('word/styles.xml', `<w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>${style('Normal', 'paragraph', '', '', 'w:default="1"')}${style('BoldBody', 'paragraph', '<w:b/>', 'Normal')}${style('StrongBase', 'character', '<w:b/>')}${style('StrongChild', 'character', '', 'StrongBase')}${style('DefaultCharacter', 'character', '<w:b/>', '', 'w:default="1"')}<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`);
  zip.file('word/numbering.xml', `<w:numbering xmlns:w="${ns}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function textWeight($, text) {
  const matches = $('span').filter((_, node) => $(node).text().trim() === text.trim());
  assert.equal(matches.length, 1, `Unique source run for ${text}`);
  const styles = matches.first().attr('style');
  const value = /(?:^|;)font-weight:(bold|normal)(?:;|$)/.exec(styles)?.[1];
  assert.ok(value, 'Source run weight is explicit and wins over ancestor heading or emphasis defaults');
  return value;
}

for (const fontMode of ['word', 'uniform']) test(`source character, heading and list weights survive actual DOCX conversion in ${fontMode} mode`, requiresPandoc, async () => {
  const input = await fixture(); const before = Buffer.from(input);
  const result = await convertDocx(input, { formulaFormat: 'mathml', fontMode, fontSize: 16 });
  assert.deepEqual(input, before);
  const $ = load(result.fragment, null, false);
  for (const text of ['Inherited char bold', 'Inherited paragraph bold', 'Inherited heading', 'Bold A', ' Bold C', ' Forced complex', 'Numbered bold item']) assert.equal(textWeight($, text), 'bold');
  for (const text of ['Reset normal', 'Normal heading', 'Category cancellation', 'Default character ignored', ' Normal B', 'Chinese normal 中文', 'Numbered normal item']) assert.equal(textWeight($, text), 'normal');
  assert.equal($('h1').length, 2);
  assert.ok($('h1').toArray().every(node => /font-weight:bold/.test($(node).attr('style'))), 'Source paragraph bold baseline explicit even with a direct normal run override');
  assert.equal($('ol').length, 1); assert.equal($('li').length, 2);
  assert.equal($('math').length, 1); assert.equal(result.manifest.formulas.length, 1);
  assert.equal($('img').length, 1); assert.equal(result.assets.length, 1);
  const sourceZip = await JSZip.loadAsync(input);
  const sourceImage = Object.values(sourceZip.files).find(file => !file.dir && file.name.startsWith('word/media/'));
  assert.deepEqual(result.assets[0].data, await sourceImage.async('nodebuffer'));
  assert.doesNotMatch(result.fragment, /CampusFormatting|custom-style/);
  if (fontMode === 'uniform') assert.ok($('span').toArray().every(node => !/font-size/.test($(node).attr('style'))));
});

test('source identities override reader Strong inside and outside spans while unknown emphasis is retained', async () => {
  const prepared = await prepareWordFormatting(await fixture(), { fontMode: 'uniform' });
  const label = [...prepared.paragraphFormats.keys()][2];
  const normal = [...prepared.runFormats].find(([, format]) => !format.bold)[0];
  const attributes = label => ['', [], [['custom-style', label]]];
  const text = { t: 'Str', c: 'Reset normal' };
  const source = { t: 'Span', c: [attributes(normal), [{ t: 'Strong', c: [text] }]] };
  const untouched = { t: 'Strong', c: [{ t: 'Str', c: 'Unknown source emphasis' }] };
  const para = { t: 'Para', c: [{ t: 'Strong', c: [source] }] };
  const ast = { blocks: [{ t: 'Div', c: [attributes(label), [para]] }, { t: 'Para', c: [untouched] }] };
  restoreWordFormatting(ast, prepared);
  assert.equal(para.c[0].t, 'Span');
  assert.deepEqual(para.c[0].c[1], [text]);
  assert.match(para.c[0].c[0][2][0][1], /font-weight:normal/);
  assert.equal(ast.blocks[1].c[0], untouched, 'Do not rewrite emphasis whose Word identity is unknown');
});
