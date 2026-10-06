import test from 'node:test';
import assert from 'node:assert/strict';
import { importImageUrls } from '../src/image-import.mjs';

const files = (...filenames) => filenames.map(filename => ({ filename }));

test('matches decoded URL basename, while filename attributes are only confirmation hints', () => {
  const result = importImageUrls([
    '<img src="https://school.test/upload/image%2Da.png?download=1&amp;v=2">',
    '<img src="https://school.test/upload/renamed.png" alt="image-b.png">',
    '<img src="https://school.test/upload/third.png" title="图%20三.png">',
    '<img src="https://school.test/upload/fourth.png" data-filename="image-d.png">',
  ].join(''), files('image-a.png', 'image-b.png', '图 三.png', 'image-d.png'));
  assert.equal(result.detectedCount, 4);
  assert.deepEqual(result.matches, [
    { filename: 'image-a.png', url: 'https://school.test/upload/image%2Da.png?download=1&v=2', method: 'filename' },
  ]);
  assert.deepEqual(result.unmatchedAssets, ['image-b.png', '图 三.png', 'image-d.png']);
  assert.equal(result.unusedImages.length, 3);
  assert.equal(result.orderReady, true);
  assert.equal(result.orderCandidates.length, 3);
  assert.match(result.warnings.join(' '), /文字文件名提示/);
});

test('matches only an explicitly supplied upload filename alias', () => {
  const assets = [
    { filename: 'image-a.png', uploadFilename: '01-image-a.png' },
    { filename: 'image-b.png', uploadFilename: '02-image-b.png' },
  ];
  const result = importImageUrls('<img src="https://school.test/02-image-b.png"><img src="https://school.test/01%2Dimage-a.png">', assets);
  assert.deepEqual(result.matches, [
    { filename: 'image-a.png', url: 'https://school.test/01%2Dimage-a.png', method: 'uploadFilename' },
    { filename: 'image-b.png', url: 'https://school.test/02-image-b.png', method: 'uploadFilename' },
  ]);
  assert.equal(result.orderReady, false);
  const withoutAlias = importImageUrls('<img src="https://school.test/01-image-a.png">', files('image-a.png'));
  assert.deepEqual(withoutAlias.matches, []);
  assert.equal(withoutAlias.orderReady, true);
});

test('a colliding explicit alias cannot identify either asset', () => {
  const result = importImageUrls('<img src="https://school.test/01-image.png">', [
    { filename: 'image-a.png', uploadFilename: '01-image.png' },
    { filename: 'image-b.png', uploadFilename: '01-image.png' },
  ]);
  assert.deepEqual(result.matches, []);
  assert.equal(result.orderReady, false);
  assert.match(result.warnings.join(' '), /别名冲突/);
});

test('does not infer filename identity from substrings, query strings or dimensions', () => {
  const result = importImageUrls('<img src="https://school.test/image-a.png-copy?name=image-a.png" alt="figure image-a.png" width="100" height="20">', files('image-a.png'));
  assert.deepEqual(result.matches, []);
  assert.equal(result.orderReady, true);
  assert.deepEqual(result.orderCandidates, [{ filename: 'image-a.png', url: 'https://school.test/image-a.png-copy?name=image-a.png', index: 1 }]);
});

test('ignores images in scripts, templates, comments, raw text and fallback containers', () => {
  const result = importImageUrls(`
    <script>const fake = '<img src="https://school.test/a.png">';</script>
    <template><img src="https://school.test/a.png"><template><img src="https://school.test/b.png"></template></template>
    <style>.fake { content: '<img src="https://school.test/a.png">'; }</style>
    <noscript><img src="https://school.test/a.png"></noscript>
    <iframe><img src="https://school.test/a.png"></iframe>
    <object><img src="https://school.test/a.png"></object>
    <textarea>&lt;img src="https://school.test/a.png"&gt;</textarea>
    <!-- <img src="https://school.test/a.png"> -->
    <img src="https://school.test/a.png" onerror="throw new Error('never executed')">
  `, files('a.png'));
  assert.equal(result.detectedCount, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].filename, 'a.png');
});

