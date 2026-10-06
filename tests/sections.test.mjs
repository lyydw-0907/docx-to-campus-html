import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { splitCampusSections } from '../src/sections.mjs';

const fieldHeadings = [
  '研究目的：', '国、内外研究现状和发展动态:', '研究内容', '创新点与项目特色',
  '技术路线，拟解决的问题', '项目研究进度安排', '已有基础', '预期成果'
];
const expectedIds = ['research-purpose', 'research-status', 'research-content', 'innovation', 'technical-route', 'schedule', 'conditions', 'expected-results'];

function parse(fragment) { return load(fragment, {}, false); }
function assertNoSplit(fragment) {
  const result = splitCampusSections(fragment);
  assert.deepEqual(result.sections, []);
  assert.ok(result.warnings.length, 'an uncertain split must explain why the whole document is retained');
}

test('confirmed sibling headings inside one document cell map to school fields, including the conditions alias', () => {
  const fragment = `<div style="font-family:Arial;font-size:14px;line-height:1.5;color:#111"><p>封面单独保留</p><table style="width:100%;border:1px solid #111"><tr><td style="font-size:16px;padding:8px;border:1px solid #111">${fieldHeadings.map((heading, index) => `<h2>${heading}</h2><p data-check="body-${index}">第 ${index + 1} 段测试正文</p>`).join('')}<h2>参考文献</h2><p>合成测试文献</p></td></tr></table><p>附件单独保留</p></div>`;
  const { sections, warnings } = splitCampusSections(fragment);
  assert.deepEqual(sections.slice(0, 8).map(section => section.id), expectedIds);
  assert.deepEqual(sections.slice(0, 8).map(section => section.kind), Array(8).fill('field'));
  assert.equal(sections[1].title, '国内外研究现状和发展动态');
  assert.equal(sections[6].title, '已具备的条件，尚缺少的条件及解决方法');
  assert.equal(sections[6].sourceHeading, '已有基础');
  assert.equal(sections[8].title, '参考文献');
  assert.equal(sections[8].kind, 'unassigned');
  assert.ok(warnings.some(warning => warning.includes('参考文献')));
  sections.forEach((section, index) => {
    const $ = parse(section.fragment);
    assert.equal($('p').length, 1);
    assert.equal($('p').text(), index === 8 ? '合成测试文献' : `第 ${index + 1} 段测试正文`);
    assert.equal($('table').length, 0, 'the source layout cell is not exported as a document-wide table');
    assert.equal(section.fragment.includes('封面单独保留'), false);
    assert.equal(section.fragment.includes('附件单独保留'), false);
    assert.equal($('h2').length, index === 8 ? 1 : 0, 'only confirmed outer field labels are removed');
  });
});

test('retained subtrees keep styles, mathematical structure, image attributes, captions and numbered equations exactly', () => {
  const body = '<h3 style="font-size:18px">1.2 研究目的</h3><div style="margin:0px;font-size:16px"><p style="text-indent:2em;text-align:justify"><strong>合成正文</strong><math display="inline" xmlns="http://www.w3.org/1998/Math/MathML" style="font-size:16px"><semantics><mfrac><mi>x</mi><mi>y</mi></mfrac><annotation encoding="application/x-tex">x/y</annotation></semantics></math></p></div><table style="width:100%;border:0;table-layout:fixed"><tr><td style="width:80%;text-align:center"><math display="block"><msub><mi>a</mi><mn>1</mn></msub></math></td><td style="width:10%;text-align:right">(1)</td></tr></table><p style="text-align:center"><img src="assets/plot.png" width="123.5" height="88" style="width:123.5px;height:88px;vertical-align:0px"></p><p style="font-size:13.333px;text-align:center">图 1 合成题注</p>';
  const result = splitCampusSections(`<div style="font-size:14px"><h2>研究目的</h2>${body}<h2>研究内容</h2><p>另一个字段</p></div>`, { assets: [{ filename: 'plot.png', src: 'assets/plot.png', kind: 'image' }] });
  const original = parse(body);
  const extracted = parse(result.sections[0].fragment);
  assert.deepEqual(extracted('h3,p,math,table,img').map((_, node) => extracted.html(node)).get(), original('h3,p,math,table,img').map((_, node) => original.html(node)).get());
  assert.deepEqual(result.sections[0].assetFilenames, ['plot.png']);
  assert.equal(result.sections[0].formulaCount, 2);
  assert.equal(result.sections[0].imageCount, 1);
});

