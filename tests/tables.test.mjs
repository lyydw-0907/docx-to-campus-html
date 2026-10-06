import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { formatThreeLineTables } from '../src/tables.mjs';

function styles($, selector) {
  return Object.fromEntries(String($(selector).attr('style') ?? '').split(';').filter(Boolean).map((declaration) => {
    const colon = declaration.indexOf(':');
    return [declaration.slice(0, colon), declaration.slice(colon + 1)];
  }));
}

test('ordinary tables expose only top, header and bottom rules without data-cell grids', () => {
  const $ = load('<table id="data" style="width:80%;margin:8px 0;border:2px solid red;border-left:2px solid blue"><colgroup style="border-right:2px solid blue"><col style="width:40%;border-left:2px solid red"><col></colgroup><tbody style="border-top:3px solid red"><tr><td id="heading" colspan="2" style="font-weight:bold;padding:6px;text-align:center;border:1px solid #444">标题</td></tr><tr style="border-bottom:3px solid red"><td id="value" style="padding:6px;vertical-align:middle;border-right:1px solid #444">值</td><td>说明</td></tr><tr><td>2</td><td>完整内容</td></tr></tbody></table>');
  const originalText = $('#data').text();
  formatThreeLineTables($);
  assert.equal($('#data').text(), originalText);
  assert.equal($('#heading').attr('colspan'), '2');
  assert.equal(styles($, '#data')['border-top'], '1.5px solid #111');
  assert.equal(styles($, '#data')['border-bottom'], '1.5px solid #111');
  assert.equal(styles($, '#heading')['border-bottom'], '1px solid #111');
  assert.equal(styles($, '#heading').padding, '6px');
  assert.equal(styles($, '#heading')['font-weight'], 'bold');
  assert.equal(styles($, '#data').width, '80%');
  assert.equal(styles($, '#data').margin, '8px 0');
  assert.equal(styles($, '#data col').width, '40%');
  $('#data colgroup,#data col,#data tbody,#data tr,#data td').each((_, element) => {
    const current = styles($, element);
    assert.equal(current.border, '0');
    assert.equal(current['border-left'], undefined);
    assert.equal(current['border-right'], undefined);
    assert.equal(current['border-top'], undefined);
    if (element.attribs.id !== 'heading') assert.equal(current['border-bottom'], undefined);
  });
});

test('multi-row merged headers have a complete bottom boundary, including earlier rowspan cells', () => {
  const $ = load('<table id="merged"><thead><tr><th id="span" rowspan="2">项目</th><th id="group" colspan="2">结果</th></tr><tr><th id="left">均值</th><th id="right">误差</th></tr></thead><tbody><tr><td>A</td><td>10</td><td>1</td></tr><tr><td>B</td><td>20</td><td>2</td></tr></tbody></table>');
  formatThreeLineTables($);
  for (const id of ['span', 'left', 'right']) assert.equal(styles($, `#${id}`)['border-bottom'], '1px solid #111');
  assert.equal(styles($, '#group')['border-bottom'], undefined);
  assert.equal($('#span').attr('rowspan'), '2');
  assert.equal($('#group').attr('colspan'), '2');
  assert.equal($('#merged thead th').length, 4);
  assert.equal($('#merged tbody tr').length, 2);
  $('#merged tbody td').each((_, element) => assert.deepEqual(Object.keys(styles($, element)).filter((name) => name.startsWith('border')), ['border']));
});

