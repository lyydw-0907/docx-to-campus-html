import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import JSZip from 'jszip';
import { load } from 'cheerio';
import sharp from 'sharp';
import { convertDocx, resolvePandocPath, sanitizeHtml } from '../src/convert.mjs';
import { makeDemoDocx } from '../src/fixtures.mjs';

const execute = promisify(execFile);
const pandoc = await resolvePandocPath();
let pandocAvailable = true;
try { await execute(pandoc, ['--version']); } catch { pandocAvailable = false; }
const requiresPandoc = { skip: pandocAvailable ? false : 'Run npm run setup:pandoc or set PANDOC_PATH for DOCX integration tests.' };

test('real DOCX three-line tables retain multirow merged headers, body merges and inline equations', requiresPandoc, async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const body = await zip.file('word/document.xml').async('string');
  const inlineFormula = body.match(/<m:oMath>[\s\S]*?<\/m:oMath>/)[0];
  const cell = (text, properties = '', formula = '') => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${properties}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r>${formula}</w:p></w:tc>`;
  const header = '<w:trPr><w:tblHeader/></w:trPr>';
  const table = `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr>${header}${cell('A', '<w:vMerge w:val="restart"/>')}${cell('B、C分组', '<w:gridSpan w:val="2"/>')}</w:tr>
    <w:tr>${header}${cell('', '<w:vMerge/>')}${cell('B')}${cell('C')}</w:tr>
    <w:tr>${cell('合并数据', '<w:vMerge w:val="restart"/>')}${cell('10', '', inlineFormula)}${cell('20')}</w:tr>
    <w:tr>${cell('', '<w:vMerge/>')}${cell('30')}${cell('40')}</w:tr>
    <w:tr>${cell('末行')}${cell('50')}${cell('60')}</w:tr></w:tbl>`;
  zip.file('word/document.xml', body.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, table));
  const result = await convertDocx(await zip.generateAsync({ type: 'nodebuffer' }), { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  const dataTable = $('th').filter((_, node) => $(node).text().trim() === 'A').closest('table');
  assert.equal(dataTable.length, 1);
  assert.match(dataTable.attr('style'), /border-top:1\.5px solid #111/);
  assert.match(dataTable.attr('style'), /border-bottom:1\.5px solid #111/);
  assert.equal(dataTable.find('thead > tr').length, 2);
  const mergedHeader = dataTable.find('th[rowspan="2"]');
  assert.equal(mergedHeader.text().trim(), 'A');
  assert.match(mergedHeader.attr('style'), /border-bottom:1px solid #111/);
  const group = dataTable.find('th[colspan="2"]');
  assert.equal(group.text().trim(), 'B、C分组');
  assert.doesNotMatch(group.attr('style'), /border-bottom:(?!0)/);
  dataTable.find('thead > tr').last().children('th').each((_, node) => assert.match($(node).attr('style'), /border-bottom:1px solid #111/));
  assert.equal(dataTable.find('tbody td[rowspan="2"]').text().trim(), '合并数据');
  dataTable.find('tbody td').each((_, node) => {
    assert.match($(node).attr('style'), /(?:^|;)border:0(?:;|$)/);
    assert.doesNotMatch($(node).attr('style'), /border-(?:top|bottom|left|right):[1-9]/);
  });
  assert.equal(dataTable.find('math[display="inline"]').length, 1);
  assert.equal($('math').length, 3);
  assert.equal(result.manifest.options.tableStyle, 'three-line');
  const numberTable = $('td').filter((_, node) => $(node).text().trim() === '(1)').closest('table');
  assert.match(numberTable.attr('style'), /(?:^|;)border:0(?:;|$)/);
  assert.doesNotMatch(numberTable.attr('style'), /border-(?:top|bottom|left|right):[1-9]/);
  assert.equal(numberTable.find('math').length, 1);
});

test('real DOCX nested figure layout tables are borderless while data and equation tables keep their rules', requiresPandoc, async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const body = await zip.file('word/document.xml').async('string');
  const imageRun = body.match(/<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/)[0];
  const originalImage = await zip.file('word/media/demo.png').async('nodebuffer');
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((edge) => `<w:${edge} w:val="single" w:sz="8" w:color="000000"/>`).join('');
  const paragraph = (content) => `<w:p>${content}</w:p>`;
  const caption = (text) => paragraph(`<w:r><w:t>${text}</w:t></w:r>`);
  const cell = (content) => `<w:tc><w:tcPr><w:tcW w:w="9000" w:type="dxa"/><w:tcBorders>${borders}</w:tcBorders></w:tcPr>${content}</w:tc>`;
  const table = (rows) => `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>${rows.map((content) => `<w:tr>${cell(content)}</w:tr>`).join('')}</w:tbl>`;
  const inner = table([paragraph(imageRun), caption('图 2 合成嵌套示意图')]);
  const outer = table([`${inner}<w:p/>`, caption('图 3 合成组合示意图')]);
  zip.file('word/document.xml', body.replace(paragraph(imageRun), outer));

  const result = await convertDocx(await zip.generateAsync({ type: 'nodebuffer' }), { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  const figureTables = $('table').filter((_, node) => $(node).find('img').length > 0);
  assert.equal(figureTables.length, 2, 'both the inner figure table and its outer layout table survive');
  assert.equal(figureTables.first().find('table').length, 1, 'the figure layout remains nested');
  assert.equal(figureTables.first().find('img').length, 1);
  assert.match(figureTables.first().text(), /图 2 合成嵌套示意图/);
  assert.match(figureTables.first().text(), /图 3 合成组合示意图/);
  const assertBorderless = (nodes) => nodes.each((_, node) => {
    const style = $(node).attr('style') ?? '';
    assert.match(style, /(?:^|;)border:0(?:;|$)/);
    for (const declaration of style.split(';').filter(Boolean)) {
      const [property, value] = declaration.split(':');
      if (/^border(?:$|-)/.test(property) && !['border-collapse', 'border-spacing'].includes(property)) {
        assert.equal(value, '0', `${node.tagName} must not retain a ${property} line`);
      }
    }
  });
  figureTables.each((_, node) => {
    assertBorderless($(node).add($(node).find('colgroup,col,thead,tbody,tfoot,tr,th,td')));
  });

  const dataTable = $('th,td').filter((_, node) => $(node).text().trim() === '项目').closest('table');
  assert.equal(dataTable.length, 1);
  assert.match(dataTable.attr('style'), /border-top:1\.5px solid #111/);
  assert.match(dataTable.attr('style'), /border-bottom:1\.5px solid #111/);
  dataTable.find('tr').first().children('th,td').each((_, node) => {
    assert.match($(node).attr('style'), /border-bottom:1px solid #111/);
  });
  assertBorderless(dataTable.find('tr').slice(1).children('td'));
  const equationTable = $('td').filter((_, node) => $(node).text().trim() === '(1)').closest('table');
  assert.equal(equationTable.length, 1);
  assertBorderless(equationTable.add(equationTable.find('td')));
  assert.doesNotMatch(equationTable.find('tr').attr('style') ?? '', /border(?:-(?:top|bottom|left|right))?:[1-9]/);
  assert.equal(equationTable.find('math').length, 1);
  assert.equal($('math').length, 2);
  assert.equal($('img').length, 1);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].kind, 'image');
  assert.deepEqual(result.assets[0].data, originalImage);

  const stripped = load(sanitizeHtml('<table><tr><td><img src="https://unowned.example.test/figure.png" width="160" height="60"></td></tr><tr><td><p>图 4 合成图题</p></td></tr></table>'));
  assert.equal(stripped('img').length, 0);
  assert.match(stripped('table').attr('style'), /border-top:1\.5px solid #111/, 'a removed unsafe image cannot qualify the table as a figure layout');
  assert.match(stripped('table').attr('style'), /border-bottom:1\.5px solid #111/);
});

test('synthetic fixture contains native inline/display OMML, table and media', async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const body = await zip.file('word/document.xml').async('string');
  assert.equal((body.match(/<m:oMath>/g) ?? []).length, 2);
  assert.match(body, /<m:oMathPara>/);
  assert.match(body, /<w:tbl>/);
  assert.match(body, /\(1\)/);
  const image = await zip.file('word/media/demo.png').async('nodebuffer');
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 160);
  assert.equal(metadata.height, 60);
});

test('HTML sanitizer strips executable content and keeps table spans and safe layout', () => {
  const html = sanitizeHtml('<p onclick="alert(1)" style="text-align:center;background-image:url(https://example.test/x);position:fixed">Safe<script>bad()</script><strong>bold</strong></p><table><tr><td colspan="2" rowspan="3">cell</td></tr></table><img src="https://unowned.test/x" width="10" height="10"><a href="javascript:alert(1)">link</a><!--hidden--><svg><script>bad</script></svg>');
  assert.doesNotMatch(html, /onclick|background-image|position:|<script|<svg|javascript:|<img|hidden/);
  assert.match(html, /text-align:center/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /colspan="2" rowspan="3"/);
  assert.match(html, /border-collapse:collapse/);
});

test('input limits and suspicious ZIP paths fail before launching Pandoc', async () => {
  await assert.rejects(convertDocx(Buffer.from('not-a-docx')), /ZIP|DOCX/);
  await assert.rejects(convertDocx(Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MB/);
  const malicious = new JSZip();
  malicious.file('../escape.xml', '<bad/>');
  await assert.rejects(convertDocx(await malicious.generateAsync({ type: 'nodebuffer' })), /不安全/);
  const large = await makeDemoDocx();
  const central = large.indexOf(Buffer.from('504b0102', 'hex'));
  large.writeUInt32LE(101 * 1024 * 1024, central + 24);
  await assert.rejects(convertDocx(large), /解压体积/);
  const fakeSize = await makeDemoDocx();
  const fakeCentral = fakeSize.indexOf(Buffer.from('504b0102', 'hex'));
  fakeSize.writeUInt32LE(1, fakeCentral + 24);
  await assert.rejects(convertDocx(fakeSize), /实际解压尺寸/);
});

test('external Word image relationships are rejected without fetching them', async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const relationships = await zip.file('word/_rels/document.xml.rels').async('string');
  zip.file('word/_rels/document.xml.rels', relationships.replace('Target="media/demo.png"', 'Target="https://example.test/private.png" TargetMode="External"'));
  await assert.rejects(convertDocx(await zip.generateAsync({ type: 'nodebuffer' })), /外部图片或外部资源/);
});

test('DOCX conversion preserves structure, native math and the existing right-hand number', requiresPandoc, async () => {
  const result = await convertDocx(await makeDemoDocx());
  const $ = load(result.fragment);
  assert.match($('h1').text(), /大创申报转换示例/);
  assert.match($('strong').text(), /加粗文本/);
  assert.equal($('sup').text(), '2');
  assert.equal($('sub').text(), '2');
  assert.ok($('table').length >= 2);
  assert.ok($('td').filter((_, cell) => $(cell).text() === '(1)').length);
  assert.match($('td').filter((_, cell) => $(cell).text() === '(1)').attr('style'), /text-align:right/);
  assert.equal(result.manifest.source.nativeFormulaCount, 2);
  assert.equal(result.manifest.formulas.length, 2);
  assert.equal(result.manifest.formulas.filter((formula) => formula.display).length, 1);
  assert.equal(result.assets.filter((asset) => asset.kind === 'formula').length, 2);
  assert.equal(result.assets.filter((asset) => asset.kind === 'image').length, 1);
  assert.equal($('img').length, 3);
  assert.equal(result.manifest.verification, 'unverified');
  assert.ok(result.manifest.warnings.some((warning) => /data URI/.test(warning)));
  for (const formula of result.manifest.formulas) {
    const asset = result.assets.find((item) => item.filename === formula.filename);
    const metadata = await sharp(asset.data).metadata();
    assert.ok(Math.abs(metadata.width / formula.width - 3) < 0.1);
    assert.ok(Math.abs(metadata.height / formula.height - 3) < 0.1);
    assert.ok(formula.tex.length);
    assert.ok(formula.depth >= 0);
  }
  $('img').each((_, image) => {
    assert.match($(image).attr('src'), /^data:image\/png;base64,/);
    assert.ok(Number($(image).attr('width')) > 0);
    assert.ok(Number($(image).attr('height')) > 0);
    assert.match($(image).attr('style'), /width:.*px;height:.*px;vertical-align:/);
  });
});

test('fullwidth formula-number parentheses keep their original text and right-hand layout', requiresPandoc, async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const body = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', body.replace('(1)', '（1）'));
  const result = await convertDocx(await zip.generateAsync({ type: 'nodebuffer' }));
  const $ = load(result.fragment);
  const numberCell = $('td').filter((_, cell) => $(cell).text() === '（1）');
  assert.equal(numberCell.length, 1);
  assert.match(numberCell.attr('style'), /text-align:right/);
  const equationRow = numberCell.closest('tr');
  assert.equal(equationRow.find('img').length, 1);
  assert.match(equationRow.find('td').eq(1).attr('style'), /text-align:center/);
  assert.equal(result.manifest.source.nativeFormulaCount, 2);
  assert.equal(result.manifest.formulas.length, 2);
  assert.equal(result.manifest.formulas.filter((formula) => formula.display).length, 1);
});

test('file mode clearly marks local paths and mapped mode requires every safe school URL', requiresPandoc, async () => {
  const docx = await makeDemoDocx();
  const files = await convertDocx(docx, { imageMode: 'files' });
  assert.match(files.fragment, /src="assets\//);
  assert.ok(files.manifest.warnings.some((warning) => /仅供本地预览/.test(warning)));
  await assert.rejects(convertDocx(docx, { imageMode: 'mapped', assetUrls: {} }), /缺少图片/);
  const mapping = Object.fromEntries(files.assets.map((asset) => [asset.filename, `https://school.example.test/uploads/${asset.filename}`]));
  const mapped = await convertDocx(docx, { imageMode: 'mapped', assetUrls: mapping });
  const $ = load(mapped.fragment);
  $('img').each((_, image) => assert.match($(image).attr('src'), /^https:\/\/school\.example\.test\/uploads\//));
  assert.doesNotMatch(JSON.stringify(mapped.manifest), /school\.example/);
  mapping[files.assets[0].filename] = 'javascript:alert(1)';
  await assert.rejects(convertDocx(docx, { imageMode: 'mapped', assetUrls: mapping }), /HTTP\(S\)/);
  mapping[files.assets[0].filename] = '/relative/image.png';
  await assert.rejects(convertDocx(docx, { imageMode: 'mapped', assetUrls: mapping }), /完整的 HTTP/);
});

test('a formula omitted by the DOCX reader is reported instead of silently exporting', requiresPandoc, async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  zip.file('word/footnotes.xml', '<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:footnote w:id="7"><w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p></w:footnote></w:footnotes>');
  await assert.rejects(convertDocx(await zip.generateAsync({ type: 'nodebuffer' })), /公式数量不一致/);
  await assert.rejects(convertDocx(await zip.generateAsync({ type: 'nodebuffer' }), { formulaFormat: 'mathml' }), /公式数量不一致/);
});