test('same-name lower headings are retained as internal subsections rather than mistaken for blue labels', () => {
  const { sections } = splitCampusSections('<div><h2>研究目的</h2><p>开头</p><h3>研究目的</h3><p>内部目的</p><div><h2>研究内容</h2><p>内部讨论的内容标题</p></div><h2>研究内容</h2><p>外层正文</p></div>');
  assert.equal(sections.length, 2);
  const purpose = parse(sections[0].fragment);
  assert.equal(purpose('h3').text(), '研究目的');
  assert.equal(purpose('div h2').text(), '研究内容');
  assert.equal(purpose('p').last().text(), '内部讨论的内容标题');
  assert.equal(parse(sections[1].fragment)('p').text(), '外层正文');
});

test('a unique strongest container wins over an internal section-shaped example without discarding that example', () => {
  const { sections } = splitCampusSections('<div><h2>研究目的</h2><div><h3>研究目的</h3><p>示例甲</p><h3>研究内容</h3><p>示例乙</p></div><h2>研究内容</h2><p>正文</p><h2>预期成果</h2><p>成果</p></div>');
  assert.deepEqual(sections.map(section => section.id), ['research-purpose', 'research-content', 'expected-results']);
  assert.equal(parse(sections[0].fragment)('h3').length, 2);
});

test('unknown sibling headings define unassigned sections and cannot leak into the preceding field', () => {
  const { sections } = splitCampusSections('<div><h2>研究目的</h2><p>目的正文</p><h2>补充说明</h2><p>未分配正文</p><h2>研究内容</h2><p>内容正文</p><h2>参考文献：</h2><ol><li>合成文献</li></ol></div>');
  assert.equal(sections.length, 4);
  assert.equal(parse(sections[0].fragment)('p').text(), '目的正文');
  assert.equal(sections[1].kind, 'unassigned');
  assert.equal(parse(sections[1].fragment)('h2').text(), '补充说明');
  assert.equal(parse(sections[1].fragment)('p').text(), '未分配正文');
  assert.equal(sections[3].kind, 'unassigned');
  assert.equal(parse(sections[3].fragment)('h2').text(), '参考文献：');
  assert.equal(parse(sections[3].fragment)('li').text(), '合成文献');
});

test('content before the first field and a higher-level afterword are kept separately from field bodies', () => {
  const { sections } = splitCampusSections('<div><p>栏目之前</p><h2>研究目的</h2><p>甲</p><h2>研究内容</h2><p>乙</p><h1>附录</h1><p>栏目之后</p></div>');
  const fields = sections.filter(section => section.kind === 'field');
  assert.deepEqual(fields.map(section => parse(section.fragment)('p').text()), ['甲', '乙']);
  assert.equal(sections[0].kind, 'unassigned');
  assert.equal(parse(sections[0].fragment)('p').text(), '栏目之前');
  assert.equal(sections.at(-1).kind, 'unassigned');
  assert.equal(parse(sections.at(-1).fragment)('h1').text(), '附录');
  assert.equal(parse(sections.at(-1).fragment)('p').text(), '栏目之后');
});

test('asset matching uses exact sources, counts repeated formula pictures as occurrences and lists files only once', () => {
  const assets = [
    { filename: 'formula-one.png', src: 'data:image/png;base64,Zm9ybXVsYQ==', mime: 'image/png', kind: 'formula', data: Buffer.from('formula'), width: 10, height: 10 },
    { filename: 'plot.png', src: 'assets/plot.png', kind: 'image' },
    { filename: 'unused.png', src: 'assets/unused.png', kind: 'image' }
  ];
  const { sections } = splitCampusSections('<h2>研究目的</h2><p><img src="assets/plot.png"><img src="data:image/png;base64,Zm9ybXVsYQ=="><img src="data:image/png;base64,Zm9ybXVsYQ=="><img src="assets/not-plot.png"><math><mi>x</mi></math></p><h2>研究内容</h2><p>文字</p>', { assets });
  assert.deepEqual(sections[0].assetFilenames, ['plot.png', 'formula-one.png']);
  assert.equal(sections[0].formulaCount, 3);
  assert.equal(sections[0].imageCount, 2);
  assert.deepEqual(sections[1].assetFilenames, []);
  assert.equal(sections[1].formulaCount, 0);
  assert.equal(sections[1].imageCount, 0);
});

