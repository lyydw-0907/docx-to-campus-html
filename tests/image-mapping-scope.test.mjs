import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSectionView } from '../public/section-view.js';

// Run the production module with its browser import resolved to the same source
// file. The small DOM below supplies controls, without fetching any school URLs.
const source = (await readFile(new URL('../public/image-mapping.js', import.meta.url), 'utf8'))
  .replace("'/image-order.js'", JSON.stringify(new URL('../public/image-order.js', import.meta.url).href));
const { createImageMapping } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.listeners = new Map(); this.dataset = {};
    this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    this.attributes = new Map();
    this.classList = { toggle() {} };
  }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  append(...nodes) {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = undefined;
    this.children = []; this.append(...nodes);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = undefined;
  }
  insertBefore(node, before) {
    node.remove(); node.parentElement = this;
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }
  querySelector(selector) { return selector === 'option[value="keep"]' ? this.options.find(option => option.value === 'keep') : undefined; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'href') delete this.href; }
  addEventListener(event, callback) {
    const callbacks = this.listeners.get(event) ?? []; callbacks.push(callback); this.listeners.set(event, callbacks);
  }
  async fire(event, target = this) { for (const callback of this.listeners.get(event) ?? []) await callback({ target }); }
}

const url = number => `https://school.test/uploads/${number}.png`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, { shared = false } = {}) {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  const controls = new Map();
  const byId = id => { if (!controls.has(id)) controls.set(id, new Element()); return controls.get(id); };
  const assets = [1, 2, 3].map(number => ({ filename: `image-${number}.png`, uploadFilename: `图${number}-image-${number}.png` }));
  const section = (id, filenames) => ({ id, title: id, kind: 'field', assetFilenames: filenames,
    fragment: `<p>${id}</p>${filenames.map(filename => `<img src="${filename}">`).join('')}`, preview: '<p>local only</p>', formulaCount: 0, imageCount: filenames.length });
  let current = { jobId: 'synthetic-job', assets, manifest: { options: { formulaFormat: 'mathml' }, formulas: [] },
    fragment: '<p>whole document</p>', preview: '<p>local only</p>', sections: [
      section('first', [assets[0].filename, assets[2].filename]), section('second', [assets[shared ? 0 : 1].filename]), section('text', [])
    ] };
  const view = createSectionView(); view.setResult(current);
  const assetInputs = new Map();
  for (const asset of assets) {
    const row = new Element(); const input = new Element('input'); row.append(input); byId('asset-list').append(row);
    assetInputs.set(asset.filename, input);
  }
  const requests = []; const downloads = []; const statuses = []; const copied = [];
  let respond = async (route, init) => {
    if (route === 'upload-images') return new Response('zip');
    if (route === 'export') {
      const payload = JSON.parse(init.body);
      const original = current.sections.find(section => section.id === payload.sectionId);
      return new Response(JSON.stringify({ section: { ...original, fragment: '<p>mapped</p>' } }));
    }
    throw new Error('Unexpected request');
  };
  const mapping = createImageMapping({ getCurrent: () => current, assetInputs, byId,
    json: async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; },
    download: (...args) => downloads.push(args), status: (...args) => statuses.push(args),
    showMappedSource: exported => view.setMappedSection(exported.section), resetMappedSource: () => view.resetMapped(),
    requestJob: async (...args) => { requests.push(args); return respond(...args); },
    getCopyContext: () => view.token(), isCopyContextCurrent: token => view.matches(token),
    getCopyState: () => view.snapshot(), copySelectedSource: async () => copied.push(view.snapshot().id)
  });
  mapping.reset();
  const choose = id => { view.select(id); mapping.refresh(); };
  const replaceCurrent = result => { current = result; view.setResult(result); mapping.reset(); };
  const setUrl = async (number, address) => {
    const input = assetInputs.get(assets[number - 1].filename); input.value = address; await byId('asset-list').fire('input', input);
  };
  const importReport = async report => {
    byId('school-image-source').value = '<p>synthetic school images</p>';
    await byId('school-image-source').fire('input');
    respond = async route => { assert.equal(route, 'import-images'); return new Response(JSON.stringify(report)); };
    await byId('import-image-urls').fire('click');
  };
  return { mapping, current, view, byId, assetInputs, requests, downloads, statuses, copied, choose, replaceCurrent, setUrl,
    importReport, respond: handler => { respond = handler; } };
}
const orderReport = images => ({ detectedCount: images.length, matches: [], warnings: [],
  canAdjustOrder: true, orderReady: true, imageChoices: images.map((number, index) => ({ index: index + 1, url: url(number) })) });

