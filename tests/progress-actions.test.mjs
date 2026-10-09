import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressActions } from '../public/progress-actions.js';
import { createWorkProgress, readWorkProgress } from '../public/work-progress.js';

const params = 'documentType=progress&fontMode=word&fontSize=14&scale=3&formulaFormat=mathml';
const result = () => ({ jobId: 'synthetic-job', fragment: '<p>合成进度正文</p>', preview: '<p>local preview</p>', assets: [],
  sections: [{ id: 'later-work-plan', title: '项目后期具体工作计划', kind: 'field', fragment: '<p>合成进度正文</p>',
    preview: '<p>local preview</p>', assetFilenames: [], formulaCount: 0, imageCount: 0 }],
  manifest: { formulas: [], options: { documentType: 'progress', fontMode: 'word', fontSize: 14, scale: 3, formulaFormat: 'mathml', imageMode: 'embedded' } } });
const mapping = () => ({ version: 1, urls: {}, sources: [{ sectionId: 'later-work-plan', html: '<p>尚未导入的学校源码</p>', pageUrl: '' }], orders: [] });
const options = () => ({ input: new Blob(['synthetic original Word']), name: '合成进展.docx', params,
  result: result(), mapping: mapping(), selectedSectionId: 'later-work-plan' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(predicate()); }

function harness(overrides = {}) {
  let version = 0;
  let workspace = result();
  let convertHook = async () => result();
  let validateHook = value => structuredClone(value);
  const events = []; const downloads = []; const statuses = []; const signals = [];
  const input = options();
  const actions = createProgressActions({
    capture: kind => { events.push('capture:' + kind); if (kind === 'save' && !workspace) throw new Error('请先转换 Word'); return { ...(kind === 'save' ? input : {}), context: version }; },
    isCurrent: stamp => stamp === version,
    convert: async (...args) => { events.push('convert'); signals.push(args[2]); return convertHook(...args); },
    validate: (...args) => { events.push('validate'); return validateHook(...args); },
    commit: (candidate, saved) => { events.push('commit'); workspace = candidate; assert.equal(saved.progress.selectedSectionId, 'later-work-plan'); assert.deepEqual(saved.mapping, input.mapping); },
    download: (...args) => downloads.push(args), status: (...args) => statuses.push(args), busy: value => events.push('busy:' + value),
    cancelConversion: () => events.push('cancel-converter'), ...overrides,
  });
  return { actions, events, downloads, statuses, signals, input, getWorkspace: () => workspace,
    change: () => version++, clear: () => { workspace = undefined; },
    convert: hook => { convertHook = hook; }, validate: hook => { validateHook = hook; } };
}

test('save downloads one self-contained progress package from the captured conversion', async () => {
  const f = harness();
  assert.equal(await f.actions.save(), true);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0][1], '合成进展-工作进度.zip');
  const saved = await readWorkProgress(f.downloads[0][0]);
  assert.equal(saved.progress.params, params);
  assert.deepEqual(saved.progress.mapping, f.input.mapping);
  assert.equal(new TextDecoder().decode(saved.source), 'synthetic original Word');
  assert.deepEqual(f.events, ['capture:save', 'busy:save', 'busy:false']);
});

test('saving without a successful conversion does not change the workspace or create a file', async () => {
  const f = harness(); f.clear();
  assert.equal(await f.actions.save(), false);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.actions.isBusy(), false);
  assert.match(f.statuses.at(-1)[0], /先转换/);
});

test('a document or mapping change during packaging discards the stale download', async () => {
  const f = harness(); const read = deferred();
  class SlowBlob extends Blob { async arrayBuffer() { await read.promise; return super.arrayBuffer(); } }
  f.input.input = new SlowBlob(['synthetic original Word']);
  const saving = f.actions.save(); f.change(); read.resolve();
  assert.equal(await saving, false);
  assert.equal(f.downloads.length, 0);
  assert.match(f.statuses.at(-1)[0], /工作内容已变化/);
});