test('inherited typography survives removal of document tables without importing their geometry', () => {
  const { sections } = splitCampusSections('<div style="font-family:serif;font-size:20px;color:#222;margin:20px"><table style="width:800px;border:2px solid red;line-height:1.4"><tbody style="font-style:italic"><tr style="height:200px"><td style="font-size:80%;font-weight:normal;text-align:left;padding:30px;border:1px solid blue"><h2>研究目的</h2><p style="font-size:14px;text-indent:2em">甲</p><h2>研究内容</h2><p>乙</p></td></tr></tbody></table></div>');
  const $ = parse(sections[0].fragment);
  const wrapperStyles = $('div').map((_, node) => $(node).attr('style')).get().join(';');
  assert.match(wrapperStyles, /font-family:serif/);
  assert.match(wrapperStyles, /font-size:20px/);
  assert.match(wrapperStyles, /font-size:80%/);
  assert.match(wrapperStyles, /line-height:1.4/);
  assert.match(wrapperStyles, /font-style:italic/);
  assert.doesNotMatch(wrapperStyles, /(?:^|;)(?:width|height|border|padding|margin):/);
  assert.equal($('p').attr('style'), 'font-size:14px;text-indent:2em');
});

test('heading-shaped data in multi-cell tables is not an application field container', () => {
  assertNoSplit('<table><tr><td><h2>研究目的</h2><p>数据甲</p><h2>研究内容</h2><p>数据乙</p></td><td>另一数据列</td></tr></table>');
  assertNoSplit('<table><tr><td><div><h2>研究目的</h2><h2>研究内容</h2></div></td></tr><tr><td>另一数据行</td></tr></table>');
});

test('nested single-cell layout wrappers are supported while nested real data tables do not create boundaries', () => {
  const { sections } = splitCampusSections('<table><tr><td><table><tr><td><h2>研究目的</h2><table><tr><td><h2>研究内容</h2></td><td>数据</td></tr></table><h2>研究内容</h2><p>内容正文</p></td></tr></table></td></tr></table>');
  assert.equal(sections.length, 2);
  assert.equal(parse(sections[0].fragment)('table h2').text(), '研究内容');
  assert.equal(parse(sections[1].fragment)('p').text(), '内容正文');
});

test('ambiguous independent containers and tied nested containers produce no partial split', () => {
  assertNoSplit('<div><h2>研究目的</h2><p>甲</p><h2>研究内容</h2><p>乙</p></div><div><h2>创新点与项目特色</h2><p>丙</p><h2>预期成果</h2><p>丁</p></div>');
  assertNoSplit('<div><h2>研究目的</h2><div><h3>研究目的</h3><h3>研究内容</h3></div><h2>研究内容</h2></div>');
  assertNoSplit('<div><h2>研究目的</h2><h2>研究内容</h2><h2>预期成果</h2></div><div><h2>创新点与项目特色</h2><h2>项目研究进度安排</h2></div>');
});

test('duplicate confirmed headings, including normalized conditions aliases, produce no partial split', () => {
  assertNoSplit('<h2>研究目的</h2><p>甲</p><h2>研究内容</h2><p>乙</p><h2>研究目的：</h2><p>丙</p>');
  assertNoSplit('<h2>已有基础</h2><h2>研究目的</h2><h2>已具备的条件、尚缺少的条件及解决方法：</h2>');
});

test('inconsistent outer heading levels fail conservatively rather than borrowing subsection text', () => {
  assertNoSplit('<h2>研究目的</h2><p>甲</p><h3>研究内容</h3><p>乙</p>');
  assertNoSplit('<h2>研究目的</h2><p>甲</p><h3>预期成果</h3><p>错层内容</p><h2>研究内容</h2><p>乙</p>');
  assertNoSplit('<h2>研究目的</h2><p>甲</p><h1>新篇章</h1><h2>研究内容</h2><p>乙</p>');
});

test('paragraph keywords, arbitrary numbering prefixes and a lone heading do not cause a split', () => {
  assertNoSplit('<p>研究目的</p><p>研究内容</p><p>正文提到预期成果和已有基础。</p>');
  assertNoSplit('<h2>1. 研究目的</h2><p>甲</p><h2>2. 研究内容</h2><p>乙</p>');
  assertNoSplit('<h2>研究目的</h2><p>甲</p>');
});

test('punctuation and whitespace normalization does not alter headings that are retained in the body', () => {
  const { sections } = splitCampusSections('<h2> 研 究 目 的 ： </h2><p>甲</p><h2>国，内 外研究现状和发展动态：</h2><p>乙</p><h2>已具备的条件, 尚缺少的条件及解决方法:</h2><h3>已具备的条件</h3><p>丙</p>');
  assert.deepEqual(sections.map(section => section.id), ['research-purpose', 'research-status', 'conditions']);
  assert.equal(parse(sections[2].fragment)('h3').text(), '已具备的条件');
});