async function alteredDemo(transform, { removeImage = false } = {}) {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  let body = await zip.file('word/document.xml').async('string');
  if (removeImage) body = body.replace(/<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/, '');
  zip.file('word/document.xml', transform(body));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function hashNumberDemo({ inline = false, marker = '#(12)', outside = false } = {}) {
  return alteredDemo(body => {
    if (outside) return body.replace('(1)', marker);
    const display = body.match(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/)[0];
    let replacement = display.replace('</m:oMath>', `<m:r><m:t>${marker}</m:t></m:r></m:oMath>`);
    if (inline) replacement = replacement.match(/<m:oMath>[\s\S]*?<\/m:oMath>/)[0];
    return body.replace(display, replacement).replace('<w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">(1)</w:t></w:r>', '');
  }, { removeImage: true });
}

async function equationArrayDemo({ inline = false, marker = '#(7)' } = {}) {
  return alteredDemo(body => {
    const display = body.match(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/)[0];
    const sum = '<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup><m:e><m:r><m:t>x</m:t></m:r></m:e></m:nary>';
    const math = `<m:oMath><m:eqArr><m:e>${sum}<m:r><m:t>.${marker}</m:t></m:r></m:e></m:eqArr></m:oMath>`;
    const replacement = inline ? `<w:r><w:t xml:space="preserve">其中 </w:t></w:r>${math}` : `<m:oMathPara>${math}</m:oMathPara>`;
    return body.replace(display, replacement).replace('<w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">(1)</w:t></w:r>', '');
  }, { removeImage: true });
}

test('source Word single-row equation arrays separate complete labels and preserve sum limits', requiresPandoc, async () => {
  const result = await convertDocx(await equationArrayDemo(), { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  const formula = result.manifest.formulas[1];
  assert.equal(formula.number, '(7)');
  assert.equal(formula.wrapperRemoved, 'single-row-array');
  assert.match(formula.tex, /\\begin\{array\}\{r\}/);
  assert.doesNotMatch(formula.renderTex, /array|#/);
  const math = $('math').eq(1);
  assert.equal(math.find('annotation').text(), formula.tex);
  assert.equal(math.find('munderover').length, 1);
  assert.equal(math.find('mtable').length, 0);
  assert.doesNotMatch(math.find('mi,mn,mo,mtext').text(), /#/);
  const number = $('td').filter((_, cell) => $(cell).text() === '(7)');
  assert.equal(number.length, 1);
  assert.match(number.attr('style'), /text-align:right/);
});

test('source-confirmed unfinished array markers can be removed while preserving body inline math', requiresPandoc, async () => {
  const result = await convertDocx(await equationArrayDemo({ inline: true, marker: '#' }), { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  const formula = result.manifest.formulas[1];
  const math = $('math').eq(1);
  assert.equal(formula.display, false);
  assert.equal(formula.number, undefined);
  assert.equal(formula.markerCleanup, 'incomplete-word-number-marker-removed');
  assert.match(formula.tex, /\\#.*\\end\{array\}/s);
  assert.doesNotMatch(formula.renderTex, /array|#/);
  assert.equal(math.attr('display'), 'inline');
  assert.match(math.closest('p').text(), /^其中 /);
  assert.equal(math.find('annotation').text(), formula.tex);
  assert.equal(math.find('munderover').length, 1);
  assert.equal(math.find('mo').filter((_, node) => $(node).text() === '∑').attr('movablelimits'), 'false');
  assert.ok(formula.sourceLayoutChanges.length);
  assert.doesNotMatch(math.find('mi,mn,mo,mtext').text(), /#/);
  assert.ok(result.manifest.warnings.some(warning => /第 2.*孤立 #/.test(warning)));
});

test('unfinished Word array marker cleanup can be explicitly disabled', requiresPandoc, async () => {
  const result = await convertDocx(await equationArrayDemo({ inline: true, marker: '#' }), { formulaFormat: 'mathml', removeIncompleteNumberMarkers: false });
  const $ = load(result.fragment);
  const formula = result.manifest.formulas[1];
  assert.equal(result.manifest.options.removeIncompleteNumberMarkers, false);
  assert.equal(formula.markerCleanup, undefined);
  assert.equal(formula.number, undefined);
  assert.match($('math').eq(1).find('mi,mn,mo,mtext').text(), /#/);
  assert.equal($('math').eq(1).find('annotation').text(), formula.tex);
  assert.equal($('math').eq(1).find('munderover').length, 1);
  assert.ok(result.manifest.warnings.some(warning => /第 2.*未处理的 #/.test(warning)));
});

test('PNG export restores source sum limits after unwrapping numbered Word arrays', requiresPandoc, async () => {
  const result = await convertDocx(await equationArrayDemo(), { formulaFormat: 'png', fontSize: 14 });
  const formula = result.manifest.formulas[1];
  assert.equal(formula.number, '(7)');
  assert.equal(formula.wrapperRemoved, 'single-row-array');
  assert.match(formula.tex, /\\sum/);
  assert.doesNotMatch(formula.tex, /\\limits/);
  assert.match(formula.renderTex, /\\sum\\limits/);
  assert.doesNotMatch(formula.renderTex, /array|#/);
  assert.ok(formula.sourceLayoutChanges.length);
  assert.equal(result.assets.filter(asset => asset.kind === 'formula').length, 2);
  const $ = load(result.fragment);
  assert.equal($('td').filter((_, cell) => $(cell).text() === '(7)').closest('table').find('img').length, 1);
});

test('Word hash numbers leave the visible equation and stay in original MathML source annotations', requiresPandoc, async () => {
  const result = await convertDocx(await hashNumberDemo(), { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  const formula = result.manifest.formulas[1];
  assert.equal(formula.number, '(12)');
  assert.equal(formula.numberSource, 'math-tail');
  assert.match(formula.tex, /\\#\(12\)$/);
  assert.doesNotMatch(formula.renderTex, /#/);
  const math = $('math').eq(1);
  assert.equal(math.find('annotation').text(), formula.tex);
  assert.doesNotMatch(math.find('mi,mn,mo,mtext').text(), /#/);
  const number = $('td').filter((_, cell) => $(cell).text() === '(12)');
  assert.equal(number.length, 1);
  assert.match(number.attr('style'), /text-align:right/);
  assert.equal(number.closest('table').find('math').length, 1);
  assert.doesNotMatch(number.closest('table').attr('style'), /border-top|border-bottom/);
});

test('standalone inline OMML with a hash number becomes display math without changing body inline math', requiresPandoc, async () => {
  const result = await convertDocx(await hashNumberDemo({ inline: true }), { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  assert.equal($('math[display="inline"]').length, 1);
  assert.equal($('math[display="block"]').length, 1);
  assert.equal($('math').eq(1).find('munderover').length, 1);
  assert.equal(result.manifest.formulas[1].sourceDisplay, false);
  assert.equal(result.manifest.formulas[1].display, true);
  assert.equal(result.manifest.formulas[1].number, '(12)');
  assert.equal(result.manifest.formulas[0].number, undefined);
});

test('Word external hash numbers and fullwidth labels use the same right-hand layout', requiresPandoc, async () => {
  const result = await convertDocx(await hashNumberDemo({ outside: true, marker: '#（２）' }), { formulaFormat: 'mathml' });
  const $ = load(result.fragment);
  assert.equal(result.manifest.formulas[1].number, '（２）');
  assert.equal(result.manifest.formulas[1].numberSource, 'paragraph-text');
  assert.equal($('td').filter((_, cell) => $(cell).text() === '（２）').length, 1);
  assert.doesNotMatch($('div').text(), /#（/);
});

test('PNG rendering separates a Word hash label and records both source and rendered TeX', requiresPandoc, async () => {
  const result = await convertDocx(await hashNumberDemo(), { formulaFormat: 'png', fontSize: 14 });
  const $ = load(result.fragment);
  const formula = result.manifest.formulas[1];
  assert.equal(formula.number, '(12)');
  assert.match(formula.tex, /\\#\(12\)$/);
  assert.doesNotMatch(formula.renderTex, /#/);
  assert.equal($('td').filter((_, cell) => $(cell).text() === '(12)').closest('table').find('img').length, 1);
  assert.equal(result.assets.filter(asset => asset.kind === 'formula').length, 2);
});

test('unfinished hash markers remain mathematical content with a review warning', requiresPandoc, async () => {
  const result = await convertDocx(await hashNumberDemo({ marker: '#' }), { formulaFormat: 'mathml' });
  const $ = load(result.fragment);
  assert.match($('math').eq(1).find('mi,mn,mo,mtext').text(), /#/);
  assert.equal(result.manifest.formulas[1].number, undefined);
  assert.equal($('table').filter((_, table) => ($(table).attr('style') ?? '').includes('table-layout:fixed')).length, 0);
  assert.ok(result.manifest.warnings.some(warning => /第 2.*未处理的 #/.test(warning)));
});

test('body sanitizer allows explicitly requested safe native math, but PNG mode removes it', () => {
  const html = '<p>正文<strong>加粗</strong><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow onclick="bad()"><mi href="https://example.test">x</mi><mo>−</mo><mi>y</mi></mrow><annotation encoding="application/x-tex">x-y</annotation><annotation-xml><script>bad()</script></annotation-xml></semantics></math></p>';
  const native = sanitizeHtml(html, { allowMathML: true, fontSize: 14 });
  const $ = load(native);
  assert.equal($('math').length, 1);
  assert.equal($('mo').text(), '-');
  assert.equal($('strong').text(), '加粗');
  assert.equal($('annotation').text(), 'x-y');
  assert.doesNotMatch(native, /onclick|href|script|annotation-xml|https:/);
  const png = sanitizeHtml(html);
  assert.doesNotMatch(png, /<math|<mrow|<mi/);
  assert.match(png, /正文<strong>加粗<\/strong>/);
});

test('real Word OMML exports native MathML alongside an ordinary image without formula assets', requiresPandoc, async () => {
  const result = await convertDocx(await makeDemoDocx(), { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  assert.equal($('math').length, 2);
  assert.equal($('math[display="inline"]').length, 1);
  assert.equal($('math[display="block"]').length, 1);
  assert.equal($('mfrac').length, 1);
  assert.equal($('msub').length, 2);
  assert.equal($('munderover').length, 1);
  $('math').each((_, math) => {
    assert.equal($(math).attr('xmlns'), 'http://www.w3.org/1998/Math/MathML');
    assert.match($(math).attr('style'), /font-size:14px/);
  });
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].kind, 'image');
  assert.equal($('img').length, 1);
  assert.equal(result.manifest.options.formulaFormat, 'mathml');
  assert.equal(result.manifest.verification, 'unverified');
  assert.equal(result.manifest.formulas.length, 2);
  for (const formula of result.manifest.formulas) {
    assert.equal(formula.format, 'mathml');
    assert.ok(Array.isArray(formula.compatibilityChanges));
    assert.equal(formula.filename, undefined);
  }
  assert.deepEqual($('annotation').map((_, element) => $(element).text()).get(), result.manifest.formulas.map((formula) => formula.tex));
  assert.ok(result.manifest.warnings.some((warning) => /data URI/.test(warning)));
  assert.match(result.preview, /合成样例已完成学校暂存回读验证.*当前文档仍未验证/);
  assert.equal($('script').length, 0);
});

test('image-free native formulas need no URL mapping or image warnings and preserve fullwidth right numbers', requiresPandoc, async () => {
  const docx = await alteredDemo((body) => body.replace('(1)', '（1）'), { removeImage: true });
  const result = await convertDocx(docx, { formulaFormat: 'mathml', imageMode: 'mapped', fontSize: 14 });
  const $ = load(result.fragment);
  assert.equal(result.assets.length, 0);
  assert.equal($('img').length, 0);
  assert.equal($('math').length, 2);
  assert.ok(!result.manifest.warnings.some((warning) => /data URI|assets\/|图片上传/.test(warning)));
  assert.match(result.preview, /此结果没有图片资产/);
  const number = $('td').filter((_, cell) => $(cell).text() === '（1）');
  assert.equal(number.length, 1);
  const cells = number.closest('tr').children('td');
  assert.deepEqual(cells.map((_, cell) => $(cell).attr('width')).get(), ['10%', '80%', '10%']);
  assert.match(cells.eq(0).attr('style'), /width:10%.*padding:0px.*vertical-align:middle/);
  assert.match(cells.eq(1).attr('style'), /width:80%.*text-align:center/);
  assert.match(cells.eq(2).attr('style'), /width:10%.*text-align:right.*vertical-align:middle/);
  assert.match(number.closest('table').attr('style'), /table-layout:fixed/);
  assert.equal(cells.eq(1).find('math[display="block"]').length, 1);
});

test('native Word minus operators become ASCII operators while body and TeX source remain unchanged', requiresPandoc, async () => {
  const docx = await alteredDemo((body) => body.replace('<m:t>a+b</m:t>', '<m:t>−a−b</m:t>').replace('这是一份合成测试文档', '这是一份合成−测试文档'), { removeImage: true });
  const result = await convertDocx(docx, { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  assert.match($('p').text(), /合成−测试文档/);
  const formula = result.manifest.formulas[0];
  assert.equal(formula.compatibilityChanges.reduce((sum, change) => sum + change.count, 0), 2);
  assert.ok(formula.compatibilityChanges.some((change) => change.beforeTag === 'mi' && change.afterTag === 'mo'));
  assert.equal($('math').first().find('mo').filter((_, node) => $(node).text() === '-').length, 2);
  assert.equal($('math').first().find('mi').filter((_, node) => $(node).text() === '-').length, 0);
  assert.equal($('math').first().find('annotation').text(), formula.tex);
  assert.match(formula.tex, /- a - b/);
});

test('real nested fractions, square roots and matrices survive the native batch with source numbering', requiresPandoc, async () => {
  const r = (text) => `<m:r><m:t>${text}</m:t></m:r>`;
  const nested = `<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`;
  const matrix = '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:m><m:mr><m:e>' + r('a') + '</m:e><m:e>' + r('b') + '</m:e></m:mr><m:mr><m:e>' + r('c') + '</m:e><m:e>' + r('d') + '</m:e></m:mr></m:m></m:e></m:d>';
  const sqrt = `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r('a+b')}</m:e></m:rad>`;
  const numbered = (formula, number) => `<w:p><m:oMathPara><m:oMath>${formula}</m:oMath></m:oMathPara><w:r><w:t>${number}</w:t></w:r></w:p>`;
  const docx = await alteredDemo((body) => body.replace('<m:den><m:r><m:t>c</m:t></m:r></m:den>', `<m:den>${nested}</m:den>`).replace('<w:sectPr>', `${numbered(matrix, '（2）')}${numbered(sqrt, '（3）')}<w:sectPr>`), { removeImage: true });
  const result = await convertDocx(docx, { formulaFormat: 'mathml', fontSize: 14 });
  const $ = load(result.fragment);
  assert.equal(result.manifest.source.nativeFormulaCount, 4);
  assert.equal($('math').length, 4);
  assert.equal($('math').first().find('mfrac').length, 2);
  assert.equal($('math mtable').length, 1);
  assert.equal($('math mtable mtr').length, 2);
  assert.equal($('math mtable mtd').length, 4);
  assert.equal($('math msqrt').length, 1);
  for (const number of ['(1)', '（2）', '（3）']) assert.equal($('td').filter((_, cell) => $(cell).text() === number).length, 1);
  assert.equal(result.assets.length, 0);
});