test('restore validates a fresh candidate before synchronous commit and unlocks controls afterwards', async () => {
  const f = harness(); const bytes = await createWorkProgress(f.input);
  const before = f.getWorkspace();
  f.validate(saved => { assert.equal(f.getWorkspace(), before); return saved; });
  assert.equal(await f.actions.restore(bytes), true);
  assert.notEqual(f.getWorkspace(), before);
  assert.deepEqual(f.events, ['capture:restore', 'busy:restore', 'convert', 'validate', 'commit', 'busy:false']);
  assert.equal(f.signals[0].aborted, false);
  assert.equal(f.actions.isBusy(), false);
});

test('corrupt progress is rejected before converting or replacing the current work', async () => {
  const f = harness(); const before = f.getWorkspace();
  assert.equal(await f.actions.restore(new Blob(['not a progress file'])), false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('convert'));
  assert.ok(!f.events.includes('commit'));
  assert.match(f.statuses.at(-1)[0], /当前工作已保留/);
});

test('different converted content cannot reuse the saved image state', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input);
  f.convert(async () => ({ ...result(), fragment: '<p>different document</p>' }));
  assert.equal(await f.actions.restore(bytes), false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('validate'));
  assert.ok(!f.events.includes('commit'));
  assert.match(f.statuses.at(-1)[0], /不一致/);
});

test('mapping validation failure preserves the old work and never commits partially', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input);
  f.validate(() => { throw new Error('图片对应关系无效'); });
  assert.equal(await f.actions.restore(bytes), false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('commit'));
  assert.match(f.statuses.at(-1)[0], /对应关系无效.*当前工作已保留/);
});

test('a late candidate cannot apply after the caller changes the current document', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input); const conversion = deferred();
  f.convert(() => conversion.promise);
  const restoring = f.actions.restore(bytes); await until(() => f.events.includes('convert'));
  f.change(); conversion.resolve(result());
  assert.equal(await restoring, false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('commit'));
});

test('cancel aborts a restore, keeps the lock until settlement and permits a later retry', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input); const conversion = deferred();
  f.convert(() => conversion.promise);
  const restoring = f.actions.restore(bytes); await until(() => f.events.includes('convert'));
  f.actions.cancel();
  assert.equal(f.signals[0].aborted, true);
  assert.equal(f.actions.isBusy(), true);
  assert.equal(await f.actions.save(), false);
  assert.equal(await f.actions.restore(bytes), false);
  conversion.resolve(result()); assert.equal(await restoring, false);
  assert.equal(f.getWorkspace(), before); assert.ok(!f.events.includes('commit'));
  assert.match(f.statuses.at(-1)[0], /已取消恢复/);
  assert.equal(f.actions.isBusy(), false);
  f.convert(async () => result()); assert.equal(await f.actions.restore(bytes), true);
});

test('cancel during file reading cannot start a converter or replace existing work', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input); const read = deferred();
  class SlowBlob extends Blob { async arrayBuffer() { await read.promise; return super.arrayBuffer(); } }
  const restoring = f.actions.restore(new SlowBlob([bytes])); f.actions.cancel(); read.resolve();
  assert.equal(await restoring, false); assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('convert')); assert.ok(!f.events.includes('commit'));
});

test('conversion failure preserves current work and supports retry', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input);
  f.convert(async () => { throw new Error('转换已取消或失败'); });
  assert.equal(await f.actions.restore(bytes), false); assert.equal(f.getWorkspace(), before);
  f.convert(async () => result()); assert.equal(await f.actions.restore(bytes), true);
});

test('concurrent save requests create only one archive', async () => {
  const f = harness(); const read = deferred();
  class SlowBlob extends Blob { async arrayBuffer() { await read.promise; return super.arrayBuffer(); } }
  f.input.input = new SlowBlob(['synthetic original Word']);
  const saving = f.actions.save(); assert.equal(await f.actions.save(), false);
  assert.equal(f.events.filter(event => event === 'capture:save').length, 1);
  read.resolve(); assert.equal(await saving, true); assert.equal(f.downloads.length, 1);
});
