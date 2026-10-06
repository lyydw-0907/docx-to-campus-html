import test from 'node:test';
import assert from 'node:assert/strict';
import { createSectionView } from '../public/section-view.js';

function fixture() {
  return {
    fragment: '<div>whole<img src="data:image/png;base64,YQ=="></div>', preview: 'whole-preview',
    assets: [{ filename: 'a.png', kind: 'image' }],
    manifest: { options: { imageMode: 'embedded' }, formulas: [{ tex: 'x' }] },
    sections: [
      { id: 'purpose', title: '研究目的', kind: 'field', fragment: '<p>purpose</p>', preview: 'purpose-preview', assetFilenames: [], formulaCount: 0, imageCount: 0 },
      { id: 'content', title: '研究内容', kind: 'field', fragment: '<p>content<img src="data:image/png;base64,YQ=="></p>', preview: 'content-preview', assetFilenames: ['a.png'], formulaCount: 1, imageCount: 1 },
      { id: 'unassigned-1', title: '参考文献', kind: 'unassigned', fragment: '<p>references</p>', preview: 'references-preview', assetFilenames: [], formulaCount: 0, imageCount: 0 },
    ],
  };
}

test('default field is copyable without waiting for unrelated fields images', () => {
  const view = createSectionView(); view.setResult(fixture());
  assert.equal(view.snapshot().id, 'purpose');
  assert.equal(view.snapshot().copyable, true);
  view.select('content');
  assert.equal(view.snapshot().needsMapping, true);
  assert.equal(view.snapshot().copyable, false);
  assert.equal(view.snapshot().preview, 'content-preview');
});

test('selection uses mapped section and invalidation restores that same local section', () => {
  const view = createSectionView(); const original = fixture(); view.setResult(original);
  view.select('content'); const stamp = view.token();
  const mapped = { fragment: 'mapped-whole', sections: original.sections.map(section => ({ ...section,
    fragment: section.id === 'content' ? '<p>content<img src="https://school.test/a.png"></p>' : section.fragment,
    preview: `mapped-${section.id}` })) };
  view.setMapped(mapped);
  assert.equal(view.matches(stamp), true);
  assert.equal(view.snapshot().copyable, true);
  assert.match(view.snapshot().fragment, /https:\/\/school.test/);
  assert.equal(view.snapshot().preview, 'content-preview');
  view.select('purpose'); assert.equal(view.snapshot().preview, 'purpose-preview');
  view.select('whole'); assert.equal(view.snapshot().preview, 'whole-preview');
  view.select('content'); const mappedStamp = view.token(); view.resetMapped();
  assert.equal(view.matches(mappedStamp), false);
  assert.equal(view.snapshot().id, 'content');
  assert.equal(view.snapshot().fragment, original.sections[1].fragment);
  assert.equal(view.snapshot().copyable, false);
});

test('async copy token is invalid even after switching away and back or reconverting', () => {
  const view = createSectionView(); view.setResult(fixture()); const stamp = view.token();
  view.select('content'); view.select('purpose');
  assert.equal(view.matches(stamp), false);
  const second = view.token(); view.setResult(fixture());
  assert.equal(view.matches(second), false);
  const third = view.token(); view.setResult(undefined);
  assert.equal(view.matches(third), false);
  assert.equal(view.snapshot(), undefined);
});

test('image-free unassigned content is copyable while whole copy waits for its images', () => {
  const view = createSectionView(); view.setResult(fixture());
  view.select('unassigned-1');
  assert.equal(view.snapshot().eligible, true); assert.equal(view.snapshot().copyable, true);
  assert.ok(view.snapshot().fragment);
  view.select('whole');
  assert.equal(view.snapshot().eligible, true); assert.equal(view.snapshot().copyable, false);
  assert.equal(view.snapshot().needsMapping, true);
  assert.equal(view.items().length, 4);
});