test('rejects unsafe schemes, credentials, controls and missing URLs without losing positions', () => {
  const sources = [
    'data:image/png;base64,AAAA', 'blob:https://school.test/123', 'javascript:alert(1)',
    'file:///C:/a.png', 'ftp://school.test/a.png', 'https://user:pass@school.test/a.png',
    'https://school.test/a&#10;.png', 'https:\\school.test\\a.png', '',
  ];
  const result = importImageUrls(sources.map(src => `<img src="${src}">`).join('') + '<img src="https://school.test/renamed.png">', files('a.png'));
  assert.equal(result.detectedCount, sources.length + 1);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.unusedImages, [{ index: 10, url: 'https://school.test/renamed.png' }]);
  assert.equal(result.orderReady, false);
  assert.deepEqual(result.orderCandidates, []);
});

test('resolves relative paths only with an explicitly supplied safe school page URL', () => {
  const html = '<img src="/uploads/a.png"><img src="../uploads/b.png"><img src="//cdn.school.test/c.png">';
  const withoutBase = importImageUrls(html, files('a.png', 'b.png', 'c.png'));
  assert.equal(withoutBase.matches.length, 0);
  assert.equal(withoutBase.orderReady, false);
  const result = importImageUrls(html, files('a.png', 'b.png', 'c.png'), { pageUrl: 'http://school.test/editor/page' });
  assert.deepEqual(result.matches.map(match => match.url), [
    'http://school.test/uploads/a.png', 'http://school.test/uploads/b.png', 'http://cdn.school.test/c.png',
  ]);
  assert.throws(() => importImageUrls(html, files('a.png'), { pageUrl: 'https://user:pass@school.test/page' }), /学校页面地址/);
  assert.throws(() => importImageUrls(html, files('a.png'), { pageUrl: '/editor/page' }), /学校页面地址/);
});

test('exact matching follows identifiers even when image order is reversed', () => {
  const result = importImageUrls('<img src="https://school.test/b.png"><img src="https://school.test/a.png">', files('a.png', 'b.png'));
  assert.deepEqual(result.matches.map(match => [match.filename, match.url]), [
    ['a.png', 'https://school.test/a.png'], ['b.png', 'https://school.test/b.png'],
  ]);
  assert.equal(result.orderReady, false);
});

test('offers order candidates only after removing exact matches and preserves source order', () => {
  const result = importImageUrls('<img src="https://school.test/new-first.png"><img src="https://school.test/b.png"><img src="https://school.test/new-last.png">', files('a.png', 'b.png', 'c.png'));
  assert.deepEqual(result.matches, [{ filename: 'b.png', url: 'https://school.test/b.png', method: 'filename' }]);
  assert.deepEqual(result.unmatchedAssets, ['a.png', 'c.png']);
  assert.equal(result.orderReady, true);
  assert.deepEqual(result.orderCandidates, [
    { filename: 'a.png', index: 1, url: 'https://school.test/new-first.png' },
    { filename: 'c.png', index: 3, url: 'https://school.test/new-last.png' },
  ]);
  // A candidate is deliberately absent from automatic matches.
  assert.equal(result.matches.length, 1);
});

test('extra or missing images prevent order candidates', () => {
  const extra = importImageUrls('<img src="https://school.test/new.png"><img src="https://school.test/logo.png">', files('a.png'));
  assert.equal(extra.orderReady, false);
  assert.deepEqual(extra.orderCandidates, []);
  const missing = importImageUrls('<img src="https://school.test/new.png">', files('a.png', 'b.png'));
  assert.equal(missing.orderReady, false);
  assert.deepEqual(missing.orderCandidates, []);
});

test('conflicting identifiers leave all related assets unresolved', () => {
  const result = importImageUrls('<img src="https://school.test/a.png" alt="b.png"><img src="https://school.test/new.png">', files('a.png', 'b.png'));
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.unmatchedAssets, ['a.png', 'b.png']);
  assert.equal(result.orderReady, false);
  assert.match(result.warnings.join(' '), /冲突/);
});