test('nested tables format their own header boundary without extending the outer header line', () => {
  const $ = load('<table id="outer"><tr><td id="outer-head"><table id="inner"><tr><td id="inner-head">内表标题</td></tr><tr><td id="inner-data" style="padding:4px;border-left:1px solid #444">内表数据</td></tr></table></td><td>外表标题</td></tr><tr><td id="outer-data">外表数据</td><td>尾项</td></tr></table>');
  const before = $('#outer').text();
  formatThreeLineTables($);
  assert.equal($('#outer').text(), before);
  assert.equal(styles($, '#outer-head')['border-bottom'], '1px solid #111');
  assert.equal(styles($, '#inner-head')['border-bottom'], '1px solid #111');
  assert.equal(styles($, '#inner-data')['border-bottom'], undefined);
  assert.equal(styles($, '#inner-data')['border-left'], undefined);
  assert.equal(styles($, '#inner-data').padding, '4px');
  assert.equal(styles($, '#outer-data')['border-bottom'], undefined);
  assert.equal(styles($, '#inner')['border-top'], '1.5px solid #111');
  assert.equal(styles($, '#inner')['border-bottom'], '1.5px solid #111');
});

test('excluded equation layouts and native MathML matrices remain byte-for-byte unchanged', () => {
  const $ = load('<table id="equation" style="border:0;table-layout:fixed;width:100%"><tr><td style="width:10%;padding:0px"></td><td style="width:80%;padding:0px;text-align:center"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mo>(</mo><mtable columnalign="center"><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable><mo>)</mo></mrow><annotation encoding="application/x-tex">A</annotation></semantics></math></td><td style="width:10%;padding:0px;text-align:right">（2）</td></tr></table><table id="ordinary"><tr><td>标题</td></tr><tr><td>内容</td></tr></table>');
  const equationBefore = $.html($('#equation'));
  const matrixBefore = $.html($('math'));
  formatThreeLineTables($, { excludedTables: new Set([$('#equation')[0]]) });
  assert.equal($.html($('#equation')), equationBefore);
  assert.equal($.html($('math')), matrixBefore);
  assert.equal($('mtable mtr').length, 2);
  assert.equal(styles($, '#ordinary')['border-top'], '1.5px solid #111');
  assert.equal($('#equation td').last().text(), '（2）');
});

test('empty, single-row and header-only tables avoid an extra coincident header rule', () => {
  const $ = load('<table id="empty" style="border:1px solid #444"></table><table id="single"><tr><td id="only">一行</td></tr></table><table id="header-only"><thead><tr><th>A</th></tr><tr><th id="last-header">B</th></tr></thead></table>');
  formatThreeLineTables($);
  assert.equal(styles($, '#empty').border, '0');
  assert.equal(styles($, '#empty')['border-top'], undefined);
  assert.equal(styles($, '#empty')['border-bottom'], undefined);
  for (const id of ['single', 'header-only']) {
    assert.equal(styles($, `#${id}`)['border-top'], '1.5px solid #111');
    assert.equal(styles($, `#${id}`)['border-bottom'], '1.5px solid #111');
  }
  assert.equal(styles($, '#only')['border-bottom'], undefined);
  assert.equal(styles($, '#last-header')['border-bottom'], undefined);
});

test('implicit first-row headers do not draw an invented line through a cell spanning into body', () => {
  const $ = load('<table><tr><td id="crossing" rowspan="2">合并项目</td><td id="first">标题</td></tr><tr><td id="second">值</td></tr></table>');
  formatThreeLineTables($);
  assert.equal($('#crossing').attr('rowspan'), '2');
  assert.equal(styles($, '#crossing')['border-bottom'], undefined);
  assert.equal(styles($, '#first')['border-bottom'], '1px solid #111');
  assert.equal(styles($, '#second')['border-bottom'], undefined);
});

function assertBorderless($, table) {
  const nodes = [table, ...$(table).find('colgroup,col,thead,tbody,tfoot,tr,th,td').toArray().filter(node => $(node).closest('table')[0] === table)];
  for (const node of nodes) {
    const properties = styles($, node);
    assert.equal(properties.border, '0');
    assert.deepEqual(Object.keys(properties).filter(name => name.startsWith('border') && !['border', 'border-collapse', 'border-spacing'].includes(name)), []);
  }
}