test('image-free whole documents with school fields copy the complete original including cover and unassigned text', () => {
  const view = createSectionView(); const result = fixture();
  result.assets = [];
  result.fragment = '<header>合成封面</header><h1>研究目的</h1><p>purpose</p><h1>参考文献</h1><p>references</p><footer>合成签名</footer>';
  view.setResult(result); view.select('whole');
  const whole = view.snapshot();
  assert.equal(whole.kind, 'whole'); assert.equal(whole.eligible, true);
  assert.equal(whole.needsMapping, false); assert.equal(whole.copyable, true);
  assert.equal(whole.fragment, result.fragment);
  assert.notEqual(whole.fragment, result.sections.map(section => section.fragment).join(''));
  assert.equal(whole.preview, result.preview);
  assert.deepEqual(whole.assetFilenames, []);
  view.select('unassigned-1'); assert.equal(view.snapshot().copyable, true);
});

test('empty field and mismatched mapped section boundaries stop copying', () => {
  const view = createSectionView(); const result = fixture();
  result.sections[0].fragment = '<div> \n </div>'; view.setResult(result);
  assert.equal(view.snapshot().empty, true); assert.equal(view.snapshot().copyable, false);
  assert.throws(() => view.setMapped({ fragment: 'mapped-whole', sections: result.sections.slice(1) }), /栏目/);
  assert.throws(() => view.select('unknown'), /不存在/);
});

test('non-application documents retain existing whole fragment behavior', () => {
  const view = createSectionView(); const result = fixture(); result.sections = [];
  result.assets = []; result.fragment = '<p>普通正文</p>'; view.setResult(result);
  assert.equal(view.snapshot().id, 'whole'); assert.equal(view.snapshot().copyable, true);
  assert.equal(view.snapshot().fragment, result.fragment);
});

test('mapping one field preserves its cache across selection without mapping other fields or loading school previews', () => {
  const view = createSectionView(); const result = fixture();
  result.assets.push({ filename: 'b.png', kind: 'image' });
  result.sections.push({ id: 'progress', title: '项目研究进度安排', kind: 'field',
    fragment: '<p>progress<img src="data:image/png;base64,Yg=="></p>', preview: 'progress-preview',
    assetFilenames: ['b.png'], formulaCount: 0, imageCount: 1 });
  view.setResult(result);
  const purposeStamp = view.token();
  const mappedContent = { ...result.sections[1], fragment: '<p>content<img src="https://school.test/a.png"></p>',
    preview: '<img src="https://school.test/a.png">' };
  view.setMappedSection(mappedContent);
  assert.equal(view.matches(purposeStamp), true);
  assert.equal(view.snapshot().id, 'purpose');
  assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().copyable, true);
  assert.equal(view.snapshot().fragment, result.sections[0].fragment);
  view.select('content');
  assert.equal(view.snapshot().fragment, mappedContent.fragment);
  assert.equal(view.snapshot().preview, 'content-preview');
  assert.equal(view.snapshot().needsMapping, false);
  assert.equal(view.snapshot().copyable, true);
  view.select('progress');
  assert.equal(view.snapshot().needsMapping, true);
  assert.equal(view.snapshot().mapped, false);
  const progressStamp = view.token();
  const mappedProgress = { ...result.sections[3], fragment: '<p>progress<img src="https://school.test/b.png"></p>' };
  view.setMappedSection(mappedProgress);
  assert.equal(view.matches(progressStamp), true);
  assert.equal(view.snapshot().fragment, mappedProgress.fragment);
  assert.equal(view.snapshot().preview, 'progress-preview');
  assert.equal(view.snapshot().copyable, true);
  view.select('content'); assert.equal(view.snapshot().fragment, mappedContent.fragment);
  view.select('whole');
  assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().copyable, false);
  assert.equal(view.snapshot().fragment, result.fragment);
});

test('reset invalidates scoped mapped sources and clears all field caches without losing selection', () => {
  const view = createSectionView(); const result = fixture(); view.setResult(result);
  view.setMappedSection({ ...result.sections[0], fragment: '<p>mapped purpose</p>' });
  view.setMappedSection({ ...result.sections[1], fragment: '<p>mapped content</p>' });
  view.select('content'); const stamp = view.token();
  view.resetMapped();
  assert.equal(view.matches(stamp), false);
  assert.equal(view.snapshot().id, 'content');
  assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().fragment, result.sections[1].fragment);
  assert.equal(view.snapshot().needsMapping, true);
  view.select('purpose');
  assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().fragment, result.sections[0].fragment);
  assert.equal(view.snapshot().copyable, true);
  const resetStamp = view.token(); view.resetMapped();
  assert.equal(view.matches(resetStamp), true);
});