test('same filename claimed by different URLs is ambiguous even when counts fit', () => {
  const result = importImageUrls('<img src="https://school.test/one.png" alt="a.png"><img src="https://school.test/two.png" title="a.png">', files('a.png', 'b.png'));
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.unmatchedAssets, ['a.png', 'b.png']);
  assert.equal(result.orderReady, false);
  assert.match(result.warnings.join(' '), /同一文件名/);
});

test('repeated src at different positions is preserved and cannot shift remaining matches', () => {
  const result = importImageUrls('<img src="https://school.test/a.png"><img src="https://school.test/a.png">', files('a.png', 'b.png'));
  assert.deepEqual(result.matches, []);
  assert.equal(result.unusedImages.length, 2);
  assert.deepEqual(result.unusedImages.map(image => image.index), [1, 2]);
  assert.equal(result.orderReady, false);
  assert.deepEqual(result.orderCandidates, []);
});

test('one URL carrying two distinct filenames is not treated as two separate uploads', () => {
  const result = importImageUrls('<img src="https://school.test/new.png" alt="a.png"><img src="https://school.test/new.png" alt="b.png">', files('a.png', 'b.png'));
  assert.deepEqual(result.matches, []);
  assert.equal(result.orderReady, false);
});

test('duplicate asset filenames never produce automatic matches', () => {
  const result = importImageUrls('<img src="https://school.test/a.png">', files('a.png', 'a.png'));
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.unmatchedAssets, ['a.png']);
  assert.equal(result.orderReady, false);
});

test('validates HTML byte limit and inputs with concise Chinese errors', () => {
  assert.throws(() => importImageUrls('', files('a.png')), /请粘贴/);
  assert.throws(() => importImageUrls(null, files('a.png')), /请粘贴/);
  assert.throws(() => importImageUrls('字'.repeat(700000), files('a.png')), /不能超过 2 MB/);
  assert.throws(() => importImageUrls('<p>x</p>', [{}]), /图片文件列表无效/);
  const result = importImageUrls('<p>没有图片</p>', files('a.png'));
  assert.equal(result.detectedCount, 0);
  assert.equal(result.orderReady, false);
  assert.deepEqual(result.unmatchedAssets, ['a.png']);
  assert.match(result.warnings.join(' '), /没有找到图片/);
});

test('editable choices include both filename matches and renamed images in source order', () => {
  const result = importImageUrls('<img src="https://school.test/renamed.png"><img src="https://school.test/a.png">', files('a.png', 'b.png'));
  assert.equal(result.canAdjustOrder, true);
  assert.deepEqual(result.imageChoices, [
    { index: 1, url: 'https://school.test/renamed.png' },
    { index: 2, url: 'https://school.test/a.png' },
  ]);
  assert.equal(result.matches[0].filename, 'a.png');
  assert.deepEqual(result.orderCandidates, [{ filename: 'b.png', index: 1, url: 'https://school.test/renamed.png' }]);
  const allNamed = importImageUrls('<img src="https://school.test/b.png"><img src="https://school.test/a.png">', files('a.png', 'b.png'));
  assert.equal(allNamed.orderReady, false);
  assert.equal(allNamed.canAdjustOrder, true);
  assert.equal(allNamed.imageChoices.length, 2);
});

test('ambiguous, unsafe or incomplete school image sets cannot enable the correspondence editor', () => {
  for (const html of [
    '<img src="https://school.test/a.png"><img src="https://school.test/a.png">',
    '<img src="javascript:alert(1)"><img src="https://school.test/b.png">',
    '<img src="https://school.test/a.png">',
    '<img src="https://school.test/a.png"><img src="https://school.test/b.png"><img src="https://school.test/c.png">',
    '<img src="https://school.test/a.png" alt="b.png"><img src="https://school.test/renamed.png">',
  ]) {
    const result = importImageUrls(html, files('a.png', 'b.png'));
    assert.equal(result.canAdjustOrder, false);
    assert.deepEqual(result.imageChoices, []);
  }
});
