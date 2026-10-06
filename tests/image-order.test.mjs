import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageOrder, validateImageUrls } from '../public/image-order.js';

const assets = Array.from({ length: 9 }, (_, index) => ({ filename: `image-${index + 1}.png` }));
const images = assets.map((_, index) => ({ index: index + 1, url: `https://school.test/upload/${index + 1}.png` }));
const create = existingUrls => createImageOrder({ assets, images, existingUrls });

test('complete manually entered HTTP(S) addresses pass without changing the URL array', () => {
  const urls = images.map(image => image.url);
  urls[1] = 'http://school.test/earlier/second.png';
  const initial = [...urls];
  assert.equal(validateImageUrls(urls).valid, true);
  assert.deepEqual(urls, initial);
});

test('manual URL validation rejects missing addresses or invalid URL lists', () => {
  assert.equal(validateImageUrls([]).valid, false);
  assert.equal(validateImageUrls(null).valid, false);
  for (const missing of ['', '  ', undefined, null]) {
    const checked = validateImageUrls([images[0].url, missing]);
    assert.equal(checked.valid, false);
    assert.ok(checked.message);
  }
  assert.equal(validateImageUrls(Array(1)).valid, false);
});

test('manual URL validation rejects duplicate URLs including canonical equivalents', () => {
  for (const duplicate of [images[0].url, 'https://SCHOOL.test:443/upload/1.png']) {
    assert.deepEqual(validateImageUrls([images[0].url, duplicate]), {
      valid: false, message: '多张原图使用了同一图片地址，请调整对应关系。'
    });
  }
});

test('manual URL validation blocks credentials, controls, backslashes and non-HTTP addresses', () => {
  for (const unsafe of ['https://user:password@school.test/a.png', 'https://school.test\\a.png',
    '\nhttps://school.test/a.png', 'https://school.test/a\t.png', 'javascript:alert(1)', '/relative.png']) {
    assert.equal(validateImageUrls([images[0].url, unsafe]).valid, false, unsafe);
  }
});

test('first and last school images can be swapped and swapped back', () => {
  const model = create();
  assert.equal(model.validate().valid, true);
  assert.deepEqual(model.select(assets[0].filename, '9'), { swappedFilename: assets[8].filename });
  assert.equal(model.rows()[0].url, images[8].url);
  assert.equal(model.rows()[8].url, images[0].url);
  assert.deepEqual(model.validate().mappings.map(mapping => mapping.filename), assets.map(asset => asset.filename));
  model.select(assets[0].filename, '1');
  assert.deepEqual(model.rows().map(row => row.url), images.map(image => image.url));
});

test('consecutive choices create a three-image permutation without duplicate URLs', () => {
  const model = create();
  model.select(assets[0].filename, '2');
  model.select(assets[1].filename, '3');
  assert.deepEqual(model.rows().slice(0, 3).map(row => row.selection), ['2', '3', '1']);
  assert.equal(model.validate().valid, true);
});

test('source indices need not be contiguous or start at one', () => {
  const model = createImageOrder({ assets: assets.slice(0, 3), images: [
    { index: 2, url: images[0].url }, { index: 5, url: images[1].url }, { index: 10, url: images[2].url }
  ] });
  assert.deepEqual(model.rows().map(row => row.selection), ['2', '5', '10']);
  model.select(assets[0].filename, '10');
  assert.deepEqual(model.rows().map(row => row.selection), ['10', '5', '2']);
});

test('existing URLs take precedence and empty rows use remaining source choices', () => {
  const existingUrls = { [assets[0].filename]: images[8].url, [assets[8].filename]: images[0].url };
  const model = create(existingUrls);
  assert.deepEqual(model.rows().map(row => row.selection), ['9', '2', '3', '4', '5', '6', '7', '8', '1']);
  assert.equal(model.validate().changedCount, 7);
  assert.equal(model.rows()[0].existingUrl, images[8].url);
});