test('scoped mapping rejects missing or changed column identity and assets without replacing a valid cache', () => {
  const view = createSectionView(); const result = fixture(); view.setResult(result); view.select('content');
  const mappedContent = { ...result.sections[1], fragment: '<p>valid mapped content</p>' };
  view.setMappedSection(mappedContent);
  for (const change of [
    section => { section.id = 'unknown'; },
    section => { section.title = '研究目的'; },
    section => { section.kind = 'unassigned'; },
    section => { section.assetFilenames = ['b.png']; },
    section => { delete section.assetFilenames; },
    section => { delete section.fragment; },
  ]) {
    const invalid = structuredClone(mappedContent); change(invalid);
    assert.throws(() => view.setMappedSection(invalid), /映射|栏目/);
    assert.equal(view.snapshot().fragment, mappedContent.fragment);
  }
  assert.throws(() => view.setMappedSection({ id: 'whole', title: '整篇文档', kind: 'whole',
    fragment: '<p>whole</p>', assetFilenames: ['wrong-image.png'] }), /栏目/);
  const replacement = fixture(); replacement.sections[1].assetFilenames = ['different.png'];
  view.setResult(replacement);
  assert.throws(() => view.setMappedSection(mappedContent), /栏目/);
  view.setResult(undefined);
  assert.throws(() => view.setMappedSection(mappedContent), /无效/);
});

test('new conversion clears scoped cache and marks pending copies stale even when column ids match', () => {
  const view = createSectionView(); const result = fixture(); view.setResult(result); view.select('content');
  const stamp = view.token();
  view.setMappedSection({ ...result.sections[1], fragment: '<p>old mapped content</p>' });
  const replacement = fixture(); view.setResult(replacement); view.select('content');
  assert.equal(view.matches(stamp), false);
  assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().fragment, replacement.sections[1].fragment);
  assert.equal(view.snapshot().copyable, false);
});

test('scoped whole mapping works with or without school fields and retains the original local preview', () => {
  for (const sectioned of [false, true]) {
    const view = createSectionView(); const result = fixture();
    if (!sectioned) result.sections = [];
    view.setResult(result); view.select('whole');
    const stamp = view.token();
    view.setMappedSection({ id: 'whole', title: '整篇文档', kind: 'whole',
      fragment: '<p>whole<img src="https://school.test/a.png"></p>', preview: 'school-preview', assetFilenames: ['a.png'] });
    assert.equal(view.matches(stamp), true);
    assert.equal(view.snapshot().mapped, true);
    assert.equal(view.snapshot().copyable, true);
    assert.equal(view.snapshot().preview, 'whole-preview');
    assert.match(view.snapshot().fragment, /https:\/\/school.test/);
    view.resetMapped();
    assert.equal(view.snapshot().copyable, false);
    assert.equal(view.snapshot().fragment, result.fragment);
  }
});

test('whole and field mapped bodies cache independently and address changes reset both caches', () => {
  const view = createSectionView(); const result = fixture(); view.setResult(result);
  const field = { ...result.sections[1], fragment: '<p>mapped field<img src="https://school.test/a.png"></p>' };
  const whole = { id: 'whole', title: '整篇文档', kind: 'whole', assetFilenames: ['a.png'],
    fragment: '<header>合成封面</header><p>mapped whole<img src="https://school.test/a.png"></p><p>合成参考文献</p>' };
  view.setMappedSection(field); view.select('whole');
  assert.equal(view.snapshot().mapped, false); assert.equal(view.snapshot().needsMapping, true);
  view.setMappedSection(whole);
  assert.equal(view.snapshot().fragment, whole.fragment); assert.equal(view.snapshot().copyable, true);
  assert.equal(view.snapshot().preview, result.preview);
  view.select('content');
  assert.equal(view.snapshot().fragment, field.fragment); assert.equal(view.snapshot().copyable, true);
  assert.equal(view.snapshot().preview, result.sections[1].preview);
  view.select('purpose'); assert.equal(view.snapshot().fragment, result.sections[0].fragment);
  view.select('whole');
  const stamp = view.token(); view.resetMapped();
  assert.equal(view.matches(stamp), false); assert.equal(view.snapshot().id, 'whole');
  assert.equal(view.snapshot().fragment, result.fragment); assert.equal(view.snapshot().needsMapping, true);
  view.select('content');
  assert.equal(view.snapshot().mapped, false); assert.equal(view.snapshot().fragment, result.sections[1].fragment);
});