test('conversion reset with no current result clears image UI without accessing absent async operations', t => {
  const f = fixture(t);
  f.replaceCurrent(undefined);
  assert.equal(f.byId('copy-mapped').disabled, true);
  assert.equal(f.byId('download-upload-images').disabled, true);
  assert.equal(f.byId('import-image-urls').disabled, true);
  assert.equal(f.byId('download-mapped').disabled, true);
  assert.equal(f.byId('image-order-confirmation').hidden, true);
  f.replaceCurrent(f.current);
  assert.equal(f.byId('import-image-urls').disabled, false);
  assert.equal(f.byId('download-upload-images').disabled, false);
  assert.equal(f.view.snapshot().id, 'first');
});

test('a field copies with only its addresses; missing other images block only whole copy/archive', async t => {
  const f = fixture(t);
  assert.equal(f.byId('copy-mapped').disabled, true);
  await f.setUrl(1, url(1)); await f.setUrl(3, url(3));
  assert.equal(f.byId('copy-mapped').disabled, false);
  assert.equal(f.byId('download-mapped').disabled, true);
  assert.match(f.byId('mapping-count').textContent, /本栏目已填写 2 \/ 2.*整篇 2 \/ 3/);
  assert.equal(f.assetInputs.get('image-2.png').parentElement.hidden, true);
  await f.byId('copy-mapped').fire('click');
  assert.deepEqual(f.copied, ['first']);
  assert.equal(JSON.parse(f.requests[0][1].body).sectionId, 'first');
  f.choose('second'); assert.equal(f.byId('copy-mapped').disabled, true);
  f.choose('text'); assert.equal(f.byId('copy-mapped').disabled, false);
  await f.byId('copy-mapped').fire('click'); assert.deepEqual(f.copied, ['first', 'text']);
  f.choose('whole'); assert.equal(f.byId('copy-mapped').disabled, true);
  assert.equal(f.byId('download-mapped').disabled, true);
  assert.equal(f.assetInputs.get('image-1.png').value, url(1));
  assert.equal(f.assetInputs.get('image-3.png').value, url(3));
});

test('upload download carries selected scope and text-only scopes offer no image operations', async t => {
  const f = fixture(t);
  await f.byId('download-upload-images').fire('click');
  assert.deepEqual(f.requests[0], ['upload-images', undefined, { sectionId: 'first' }]);
  assert.match(f.downloads[0][1], /first-上传用图片.zip/);
  f.choose('text');
  assert.equal(f.byId('download-upload-images').disabled, true);
  assert.equal(f.byId('import-image-urls').disabled, true);
  await f.byId('download-upload-images').fire('click');
  assert.equal(f.requests.length, 1);
});

test('scoped order can be swapped and confirmed using original document picture numbers', async t => {
  const f = fixture(t);
  await f.importReport(orderReport([3, 1]));
  assert.equal(JSON.parse(f.requests[0][1].body).sectionId, 'first');
  assert.equal(f.byId('image-order-list').children.length, 2);
  const [firstRow, thirdRow] = f.byId('image-order-list').children;
  assert.equal(firstRow.children[0].alt, '第 1 张原图');
  assert.equal(thirdRow.children[0].alt, '第 3 张原图');
  const firstSelect = firstRow.children[1].children[1].children[0];
  firstSelect.value = '2'; await firstSelect.fire('change');
  assert.match(f.byId('image-order-message').textContent, /原图 1 与原图 3/);
  assert.equal(f.byId('copy-mapped').disabled, true);
  await f.byId('confirm-image-order').fire('click');
  assert.equal(f.assetInputs.get('image-1.png').value, url(1));
  assert.equal(f.assetInputs.get('image-3.png').value, url(3));
  assert.equal(f.assetInputs.get('image-2.png').value, '');
  assert.equal(f.byId('copy-mapped').disabled, false);
  assert.equal(f.byId('download-mapped').disabled, true);
});