test('manual URLs absent from source remain explicit retained choices', () => {
  const manual = 'https://school.test/earlier/manual.png';
  const model = create({ [assets[0].filename]: manual });
  assert.deepEqual(model.rows()[0], {
    filename: assets[0].filename, selection: 'keep', url: manual, existingUrl: manual, keepUrl: manual
  });
  assert.equal(model.validate().valid, true);
  assert.equal(model.validate().mappings[0].url, manual);
  assert.equal(model.validate().changedCount, 8);
});

test('retaining the first manual URL preserves the default correspondence of subsequent images', () => {
  const model = create({ [assets[0].filename]: 'https://school.test/earlier/manual.png' });
  assert.deepEqual(model.rows().map(row => row.selection), ['keep', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.deepEqual(model.validate().mappings.slice(1).map(mapping => mapping.url), images.slice(1).map(image => image.url));
});

test('non-contiguous indices respect existing numeric assignments before reserving retained slots', () => {
  const localAssets = assets.slice(0, 4);
  const sourceImages = images.slice(0, 4).map((image, index) => ({ ...image, index: [2, 5, 10, 20][index] }));
  const model = createImageOrder({
    assets: localAssets, images: sourceImages,
    existingUrls: { [localAssets[0].filename]: 'https://school.test/manual.png', [localAssets[2].filename]: sourceImages[0].url }
  });
  assert.deepEqual(model.rows().map(row => row.selection), ['keep', '10', '2', '20']);
  assert.equal(model.validate().valid, true);
});

test('retained rows reserve their available original slots before other retained rows use fallback slots', () => {
  const model = createImageOrder({
    assets: assets.slice(0, 4), images: images.slice(0, 4),
    existingUrls: {
      [assets[0].filename]: 'https://school.test/manual-a.png',
      [assets[1].filename]: 'https://school.test/manual-b.png',
      [assets[2].filename]: images[0].url
    }
  });
  assert.deepEqual(model.rows().map(row => row.selection), ['keep', 'keep', '1', '4']);
  assert.equal(model.validate().valid, true);
});

test('choosing an occupied source image from a retained row clears the displaced row', () => {
  const manual = 'https://school.test/earlier/manual.png';
  const model = create({ [assets[0].filename]: manual });
  assert.deepEqual(model.select(assets[0].filename, '2'), { clearedFilename: assets[1].filename });
  assert.equal(model.rows()[1].selection, '');
  assert.equal(model.rows()[1].url, '');
  assert.equal(model.validate().valid, false);
  assert.deepEqual(model.validate().mappings, []);
  model.select(assets[1].filename, '1');
  assert.equal(model.validate().valid, true);
  model.select(assets[0].filename, 'keep');
  assert.equal(model.rows()[0].url, manual);
  assert.equal(model.validate().valid, true);
});

test('empty choices block confirmation and cannot transfer another row manual URL', () => {
  const model = create();
  model.select(assets[0].filename, '');
  assert.equal(model.validate().valid, false);
  assert.deepEqual(model.select(assets[0].filename, '2'), { clearedFilename: assets[1].filename });
  assert.equal(model.rows()[1].selection, '');
  model.select(assets[1].filename, '1');
  assert.equal(model.validate().valid, true);
});

test('duplicate existing source URLs are preserved and block confirmation until corrected', () => {
  const model = create({ [assets[0].filename]: images[0].url, [assets[1].filename]: images[0].url });
  assert.deepEqual(model.rows().slice(0, 2).map(row => row.selection), ['1', '1']);
  assert.equal(model.validate().valid, false);
  assert.match(model.validate().message, /同一图片地址/);
  assert.deepEqual(model.validate().mappings, []);
  model.select(assets[1].filename, '9');
  assert.equal(model.validate().valid, true);
});

test('duplicate retained manual URLs are not silently replaced', () => {
  const manual = 'https://school.test/manual.png';
  const model = create({ [assets[0].filename]: manual, [assets[1].filename]: manual });
  assert.deepEqual(model.rows().slice(0, 2).map(row => row.selection), ['keep', 'keep']);
  assert.equal(model.validate().valid, false);
  model.select(assets[1].filename, '2');
  assert.equal(model.validate().valid, true);
});

test('equivalent URL spellings match existing source choices and are detected as duplicates', () => {
  const model = create({ [assets[0].filename]: 'https://SCHOOL.test:443/upload/1.png' });
  assert.equal(model.rows()[0].selection, '1');
  assert.equal(model.rows()[0].keepUrl, '');
  assert.throws(() => createImageOrder({ assets: assets.slice(0, 2), images: [
    { index: 1, url: images[0].url }, { index: 2, url: 'https://SCHOOL.test:443/upload/1.png' }
  ] }), /学校图片列表无效/);
});

test('unsafe existing manual addresses remain visible but cannot be confirmed', () => {
  const unsafe = [
    'javascript:alert(1)', 'data:image/png;base64,AA==', '/relative.png',
    'https://user:password@school.test/a.png', 'https://school.test\\a.png',
    'https://school.test/a\n.png', '\nhttps://school.test/a.png', 'https://school.test/a\u007f.png',
    'http:school.test/a.png'
  ];
  for (const url of unsafe) {
    const model = create({ [assets[0].filename]: url });
    assert.equal(model.rows()[0].url, url);
    assert.equal(model.validate().valid, false, url);
    assert.deepEqual(model.validate().mappings, []);
  }
});

test('unsafe source addresses fail construction', () => {
  for (const url of ['https://user@school.test/a.png', 'https://school.test\\a.png', 'https://school.test/a\n.png', 'file:///a.png']) {
    assert.throws(() => createImageOrder({ assets: assets.slice(0, 1), images: [{ index: 1, url }] }), /学校图片列表无效/);
  }
});

test('rows and validate mappings are independent snapshots', () => {
  const model = create();
  const snapshot = model.rows();
  snapshot[0].selection = '9'; snapshot[0].url = 'https://other.test/x.png'; snapshot.pop();
  const mappings = model.validate().mappings;
  mappings[0].url = 'https://other.test/y.png';
  assert.equal(model.rows().length, 9);
  assert.equal(model.rows()[0].selection, '1');
  assert.equal(model.validate().mappings[0].url, images[0].url);
});

test('invalid fields, asset duplicates and source index duplicates are rejected', () => {
  assert.throws(() => createImageOrder(), /原图列表无效/);
  assert.throws(() => createImageOrder(null), /对应关系数据无效/);
  assert.throws(() => createImageOrder({ assets: Array(1), images: [images[0]] }), /原图列表无效/);
  assert.throws(() => createImageOrder({ assets: [assets[0], assets[0]], images: images.slice(0, 2) }), /原图列表无效/);
  assert.throws(() => createImageOrder({ assets, images: [] }), /数量/);
  assert.throws(() => createImageOrder({ assets: assets.slice(0, 2), images: [images[0], { index: 1, url: images[1].url }] }), /学校图片列表无效/);
  assert.throws(() => createImageOrder({ assets: assets.slice(0, 1), images: [{ index: 0, url: images[0].url }] }), /学校图片列表无效/);
  assert.throws(() => create({ unknown: images[0].url }), /已填图片地址无效/);
  assert.throws(() => create({ [assets[0].filename]: 10 }), /已填图片地址无效/);
  assert.throws(() => create(new Map()), /已填图片地址无效/);
});

test('invalid choices do not mutate the existing correspondence', () => {
  const model = create();
  for (const selection of ['keep', '99', '01', 'not-a-choice', 1, null]) {
    assert.throws(() => model.select(assets[0].filename, selection), /图片选择无效/);
  }
  assert.throws(() => model.select('unknown.png', '1'), /未找到该原图/);
  assert.equal(model.rows()[0].selection, '1');
  assert.equal(model.validate().valid, true);
});

test('fully filled existing correspondence can still be edited with accurate changed count', () => {
  const existingUrls = Object.fromEntries(assets.map((asset, index) => [asset.filename, images[index].url]));
  const model = create(existingUrls);
  assert.equal(model.validate().changedCount, 0);
  model.select(assets[0].filename, '9');
  assert.equal(model.validate().changedCount, 2);
  assert.equal(model.validate().valid, true);
});