test('whole selection tokens reject stale copies after field switching or a new conversion', () => {
  const view = createSectionView(); const result = fixture(); view.setResult(result); view.select('whole');
  const stamp = view.token();
  view.select('content'); view.select('whole');
  assert.equal(view.matches(stamp), false);
  const newStamp = view.token();
  view.setMappedSection({ id: 'whole', title: '整篇文档', kind: 'whole', assetFilenames: ['a.png'], fragment: '<p>mapped whole</p>' });
  assert.equal(view.matches(newStamp), true); assert.equal(view.snapshot().copyable, true);
  view.setResult(fixture()); view.select('whole');
  assert.equal(view.matches(newStamp), false); assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().needsMapping, true);
});

test('empty whole documents cannot copy even when a mapped cache contains text', () => {
  const view = createSectionView(); const result = fixture();
  result.assets = []; result.fragment = '<div> \n&nbsp;&#160;</div>';
  view.setResult(result); view.select('whole');
  assert.equal(view.snapshot().empty, true); assert.equal(view.snapshot().eligible, false);
  assert.equal(view.snapshot().copyable, false);
  view.setMappedSection({ id: 'whole', title: '整篇文档', kind: 'whole', assetFilenames: [], fragment: '<p>unexpected mapped text</p>' });
  assert.equal(view.snapshot().copyable, false);
});

test('legacy mapped exports replace earlier scoped caches while empty sources remain non-copyable', () => {
  const view = createSectionView(); const result = fixture(); result.sections[0].fragment = '<p>&nbsp;</p>';
  view.setResult(result);
  view.setMappedSection({ ...result.sections[1], fragment: '<p>older scoped content</p>' });
  const mapped = { fragment: '<p>mapped whole</p>', preview: 'remote whole preview', sections: result.sections.map(section => ({ ...section,
    fragment: '<p>new mapped source</p>', preview: 'remote field preview' })) };
  const stamp = view.token(); view.setMapped(mapped);
  assert.equal(view.matches(stamp), true);
  assert.equal(view.snapshot().empty, true);
  assert.equal(view.snapshot().copyable, false);
  view.select('content');
  assert.equal(view.snapshot().fragment, mapped.sections[1].fragment);
  assert.equal(view.snapshot().preview, result.sections[1].preview);
  view.select('unassigned-1');
  assert.equal(view.snapshot().mapped, true);
  assert.equal(view.snapshot().copyable, true);
  assert.equal(view.snapshot().preview, result.sections[2].preview);
});

test('unassigned text copies its exact original heading and formatted body without mapping unrelated images', () => {
  const view = createSectionView(); const result = fixture();
  const original = result.sections[2];
  original.fragment = '<h2 style="font-weight:bold">参考文献</h2><p style="font-size:14px">[1] 合成作者。<em>合成题名</em>，2026。</p>\n';
  original.sourceHeading = '参考文献';
  view.setResult(result); view.select(original.id);
  const selected = view.snapshot();
  assert.equal(selected.kind, 'unassigned'); assert.equal(selected.title, '参考文献');
  assert.equal(selected.sourceHeading, original.sourceHeading);
  assert.equal(selected.fragment, original.fragment); assert.equal(selected.preview, original.preview);
  assert.equal(selected.copyable, true); assert.equal(selected.eligible, true);
  assert.equal(selected.needsMapping, false); assert.equal(selected.mapped, false);
  assert.equal(result.assets.length, 1, 'other parts of this document still contain an unmapped image');
  view.select('content'); assert.equal(view.snapshot().copyable, false);
  view.select(original.id); assert.equal(view.snapshot().copyable, true);
});