test('an unrelated pending draft survives scope switches and does not block a completed field', async t => {
  const f = fixture(t);
  await f.setUrl(1, url(1)); await f.setUrl(3, url(3));
  f.choose('second'); await f.importReport(orderReport([2]));
  const orderNodes = [...f.byId('image-order-list').children];
  assert.equal(f.byId('copy-mapped').disabled, true);
  f.choose('first');
  assert.equal(f.byId('image-order-confirmation').hidden, true);
  assert.equal(f.byId('copy-mapped').disabled, false);
  assert.equal(f.byId('download-mapped').disabled, true);
  f.choose('whole'); assert.match(f.byId('mapping-copy-note').textContent, /切换到“second”确认/);
  f.choose('first');
  await f.setUrl(1, url('first-new'));
  f.choose('second');
  assert.deepEqual(f.byId('image-order-list').children, orderNodes);
  assert.equal(f.byId('school-image-source').value, '<p>synthetic school images</p>');
  await f.byId('confirm-image-order').fire('click');
  assert.equal(f.assetInputs.get('image-2.png').value, url(2));
  assert.equal(f.assetInputs.get('image-1.png').value, url('first-new'));
  assert.equal(f.byId('download-mapped').disabled, false);
  f.choose('whole'); assert.equal(f.byId('copy-mapped').disabled, false);
});

test('clearing a field leaves other field mappings intact and manual duplicates are scoped', async t => {
  const f = fixture(t);
  await f.setUrl(1, url(1)); await f.setUrl(3, url(3));
  f.choose('second'); await f.setUrl(2, url(1));
  assert.equal(f.byId('copy-mapped').disabled, false);
  assert.equal(f.byId('download-mapped').disabled, true, 'duplicate across fields still blocks full archive');
  await f.byId('clear-image-urls').fire('click');
  assert.equal(f.assetInputs.get('image-2.png').value, '');
  assert.equal(f.assetInputs.get('image-1.png').value, url(1));
  assert.equal(f.assetInputs.get('image-3.png').value, url(3));
});

test('import results from a different selection are discarded even after returning to the same field', async t => {
  const f = fixture(t); const pending = deferred();
  f.byId('school-image-source').value = '<p>first field upload</p>';
  f.respond(() => pending.promise);
  const importing = f.byId('import-image-urls').fire('click');
  f.choose('second'); f.choose('first');
  pending.resolve(new Response(JSON.stringify({ detectedCount: 2, warnings: [], canAdjustOrder: false,
    matches: [{ filename: 'image-1.png', url: url(1) }, { filename: 'image-3.png', url: url(3) }] })));
  await importing;
  assert.equal(f.assetInputs.get('image-1.png').value, '');
  assert.equal(f.assetInputs.get('image-3.png').value, '');
  assert.equal(f.byId('image-order-confirmation').hidden, true);
  assert.equal(f.byId('import-image-urls').disabled, false);
});

test('stale mapped copy response cannot copy another selected field', async t => {
  const f = fixture(t); const pending = deferred();
  await f.setUrl(1, url(1)); await f.setUrl(3, url(3));
  f.respond(() => pending.promise);
  const copying = f.byId('copy-mapped').fire('click');
  f.choose('text');
  pending.resolve(new Response(JSON.stringify({ section: { ...f.current.sections[0], fragment: '<p>mapped</p>' } })));
  await copying;
  assert.deepEqual(f.copied, []);
  assert.equal(f.view.snapshot().id, 'text');
  assert.equal(f.byId('copy-mapped').disabled, false);
});