test('image grids and captions have no table, row or cell rules while preserving layout', () => {
  const $ = load('<table id="figures" style="width:80%;border-top:2px solid #111"><colgroup style="border-bottom:1px solid #111"><col style="width:50%"></colgroup><tbody><tr><td style="padding:6px;text-align:center;border:1px solid #444"><p><img src="a.png" width="120" height="80"></p><p><strong>图 3-4</strong> 实验结果</p></td><td><p><img src="b.png" width="130" height="90"></p><p>Figure 2 Comparison</p></td></tr><tr style="border-bottom:1px solid #111"><td><p><img src="c.png"></p><p>图3-6 另一结果</p></td><td><p><img src="d.png"></p><p>Fig. 4 Result</p></td></tr></tbody></table>');
  const text = $('#figures').text();
  const images = $('#figures img').map((_, node) => $.html(node)).get();
  formatThreeLineTables($);
  assertBorderless($, $('#figures')[0]);
  assert.equal($('#figures').text(), text);
  assert.deepEqual($('#figures img').map((_, node) => $.html(node)).get(), images);
  assert.equal(styles($, '#figures').width, '80%');
  assert.equal(styles($, '#figures col').width, '50%');
  assert.equal(styles($, '#figures td').padding, '6px');
  assert.equal(styles($, '#figures td')['text-align'], 'center');
});

test('image-only rows, separate caption rows and empty merged cells remain borderless', () => {
  const $ = load('<table id="separate"><tr><td colspan="2"><img src="a.png"></td><td rowspan="2"></td></tr><tr><td colspan="2"><div><span>图 1-2 图题注</span></div></td></tr></table><table id="image-only"><tr><td><img src="b.png"></td></tr></table>');
  formatThreeLineTables($);
  assertBorderless($, $('#separate')[0]);
  assertBorderless($, $('#image-only')[0]);
  assert.equal($('#separate td[colspan]').attr('colspan'), '2');
  assert.equal($('#separate td[rowspan]').attr('rowspan'), '2');
});

test('data and surrounding prose tables containing images retain three-line rules', () => {
  const $ = load('<table id="data"><tr><th>项目</th><th>指标</th></tr><tr><td><img src="a.png"></td><td>42</td></tr></table><table id="mixed"><tr><td><p><img src="b.png"></p><p>图 1 示例</p><p>这是说明正文。</p></td></tr><tr><td>数据</td></tr></table><table id="titled"><caption>表1 结果汇总</caption><tr><td><img src="c.png"></td></tr></table>');
  formatThreeLineTables($);
  for (const id of ['data', 'mixed', 'titled']) assert.equal(styles($, `#${id}`)['border-top'], '1.5px solid #111');
  assert.equal(styles($, '#data th')['border-bottom'], '1px solid #111');
});

test('nested figure layouts are borderless independently of their mixed-content parent', () => {
  const $ = load('<table id="outer"><tr><td>项目资料</td></tr><tr><td><table id="figure"><tr><td><img src="a.png"><p>图 1 示例</p></td></tr></table><p>后续正文。</p></td></tr></table>');
  formatThreeLineTables($);
  assertBorderless($, $('#figure')[0]);
  assert.equal(styles($, '#outer')['border-top'], '1.5px solid #111');
  assert.equal(styles($, '#outer td')['border-bottom'], '1px solid #111');
});

test('nested image-only containers lose all rules but a nested data table protects its parent', () => {
  const $ = load('<table id="layout"><tr><td><table id="inner"><tr><td><img src="a.png"><p>图1 示例</p></td></tr></table></td><td><img src="b.png"></td></tr></table><table id="mixed"><tr><td><img src="c.png"></td></tr><tr><td><table id="values"><tr><td>标题</td></tr><tr><td>12</td></tr></table></td></tr></table>');
  formatThreeLineTables($);
  assertBorderless($, $('#layout')[0]);
  assertBorderless($, $('#inner')[0]);
  for (const id of ['mixed', 'values']) assert.equal(styles($, `#${id}`)['border-top'], '1.5px solid #111');
});