test('image-bearing unassigned content maps independently and resets alongside the field and whole caches', () => {
  const view = createSectionView(); const result = fixture();
  result.assets.push({ filename: 'b.png', kind: 'image' });
  const original = result.sections[2];
  original.fragment = '<h2>附加材料</h2><p><img src="data:image/png;base64,Yg=="></p>';
  original.assetFilenames = ['b.png']; original.imageCount = 1;
  view.setResult(result); view.select(original.id);
  assert.equal(view.snapshot().eligible, true); assert.equal(view.snapshot().needsMapping, true);
  assert.equal(view.snapshot().copyable, false);
  const mapped = { ...original, fragment: '<h2>附加材料</h2><p><img src="https://school.test/b.png"></p>', preview: 'remote-unassigned-preview' };
  const stamp = view.token(); view.setMappedSection(mapped);
  assert.equal(view.matches(stamp), true);
  assert.equal(view.snapshot().copyable, true); assert.equal(view.snapshot().fragment, mapped.fragment);
  assert.equal(view.snapshot().preview, original.preview);
  const field = { ...result.sections[1], fragment: '<p>mapped field<img src="https://school.test/a.png"></p>' };
  view.setMappedSection(field); view.select('content');
  assert.equal(view.snapshot().fragment, field.fragment);
  view.select('whole'); assert.equal(view.snapshot().mapped, false); assert.equal(view.snapshot().needsMapping, true);
  view.setMappedSection({ id: 'whole', title: '整篇文档', kind: 'whole', assetFilenames: ['a.png', 'b.png'], fragment: '<p>mapped whole</p>' });
  view.select(original.id); assert.equal(view.snapshot().fragment, mapped.fragment);
  view.resetMapped();
  assert.equal(view.matches(stamp), false); assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().fragment, original.fragment); assert.equal(view.snapshot().needsMapping, true);
  view.select('content'); assert.equal(view.snapshot().mapped, false);
  view.select('whole'); assert.equal(view.snapshot().mapped, false);
});

test('empty unassigned sources and unsupported kinds cannot copy', () => {
  const view = createSectionView(); const result = fixture();
  const original = result.sections[2]; original.fragment = '<div> \n&nbsp;&#160;</div>';
  result.sections.push({ ...original, id: 'unknown-kind', kind: 'unexpected', fragment: '<p>unsupported content</p>' });
  view.setResult(result); view.select(original.id);
  assert.equal(view.snapshot().empty, true); assert.equal(view.snapshot().eligible, false);
  assert.equal(view.snapshot().copyable, false);
  view.setMappedSection({ ...original, fragment: '<p>unexpected mapped text</p>' });
  assert.equal(view.snapshot().copyable, false);
  view.select('unknown-kind'); assert.equal(view.snapshot().eligible, false); assert.equal(view.snapshot().copyable, false);
});

test('unassigned copy tokens and caches expire after scope changes or a new conversion', () => {
  const view = createSectionView(); const result = fixture(); view.setResult(result); view.select('unassigned-1');
  const stamp = view.token(); assert.equal(view.snapshot().copyable, true);
  view.select('content'); view.select('unassigned-1'); assert.equal(view.matches(stamp), false);
  const next = view.token(); view.setMappedSection({ ...result.sections[2], fragment: '<h2>参考文献</h2><p>mapped references</p>' });
  assert.equal(view.matches(next), true); assert.equal(view.snapshot().mapped, true);
  const replacement = fixture(); view.setResult(replacement); view.select('unassigned-1');
  assert.equal(view.matches(next), false); assert.equal(view.snapshot().mapped, false);
  assert.equal(view.snapshot().fragment, replacement.sections[2].fragment); assert.equal(view.snapshot().copyable, true);
});