test('an upload download requested before changing scope is discarded', async t => {
  const f = fixture(t); const pending = deferred();
  f.respond(() => pending.promise);
  const downloading = f.byId('download-upload-images').fire('click');
  f.choose('second');
  pending.resolve(new Response('zip')); await downloading;
  assert.deepEqual(f.downloads, []);
  assert.equal(f.byId('download-upload-images').disabled, false);
});

test('confirming whole correspondence resolves overlapping field drafts', async t => {
  const f = fixture(t);
  await f.importReport(orderReport([1, 3]));
  f.choose('whole'); await f.importReport(orderReport([1, 2, 3]));
  await f.byId('confirm-image-order').fire('click');
  assert.equal(f.byId('download-mapped').disabled, false);
  f.choose('first');
  assert.equal(f.byId('confirm-image-order').disabled, true);
  assert.equal(f.byId('copy-mapped').disabled, false);
});

test('exact shared-image matching permits its field while preserving another field pending image and order edits', async t => {
  const f = fixture(t, { shared: true });
  await f.setUrl(1, url(1)); await f.setUrl(2, url(2)); await f.setUrl(3, url(3));
  await f.importReport(orderReport([3, 1]));
  const firstRow = f.byId('image-order-list').children[0];
  const firstSelect = firstRow.children[1].children[1].children[0];
  firstSelect.value = '1'; await firstSelect.fire('change');
  f.choose('second');
  await f.importReport({ detectedCount: 1, matches: [{ filename: 'image-1.png', url: url(1), method: 'filename' }],
    warnings: [], canAdjustOrder: true, orderReady: false, imageChoices: [{ index: 1, url: url(1) }] });
  assert.equal(f.byId('confirm-image-order').disabled, true, 'exact identity is already confirmed');
  assert.equal(f.byId('copy-mapped').disabled, false, 'other pending draft must not block this shared image');
  assert.equal(f.byId('download-mapped').disabled, true, 'the other image still requires confirmation');
  f.choose('first');
  const rows = f.byId('image-order-list').children;
  const sharedSelect = rows[0].children[1].children[1].children[0];
  const pendingSelect = rows[1].children[1].children[1].children[0];
  assert.equal(sharedSelect.value, 'keep');
  assert.equal(pendingSelect.value, '2', 'tentative non-shared selection is preserved');
  assert.equal(f.byId('copy-mapped').disabled, true);
  assert.equal(f.byId('confirm-image-order').disabled, true, 'duplicate tentative mapping must be corrected');
  pendingSelect.value = '1'; await pendingSelect.fire('change');
  assert.equal(f.byId('confirm-image-order').disabled, false);
  assert.equal(f.byId('download-mapped').disabled, true);
  await f.byId('confirm-image-order').fire('click');
  assert.equal(f.byId('download-mapped').disabled, false);
  assert.equal(f.assetInputs.get('image-1.png').value, url(1));
  assert.equal(f.assetInputs.get('image-3.png').value, url(3));
  f.choose('second'); assert.equal(f.byId('copy-mapped').disabled, false);
});

test('newly filled shared exact address does not silently confirm the other pending image', async t => {
  const f = fixture(t, { shared: true });
  await f.importReport(orderReport([1, 3]));
  f.choose('second');
  await f.importReport({ detectedCount: 1, matches: [{ filename: 'image-1.png', url: url(1), method: 'filename' }],
    warnings: [], canAdjustOrder: true, orderReady: false, imageChoices: [{ index: 1, url: url(1) }] });
  assert.equal(f.byId('copy-mapped').disabled, false);
  assert.equal(f.assetInputs.get('image-1.png').value, url(1));
  assert.equal(f.assetInputs.get('image-3.png').value, '');
  f.choose('first'); assert.equal(f.byId('image-order-list').children.length, 2);
  assert.equal(f.byId('copy-mapped').disabled, true);
  await f.byId('confirm-image-order').fire('click');
  assert.equal(f.assetInputs.get('image-3.png').value, url(3));
  assert.equal(f.byId('copy-mapped').disabled, false);
});