test('captions without an image do not exempt data tables and excluded PNG equation tables stay untouched', () => {
  const $ = load('<table id="caption"><tr><td>图1</td></tr><tr><td>图2</td></tr></table><table id="equation" style="border:0"><tr><td><img src="formula.png"></td><td>(1)</td></tr></table>');
  const before = $.html($('#equation'));
  formatThreeLineTables($, { excludedTables: new Set([$('#equation')[0]]) });
  assert.equal(styles($, '#caption')['border-top'], '1.5px solid #111');
  assert.equal($.html($('#equation')), before);
});

function effectiveMargins($, selector) {
  const result = { top: '0px', right: '0px', bottom: '0px', left: '0px' };
  for (const declaration of String($(selector).attr('style') || '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (name === 'margin') {
      const values = value.split(/ +/);
      [result.top, result.right, result.bottom, result.left] = [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]];
    } else if (name.startsWith('margin-') && Object.hasOwn(result, name.slice(7))) result[name.slice(7)] = value;
  }
  return result;
}

test('fixed-width figure grids center the table and content while retaining image bytes, caption fonts and vertical spacing', () => {
  const $ = load('<table id="center-grid" style="margin-left:0px;margin-right:0px;width:620px;max-width:100%;margin:7px 10px 11px 12px;text-indent:2em"><colgroup><col style="width:45%"><col style="width:55%"></colgroup><tbody><tr><td id="center-cell" style="text-align:left;text-indent:2em;margin-left:20px;padding:4px 9px;vertical-align:top"><div id="center-wrapper" style="font-size:13.333px;margin-left:24px;margin-right:20px;margin:5px 30px 9px 12px;line-height:1.25;text-indent:2em"><p id="center-image" style="text-align:left;margin:3px 12px 4px"><img id="original-image" src="one.png" alt="diagram" width="240" height="160" style="width:240px;height:160px;max-width:100%;display:inline-block"></p><p id="center-caption" style="font-size:12px;white-space:nowrap;margin:6px 18px 8px 24px"><strong>图 1</strong> caption stays intact</p></div></td><td><p><img src="two.png" width="280" height="170"></p><figcaption id="center-figcaption" style="font-size:11px;line-height:1.4;margin-top:2px;margin-bottom:6px">Figure 2 Second result</figcaption></td></tr></tbody></table>');
  const image = $.html($('#original-image'));
  const text = $('#center-grid').text();
  formatThreeLineTables($);
  assertBorderless($, $('#center-grid')[0]);
  assert.equal($('#center-grid').text(), text);
  assert.equal($.html($('#original-image')), image);
  assert.equal(styles($, '#center-grid').width, '620px');
  assert.equal(styles($, '#center-grid')['max-width'], '100%');
  assert.equal(styles($, '#center-grid')['text-indent'], '0px');
  assert.deepEqual(effectiveMargins($, '#center-grid'), { top: '7px', right: 'auto', bottom: '11px', left: 'auto' });
  assert.deepEqual($('#center-grid col').map((_, node) => styles($, node).width).get(), ['45%', '55%']);
  for (const id of ['center-cell', 'center-wrapper', 'center-image', 'center-caption', 'center-figcaption']) {
    const declarations = styles($, `#${id}`);
    assert.equal(declarations['text-align'], 'center', `${id} aligns its own content`);
    assert.equal(declarations['text-indent'], '0px', `${id} does not inherit the body indent`);
    assert.equal(effectiveMargins($, `#${id}`).left, '0px');
    assert.equal(effectiveMargins($, `#${id}`).right, '0px');
  }
  assert.deepEqual(effectiveMargins($, '#center-wrapper'), { top: '5px', right: '0px', bottom: '9px', left: '0px' });
  assert.deepEqual(effectiveMargins($, '#center-caption'), { top: '6px', right: '0px', bottom: '8px', left: '0px' });
  assert.equal(styles($, '#center-cell').padding, '4px 9px');
  assert.equal(styles($, '#center-cell')['vertical-align'], 'top');
  assert.equal(styles($, '#center-wrapper')['font-size'], '13.333px');
  assert.equal(styles($, '#center-wrapper')['line-height'], '1.25');
  assert.equal(styles($, '#center-caption')['font-size'], '12px');
  assert.equal(styles($, '#center-caption')['white-space'], 'nowrap');
  assert.equal(styles($, '#center-figcaption')['font-size'], '11px');
  assert.equal(styles($, '#center-figcaption')['line-height'], '1.4');
  assert.equal(effectiveMargins($, '#center-figcaption').top, '2px');
  assert.equal(effectiveMargins($, '#center-figcaption').bottom, '6px');
  assert.equal($('#center-caption strong').text(), '图 1');
});

