import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import JSZip from 'jszip';
import { load } from 'cheerio';
import { convertDocx, resolvePandocPath } from '../src/convert.mjs';
import { makeDemoDocx } from '../src/fixtures.mjs';

let available = true;
try { await promisify(execFile)(await resolvePandocPath(), ['--version']); } catch { available = false; }
const requiresPandoc = { skip: available ? false : 'Install Pandoc to verify Word table layout conversion.' };
const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const run = (text, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t>${escapeXml(text)}</w:t></w:r>`;
const paragraph = (content, properties = '') => `<w:p><w:pPr>${properties}</w:pPr>${content}</w:p>`;
const cell = (content, properties = '') => `<w:tc><w:tcPr>${properties}</w:tcPr>${content}</w:tc>`;
const row = (cells, properties = '') => `<w:tr><w:trPr>${properties}</w:trPr>${cells}</w:tr>`;
const table = (rows, { width = '<w:tblW w:w="0" w:type="auto"/>', grid = [1500, 4500], properties = '' } = {}) => `<w:tbl><w:tblPr>${width}${properties}</w:tblPr><w:tblGrid>${grid.map(size => `<w:gridCol w:w="${size}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
const margins = (top, right, bottom, left) => `<w:top w:w="${top}" w:type="dxa"/><w:right w:w="${right}" w:type="dxa"/><w:bottom w:w="${bottom}" w:type="dxa"/><w:left w:w="${left}" w:type="dxa"/>`;
const normalStyles = '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>';

async function sourceDocument(body, { styles = normalStyles, retainDemoBody = false } = {}) {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const original = await zip.file('word/document.xml').async('string');
  const content = typeof body === 'function' ? body(original) : body;
  zip.file('word/document.xml', retainDemoBody
    ? original.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, content)
    : original.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>`));
  zip.file('word/styles.xml', `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function convert(body, options) {
  const result = await convertDocx(await sourceDocument(body, options), { formulaFormat: 'mathml', fontMode: 'word', fontSize: 14 });
  return { result, $: load(result.fragment, null, false) };
}

const style = element => new Map(String(element.attr('style') || '').split(';').filter(Boolean).map(declaration => {
  const colon = declaration.indexOf(':');
  return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
}));
const findCell = ($, text) => $('td,th').filter((_, element) => $(element).text().trim() === text).last();
const owned = ($, owner, selector) => owner.find(selector).filter((_, element) => $(element).closest('table')[0] === owner[0]);
const firstTextParagraph = (cellElement) => cellElement.find('p').first();
function visibleParagraphSpacing(paragraphElement) {
  const summed = { before: 0, after: 0 };
  for (const element of [paragraphElement, paragraphElement.parent('div')]) {
    const declarations = style(element);
    const tokens = (declarations.get('margin') || '0px').split(/ +/);
    const before = declarations.get('margin-top') ?? tokens[0];
    const after = declarations.get('margin-bottom') ?? tokens[2] ?? tokens[0];
    summed.before += parseFloat(before);
    summed.after += parseFloat(after);
  }
  return summed;
}

test('Word auto tables retain grid width, centering and fractional column proportions', requiresPandoc, async () => {
  const centered = table(row(cell(paragraph(run('Quarter'))) + cell(paragraph(run('Three quarters')))), { properties: '<w:jc w:val="center"/>' });
  const fractional = table(row(cell(paragraph(run('Fraction left'))) + cell(paragraph(run('Fraction right')))), { grid: [1450, 4550] });
  const { result, $ } = await convert(centered + fractional);
  const centeredTable = findCell($, 'Quarter').closest('table');
  assert.equal(style(centeredTable).get('width'), '400px');
  assert.equal(style(centeredTable).get('max-width'), '100%');
  assert.equal(style(centeredTable).get('margin-left'), 'auto');
  assert.equal(style(centeredTable).get('margin-right'), 'auto');
  assert.deepEqual(owned($, centeredTable, 'col').map((_, element) => style($(element)).get('width')).get(), ['25%', '75%']);
  const fractionalTable = findCell($, 'Fraction left').closest('table');
  const widths = owned($, fractionalTable, 'col').map((_, element) => parseFloat(style($(element)).get('width'))).get();
  assert.equal(widths.length, 2);
  assert.ok(Math.abs(widths[0] - 1450 / 6000 * 100) < 0.001, 'column proportions retain sub-percent precision');
  assert.ok(Math.abs(widths[1] - 4550 / 6000 * 100) < 0.001);
  assert.doesNotMatch(result.fragment, /CampusFormatting|custom-style/);
});

test('Word preferred dxa and pct table widths remain distinct and invalid widths stay safe', requiresPandoc, async () => {
  const makeTable = (name, width, grid = [1500, 4500]) => table(row(cell(paragraph(run(name))) + cell(paragraph(run('Value')))), { width, grid });
  const { $ } = await convert([
    makeTable('Absolute width', '<w:tblW w:w="4500" w:type="dxa"/>'),
    makeTable('Percentage width', '<w:tblW w:w="2500" w:type="pct"/>'),
    makeTable('Missing width', ''),
    makeTable('Invalid width', '<w:tblW w:w="-50" w:type="dxa"/>'),
    makeTable('Non-numeric width', '<w:tblW w:w="bad" w:type="dxa"/>'),
  ].join(''));
  assert.equal(style(findCell($, 'Absolute width').closest('table')).get('width'), '300px');
  assert.equal(style(findCell($, 'Percentage width').closest('table')).get('width'), '50%');
  for (const text of ['Missing width', 'Invalid width', 'Non-numeric width']) {
    assert.equal(findCell($, text).length, 1, `${text} retains its source cell`);
    const sourceWidth = style(findCell($, text).closest('table')).get('width');
    assert.match(sourceWidth, /^(?:auto|[\d.]+(?:px|%))$/, `${text} has a safe fallback width`);
    if (sourceWidth !== 'auto') assert.ok(parseFloat(sourceWidth) > 0, 'invalid dimensions must not collapse a table to zero');
  }
  assert.doesNotMatch($.root().html(), /(?:NaN|Infinity|-\d+(?:\.\d+)?px)/);
});

test('Word cell overrides, paragraph spacing and minimum row height survive on the visible elements', requiresPandoc, async () => {
  const styles = normalStyles + '<w:style w:type="paragraph" w:styleId="Spaced"><w:name w:val="Spaced"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="60" w:after="90" w:line="360" w:lineRule="auto"/></w:pPr></w:style>';
  const body = table(
    row(cell(paragraph(run('Direct spacing'), '<w:pStyle w:val="Spaced"/><w:spacing w:before="30" w:after="45" w:line="240" w:lineRule="auto"/>'), `<w:tcMar>${margins(15, 90, 45, 120)}</w:tcMar>`) + cell(paragraph(run('Inherited spacing'), '<w:pStyle w:val="Spaced"/>')), '<w:trHeight w:val="450" w:hRule="atLeast"/>') +
    row(cell(paragraph(run('Zero spacing'), '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>')) + cell(paragraph(run('Default cell')))),
    { properties: `<w:tblCellMar>${margins(30, 60, 30, 60)}</w:tblCellMar>` },
  );
  const { $ } = await convert(body, { styles });
  assert.equal(style(findCell($, 'Direct spacing')).get('padding'), '1px 6px 3px 8px');
  assert.equal(style(findCell($, 'Inherited spacing')).get('padding'), '2px 4px 2px 4px');
  const directParagraph = firstTextParagraph(findCell($, 'Direct spacing'));
  const direct = style(directParagraph);
  assert.deepEqual(visibleParagraphSpacing(directParagraph), { before: 2, after: 3 });
  assert.equal(direct.get('line-height'), '1');
  const inheritedParagraph = firstTextParagraph(findCell($, 'Inherited spacing'));
  const inherited = style(inheritedParagraph);
  assert.deepEqual(visibleParagraphSpacing(inheritedParagraph), { before: 4, after: 6 });
  assert.equal(inherited.get('line-height'), '1.5');
  const zeroParagraph = firstTextParagraph(findCell($, 'Zero spacing'));
  const zero = style(zeroParagraph);
  assert.deepEqual(visibleParagraphSpacing(zeroParagraph), { before: 0, after: 0 });
  assert.equal(zero.get('line-height'), '1');
  assert.equal(style(findCell($, 'Direct spacing').closest('tr')).get('height'), '30px');
});

test('repeatable header rows retain source bold runs without making every cell bold', requiresPandoc, async () => {
  const repeated = '<w:tblHeader/>';
  const body = table(
    row(cell(paragraph(run('Bold header', '<w:b/>'))) + cell(paragraph(run('Plain header'))), repeated) +
    row(cell(paragraph(run('Category', '<w:b/>'))) + cell(paragraph(run('Second heading'))), repeated) +
    row(cell(paragraph(run('Plain symbol'))) + cell(paragraph(run('Plain explanation'))), repeated),
  );
  const { $ } = await convert(body);
  const sourceTable = findCell($, 'Plain symbol').closest('table');
  assert.equal(owned($, sourceTable, 'tr').length, 3);
  owned($, sourceTable, 'th').each((_, element) => assert.equal(style($(element)).get('font-weight'), 'normal'));
  assert.equal(findCell($, 'Bold header').find('strong').text(), 'Bold header');
  assert.equal(findCell($, 'Category').find('strong').text(), 'Category');
  assert.equal(findCell($, 'Plain symbol').find('strong,b').length, 0);
  assert.equal(findCell($, 'Plain explanation').find('strong,b').length, 0);
});

test('nested table widths and cell margins remain scoped even when outer paragraphs are empty', requiresPandoc, async () => {
  const inner = table(row(cell(paragraph(run('Inner first'))) + cell(paragraph(run('Inner second')))), { grid: [750, 2250], properties: `<w:tblCellMar>${margins(15, 30, 15, 30)}</w:tblCellMar>` });
  const outer = table(row(cell(inner + '<w:p/>', `<w:tcMar>${margins(60, 120, 90, 150)}</w:tcMar>`)), { grid: [6000], properties: '<w:jc w:val="center"/>' });
  const { $ } = await convert(outer);
  const innerTable = findCell($, 'Inner first').closest('table');
  const outerTable = innerTable.parents('table').first();
  assert.equal($('table').length, 2);
  assert.equal(style(innerTable).get('width'), '200px');
  assert.equal(style(outerTable).get('width'), '400px');
  assert.equal(style(outerTable).get('margin-left'), 'auto');
  assert.equal(style(findCell($, 'Inner first')).get('padding'), '1px 2px 1px 2px');
  assert.equal(style(innerTable.closest('td,th')).get('padding'), '4px 8px 6px 10px');
});

test('merged table cells keep their structure and source horizontal category separators', requiresPandoc, async () => {
  const border = '<w:tcBorders><w:bottom w:val="single" w:sz="4" w:color="111111"/></w:tcBorders>';
  const noVertical = '<w:tblBorders><w:top w:val="single" w:sz="8" w:color="111111"/><w:bottom w:val="single" w:sz="8" w:color="111111"/><w:left w:val="nil"/><w:right w:val="nil"/><w:insideV w:val="nil"/><w:insideH w:val="nil"/></w:tblBorders>';
  const body = table(
    row(cell(paragraph(run('Merged category', '<w:b/>')), '<w:gridSpan w:val="2"/>' + border) + cell(paragraph(run('Meaning')), border)) +
    row(cell(paragraph(run('Vertical label')), '<w:vMerge w:val="restart"/>') + cell(paragraph(run('First value'))) + cell(paragraph(run('First meaning')))) +
    row(cell('<w:p/>', '<w:vMerge/>') + cell(paragraph(run('Second value'))) + cell(paragraph(run('Second meaning')))) +
    row(cell(paragraph(run('Second category', '<w:b/>')), '<w:gridSpan w:val="2"/>' + border) + cell(paragraph(run('Second category meaning')), border)) +
    row(cell(paragraph(run('Final symbol'))) + cell(paragraph(run('Final value'))) + cell(paragraph(run('Final meaning')))),
    { grid: [1500, 1500, 3000], properties: noVertical },
  );
  const { $ } = await convert(body);
  assert.equal(findCell($, 'Merged category').attr('colspan'), '2');
  assert.equal(findCell($, 'Vertical label').attr('rowspan'), '2');
  assert.equal(findCell($, 'Second category').attr('colspan'), '2');
  for (const name of ['Merged category', 'Meaning', 'Second category', 'Second category meaning']) {
    assert.match(style(findCell($, name)).get('border-bottom'), /^[\d.]+px solid #[0-9a-f]{3,6}$/i);
  }
  const sourceTable = findCell($, 'Merged category').closest('table');
  for (const element of [sourceTable[0], ...owned($, sourceTable, 'tr,th,td').toArray()]) {
    const declarations = style($(element));
    assert.ok(!declarations.has('border-left') || ['0', 'none'].includes(declarations.get('border-left')));
    assert.ok(!declarations.has('border-right') || ['0', 'none'].includes(declarations.get('border-right')));
  }
});

test('table layout recovery leaves body indentation, numbered math and borderless figures intact', requiresPandoc, async () => {
  const { result, $ } = await convert(original => {
    const inline = original.match(/<m:oMath>[\s\S]*?<\/m:oMath>/)[0];
    const display = original.match(/<m:oMathPara>[\s\S]*?<\/m:oMathPara>/)[0];
    const drawing = original.match(/<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/)[0];
    const dataTable = table(
      row(cell(paragraph(run('Data heading', '<w:b/>'))) + cell(paragraph(run('Data meaning')))) +
      row(cell(paragraph(run('Data value'))) + cell(paragraph(run('42')))),
    );
    return paragraph(run('Body before ') + inline + run(' stays indented.'), '<w:ind w:firstLineChars="200"/>') +
      dataTable +
      paragraph(display + run('(7)')) +
      table(row(cell(paragraph(drawing, '<w:jc w:val="center"/>'))), { grid: [2400] }) +
      paragraph(run('图 1 合成图题'), '<w:jc w:val="center"/>');
  });
  const bodyParagraph = $('p').filter((_, element) => $(element).text().startsWith('Body before')).first();
  assert.match(bodyParagraph.parents('div[style]').first().attr('style'), /text-indent:2em/);
  assert.equal(result.manifest.formulas.length, 2);
  assert.equal($('math').length, 2);
  const equationTable = findCell($, '(7)').closest('table');
  assert.equal(style(equationTable).get('width'), '100%');
  assert.equal(style(equationTable).get('border'), '0');
  assert.equal(style(findCell($, '(7)')).get('text-align'), 'right');
  const figureTable = $('img').closest('table');
  assert.equal(style(figureTable).get('width'), '160px');
  for (const element of [figureTable[0], ...owned($, figureTable, 'tr,th,td').toArray()]) {
    const declarations = style($(element));
    assert.equal(declarations.get('border'), '0');
    assert.equal([...declarations].filter(([name, value]) => /^border-(?:top|bottom|left|right)$/.test(name) && !['0', 'none'].includes(value)).length, 0);
  }
  assert.equal($('img').length, 1);
  assert.doesNotMatch(result.fragment, /CampusFormatting|custom-style/);
});

test('table style inheritance survives temporary identities and direct table/cell overrides', requiresPandoc, async () => {
  const styles = normalStyles +
    `<w:style w:type="table" w:default="1" w:styleId="BaseTable"><w:name w:val="BaseTable"/><w:tblPr><w:tblW w:w="5400" w:type="dxa"/><w:jc w:val="center"/><w:tblCellMar>${margins(30, 60, 45, 90)}</w:tblCellMar></w:tblPr></w:style>` +
    '<w:style w:type="table" w:styleId="DerivedTable"><w:name w:val="DerivedTable"/><w:basedOn w:val="BaseTable"/><w:tblPr><w:tblCellMar><w:left w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>';
  const inherited = table(row(cell(paragraph(run('Inherited table'))) + cell(paragraph(run('Inherited margins')))), { width: '', properties: '<w:tblStyle w:val="DerivedTable"/>' });
  const direct = table(row(cell(paragraph(run('Direct table')), '<w:tcMar><w:left w:w="180" w:type="dxa"/></w:tcMar>') + cell(paragraph(run('Direct margins')))), { width: '<w:tblW w:w="4500" w:type="dxa"/>', properties: '<w:tblStyle w:val="DerivedTable"/><w:tblCellMar><w:right w:w="150" w:type="dxa"/></w:tblCellMar>' });
  const { result, $ } = await convert(inherited + direct, { styles });
  const inheritedTable = findCell($, 'Inherited table').closest('table');
  assert.equal(style(inheritedTable).get('width'), '360px');
  assert.equal(style(inheritedTable).get('margin-left'), 'auto');
  assert.equal(style(inheritedTable).get('margin-right'), 'auto');
  assert.equal(style(findCell($, 'Inherited table')).get('padding'), '2px 4px 3px 8px');
  const directTable = findCell($, 'Direct table').closest('table');
  assert.equal(style(directTable).get('width'), '300px');
  assert.equal(style(directTable).get('margin-left'), 'auto');
  assert.equal(style(findCell($, 'Direct table')).get('padding'), '2px 10px 3px 12px');
  assert.equal(style(findCell($, 'Direct margins')).get('padding'), '2px 10px 3px 8px');
  assert.doesNotMatch(result.fragment, /CampusFormatting|custom-style/);
});

test('source insideH rules follow interior merged-cell boundaries and respect explicit no-border overrides', requiresPandoc, async () => {
  const borders = '<w:tblBorders><w:left w:val="nil"/><w:right w:val="nil"/><w:insideV w:val="nil"/><w:insideH w:val="single" w:sz="4" w:color="111111"/></w:tblBorders>';
  const body = table(
    row(cell(paragraph(run('Spanning symbol')), '<w:vMerge w:val="restart"/>') + cell(paragraph(run('First inside value')))) +
    row(cell('<w:p/>', '<w:vMerge/>') + cell(paragraph(run('No-rule value')), '<w:tcBorders><w:bottom w:val="nil"/></w:tcBorders>')) +
    row(cell(paragraph(run('Last symbol'))) + cell(paragraph(run('Last inside value')))),
    { properties: borders },
  );
  const { $ } = await convert(body);
  const sourceTable = findCell($, 'Spanning symbol').closest('table');
  assert.equal(findCell($, 'Spanning symbol').attr('rowspan'), '2');
  for (const name of ['Spanning symbol', 'First inside value']) {
    assert.match(style(findCell($, name)).get('border-bottom'), /^[\d.]+px solid #[0-9a-f]{3,6}$/i);
  }
  assert.equal(style(findCell($, 'No-rule value')).get('border-bottom'), '0');
  for (const name of ['Last symbol', 'Last inside value']) {
    assert.ok([undefined, '0', 'none'].includes(style(findCell($, name)).get('border-bottom')));
  }
  assert.ok([undefined, '0', 'none'].includes(style(sourceTable).get('border-top')));
  assert.ok([undefined, '0', 'none'].includes(style(sourceTable).get('border-bottom')));
});

test('cell-only horizontal category rules survive unspecified body borders while plain tables use three-line rules', requiresPandoc, async () => {
  const categoryBorders = '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="111111"/><w:bottom w:val="single" w:sz="4" w:color="111111"/><w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders>';
  const grouped = table(
    row(cell(paragraph(run('Cell-rule header', '<w:b/>')), categoryBorders) + cell(paragraph(run('Header meaning', '<w:b/>')), categoryBorders), '<w:tblHeader/>') +
    row(cell(paragraph(run('First group symbol')), '<w:tcBorders><w:bottom w:val="nil"/></w:tcBorders>') + cell(paragraph(run('First group meaning')))) +
    row(cell(paragraph(run('Middle category', '<w:b/>')), categoryBorders) + cell(paragraph(run('Middle category meaning', '<w:b/>')), categoryBorders)) +
    row(cell(paragraph(run('Last group symbol'))) + cell(paragraph(run('Last group meaning')))),
  );
  const plain = table(
    row(cell(paragraph(run('Plain data header'))) + cell(paragraph(run('Plain meaning')))) +
    row(cell(paragraph(run('Plain data value'))) + cell(paragraph(run('Plain result')))),
  );
  const { $ } = await convert(grouped + plain);
  const groupedTable = findCell($, 'Cell-rule header').closest('table');
  assert.equal(findCell($, 'Middle category').closest('tbody').length, 1, 'a body category keeps its interior rules');
  for (const text of ['Cell-rule header', 'Header meaning', 'Middle category', 'Middle category meaning']) {
    const declarations = style(findCell($, text));
    assert.match(declarations.get('border-top'), /^[\d.]+px solid #[0-9a-f]{3,6}$/i);
    assert.match(declarations.get('border-bottom'), /^[\d.]+px solid #[0-9a-f]{3,6}$/i);
  }
  for (const text of ['First group symbol', 'First group meaning', 'Last group symbol', 'Last group meaning']) {
    assert.ok([undefined, '0', 'none'].includes(style(findCell($, text)).get('border-bottom')));
  }
  assert.ok([undefined, '0', 'none'].includes(style(groupedTable).get('border-top')));
  assert.ok([undefined, '0', 'none'].includes(style(groupedTable).get('border-bottom')));
  const plainTable = findCell($, 'Plain data header').closest('table');
  assert.equal(style(plainTable).get('border-top'), '1.5px solid #111');
  assert.equal(style(plainTable).get('border-bottom'), '1.5px solid #111');
  assert.equal(style(findCell($, 'Plain data header')).get('border-bottom'), '1px solid #111');
});