test('nested pure figure containers each center within their own width without changing their structure', () => {
  const $ = load('<table id="outer-figures" style="width:760px;text-indent:2em;margin:10px 0px 14px"><tbody><tr><td id="outer-figure-cell"><div id="inner-holder" style="text-align:left;text-indent:2em;margin-left:20px"><table id="inner-figures" style="width:320px;margin-left:0px;margin-right:auto"><tbody><tr><td id="inner-figure-cell" style="text-align:left;text-indent:1em"><p id="inner-figure-image" style="text-indent:2em"><img src="nested.png" width="260" height="140"></p><p id="inner-figure-caption" style="font-size:13px;margin-top:3px;margin-bottom:7px">图 3 Nested figure</p></td></tr></tbody></table></div></td><td><p><img src="adjacent.png" width="220" height="150"></p><p>图 4 Adjacent figure</p></td></tr></tbody></table>');
  const images = $('#outer-figures img').map((_, node) => $.html(node)).get();
  const text = $('#outer-figures').text();
  formatThreeLineTables($);
  for (const [id, width] of [['outer-figures', '760px'], ['inner-figures', '320px']]) {
    assertBorderless($, $(`#${id}`)[0]);
    assert.equal(styles($, `#${id}`).width, width);
    assert.equal(effectiveMargins($, `#${id}`).left, 'auto');
    assert.equal(effectiveMargins($, `#${id}`).right, 'auto');
    assert.equal(styles($, `#${id}`)['text-indent'], '0px');
  }
  for (const id of ['outer-figure-cell', 'inner-holder', 'inner-figure-cell', 'inner-figure-image', 'inner-figure-caption']) {
    assert.equal(styles($, `#${id}`)['text-align'], 'center');
    assert.equal(styles($, `#${id}`)['text-indent'], '0px');
  }
  assert.equal($('#outer-figures > tbody > tr > td').length, 2);
  assert.equal($('#inner-figures').parents('table').length, 1);
  assert.deepEqual($('#outer-figures img').map((_, node) => $.html(node)).get(), images);
  assert.equal($('#outer-figures').text(), text);
  assert.equal(styles($, '#inner-figure-caption')['font-size'], '13px');
  assert.equal(effectiveMargins($, '#inner-figure-caption').bottom, '7px');
});

test('centering a nested figure does not reset mixed parent text, neighboring data or outer layout margins', () => {
  const $ = load('<table id="mixed-parent" style="width:700px;margin-left:12px;margin-right:4px;text-indent:2em"><tbody><tr><td id="mixed-parent-cell" style="text-align:justify;text-indent:2em;margin-left:14px"><p id="mixed-prose" style="text-align:justify;text-indent:2em;margin:6px 9px 12px 15px;font-size:16px">This paragraph stays in its original layout.</p><table id="nested-pure" style="width:260px;margin-left:0px"><tbody><tr><td><div style="text-indent:2em;text-align:left"><p><img src="nested-figure.png" width="220" height="130"></p><p>图 5 Inner result</p></div></td></tr></tbody></table><div id="mixed-after" style="text-indent:2em;text-align:left;margin-left:18px"><p>Following prose remains untouched.</p></div></td></tr></tbody></table><table id="data-neighbor" style="width:440px;margin-left:7px;text-indent:1em"><tr><td id="data-neighbor-cell" style="text-align:right;text-indent:1em"><p id="data-neighbor-text" style="text-align:right;text-indent:1em;margin-left:8px">Data value 42</p><img src="data-thumbnail.png" width="60" height="40"></td></tr></table>');
  const prose = $.html($('#mixed-prose'));
  const after = $.html($('#mixed-after'));
  const dataText = $.html($('#data-neighbor-text'));
  formatThreeLineTables($);
  assertBorderless($, $('#nested-pure')[0]);
  assert.equal(effectiveMargins($, '#nested-pure').left, 'auto');
  assert.equal(effectiveMargins($, '#nested-pure').right, 'auto');
  assert.equal($.html($('#mixed-prose')), prose);
  assert.equal($.html($('#mixed-after')), after);
  assert.equal($.html($('#data-neighbor-text')), dataText);
  assert.equal(styles($, '#mixed-parent')['margin-left'], '12px');
  assert.equal(styles($, '#mixed-parent')['margin-right'], '4px');
  assert.equal(styles($, '#mixed-parent')['text-indent'], '2em');
  assert.equal(styles($, '#mixed-parent-cell')['text-align'], 'justify');
  assert.equal(styles($, '#mixed-parent-cell')['text-indent'], '2em');
  assert.equal(styles($, '#data-neighbor')['margin-left'], '7px');
  assert.equal(styles($, '#data-neighbor-cell')['text-align'], 'right');
  assert.equal(styles($, '#data-neighbor-cell')['text-indent'], '1em');
  for (const id of ['mixed-parent', 'data-neighbor']) assert.equal(styles($, `#${id}`)['border-top'], '1.5px solid #111');
});

test('figure centering keeps excluded equation layouts exact and leaves caption-only table alignment alone', () => {
  const $ = load('<table id="excluded-formula" style="width:100%;margin:8px 0px;table-layout:fixed;border:0"><tbody><tr><td style="width:10%;padding:0px"></td><td style="width:80%;text-align:center;padding:0px"><div style="text-indent:0px;margin-left:2px"><img src="formula.png" width="180" height="40" style="width:180px;height:40px;vertical-align:-3px;display:inline-block"></div></td><td style="width:10%;text-align:right;padding:0px">（7）</td></tr></tbody></table><table id="caption-only" style="width:350px;margin-left:9px;margin-right:1px;text-indent:2em"><tr><td><p id="caption-alone" style="font-size:12px;text-align:left;text-indent:2em;margin-left:10px">图 6 Caption without an image</p></td></tr></table><table id="captioned-figure" style="width:240px"><caption id="table-caption" style="font-size:11px;text-align:left;text-indent:2em;margin-top:2px;margin-bottom:5px;margin-left:20px">图 7 Real figure</caption><tr><td><img src="real-figure.png" width="210" height="110"></td></tr></table>');
  const equation = $.html($('#excluded-formula'));
  const captionAlone = $.html($('#caption-alone'));
  formatThreeLineTables($, { excludedTables: new Set([$('#excluded-formula')[0]]) });
  assert.equal($.html($('#excluded-formula')), equation);
  assert.equal($.html($('#caption-alone')), captionAlone);
  assert.equal(styles($, '#caption-only')['margin-left'], '9px');
  assert.equal(styles($, '#caption-only')['margin-right'], '1px');
  assert.equal(styles($, '#caption-only')['text-indent'], '2em');
  assert.equal(effectiveMargins($, '#captioned-figure').left, 'auto');
  assert.equal(effectiveMargins($, '#captioned-figure').right, 'auto');
  assert.equal(styles($, '#table-caption')['text-align'], 'center');
  assert.equal(styles($, '#table-caption')['text-indent'], '0px');
  assert.equal(styles($, '#table-caption')['font-size'], '11px');
  assert.deepEqual(effectiveMargins($, '#table-caption'), { top: '2px', right: '0px', bottom: '5px', left: '0px' });
});
