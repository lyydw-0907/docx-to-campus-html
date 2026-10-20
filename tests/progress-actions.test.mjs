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
  const captures = []; const savedNotifications = []; const restoredNotifications = [];
  const input = options();
  const actions = createProgressActions({
    capture: kind => { events.push('capture:' + kind); if (kind === 'save' && !workspace) throw new Error('请先转换 Word'); const snapshot = { ...(kind === 'save' ? input : {}), context: version }; captures.push(snapshot); return snapshot; },
    isCurrent: stamp => stamp === version,
    convert: async (...args) => { events.push('convert'); signals.push(args[2]); return convertHook(...args); },
    validate: (...args) => { events.push('validate'); return validateHook(...args); },
    commit: (candidate, saved) => { events.push('commit'); workspace = candidate; assert.equal(saved.progress.selectedSectionId, 'later-work-plan'); assert.deepEqual(saved.mapping, input.mapping); },
    download: (...args) => downloads.push(args), status: (...args) => statuses.push(args), busy: value => events.push('busy:' + value),
    cancelConversion: () => events.push('cancel-converter'),
    onSaved: snapshot => savedNotifications.push(snapshot), onRestored: () => restoredNotifications.push(true), ...overrides,
  });
  return { actions, events, downloads, statuses, signals, input, captures, savedNotifications, restoredNotifications, getWorkspace: () => workspace,
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
  assert.equal(f.savedNotifications.length, 1);
  assert.equal(f.savedNotifications[0], f.captures[0]);
  assert.deepEqual(f.restoredNotifications, []);
});

test('saving without a successful conversion does not change the workspace or create a file', async () => {
  const f = harness(); f.clear();
  assert.equal(await f.actions.save(), false);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.actions.isBusy(), false);
  assert.match(f.statuses.at(-1)[0], /先转换/);
  assert.deepEqual(f.savedNotifications, []);
});

test('a document or mapping change during packaging discards the stale download', async () => {
  const f = harness(); const read = deferred();
  class SlowBlob extends Blob { async arrayBuffer() { await read.promise; return super.arrayBuffer(); } }
  f.input.input = new SlowBlob(['synthetic original Word']);
  const saving = f.actions.save(); f.change(); read.resolve();
  assert.equal(await saving, false);
  assert.equal(f.downloads.length, 0);
  assert.match(f.statuses.at(-1)[0], /工作内容已变化/);
  assert.deepEqual(f.savedNotifications, []);
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
  assert.deepEqual(f.restoredNotifications, [true]);
  assert.deepEqual(f.savedNotifications, []);
});

test('corrupt progress is rejected before converting or replacing the current work', async () => {
  const f = harness(); const before = f.getWorkspace();
  assert.equal(await f.actions.restore(new Blob(['not a progress file'])), false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('convert'));
  assert.ok(!f.events.includes('commit'));
  assert.match(f.statuses.at(-1)[0], /当前工作已保留/);
  assert.deepEqual(f.restoredNotifications, []);
});

test('different converted content cannot reuse the saved image state', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input);
  f.convert(async () => ({ ...result(), fragment: '<p>different document</p>' }));
  assert.equal(await f.actions.restore(bytes), false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('validate'));
  assert.ok(!f.events.includes('commit'));
  assert.match(f.statuses.at(-1)[0], /不一致/);
  assert.deepEqual(f.restoredNotifications, []);
});

test('mapping validation failure preserves the old work and never commits partially', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input);
  f.validate(() => { throw new Error('图片对应关系无效'); });
  assert.equal(await f.actions.restore(bytes), false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('commit'));
  assert.match(f.statuses.at(-1)[0], /对应关系无效.*当前工作已保留/);
  assert.deepEqual(f.restoredNotifications, []);
});

test('a late candidate cannot apply after the caller changes the current document', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input); const conversion = deferred();
  f.convert(() => conversion.promise);
  const restoring = f.actions.restore(bytes); await until(() => f.events.includes('convert'));
  f.change(); conversion.resolve(result());
  assert.equal(await restoring, false);
  assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('commit'));
  assert.deepEqual(f.restoredNotifications, []);
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
  assert.deepEqual(f.restoredNotifications, []);
  f.convert(async () => result()); assert.equal(await f.actions.restore(bytes), true);
});

test('cancel during file reading cannot start a converter or replace existing work', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input); const read = deferred();
  class SlowBlob extends Blob { async arrayBuffer() { await read.promise; return super.arrayBuffer(); } }
  const restoring = f.actions.restore(new SlowBlob([bytes])); f.actions.cancel(); read.resolve();
  assert.equal(await restoring, false); assert.equal(f.getWorkspace(), before);
  assert.ok(!f.events.includes('convert')); assert.ok(!f.events.includes('commit'));
  assert.deepEqual(f.restoredNotifications, []);
});

test('conversion failure preserves current work and supports retry', async () => {
  const f = harness(); const before = f.getWorkspace(); const bytes = await createWorkProgress(f.input);
  f.convert(async () => { throw new Error('转换已取消或失败'); });
  assert.equal(await f.actions.restore(bytes), false); assert.equal(f.getWorkspace(), before);
  assert.deepEqual(f.restoredNotifications, []);
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

test('save observers run after the download resolves and receive the exact captured snapshot', async () => {
  const download = deferred(); const events = [];
  const f = harness({
    download: () => { events.push('download'); return download.promise; },
    onSaved: snapshot => { events.push('saved'); assert.equal(snapshot, f.captures[0]); },
  });
  const saving = f.actions.save();
  await until(() => events.includes('download'));
  assert.deepEqual(events, ['download']);
  assert.equal(f.actions.isBusy(), true);
  download.resolve();
  assert.equal(await saving, true);
  assert.deepEqual(events, ['download', 'saved']);
});

test('packaging and download failures never notify saved observers', async () => {
  const invalid = harness(); invalid.input.mapping = undefined;
  assert.equal(await invalid.actions.save(), false);
  assert.deepEqual(invalid.savedNotifications, []);
  assert.equal(invalid.downloads.length, 0);
  for (const download of [() => { throw new Error('download failed'); }, async () => { throw new Error('download failed'); }]) {
    const f = harness({ download });
    assert.equal(await f.actions.save(), false);
    assert.deepEqual(f.savedNotifications, []);
    assert.match(f.statuses.at(-1)[0], /download failed/);
    assert.equal(f.actions.isBusy(), false);
  }
});

test('cancellation during packaging skips download and saved observers', async () => {
  const f = harness(); const read = deferred();
  class SlowBlob extends Blob { async arrayBuffer() { await read.promise; return super.arrayBuffer(); } }
  f.input.input = new SlowBlob(['synthetic original Word']);
  const saving = f.actions.save(); f.actions.cancel();
  assert.equal(f.actions.isBusy(), true);
  read.resolve();
  assert.equal(await saving, false);
  assert.equal(f.downloads.length, 0);
  assert.deepEqual(f.savedNotifications, []);
  assert.match(f.statuses.at(-1)[0], /已取消保存/);
});

test('a changed or cancelled operation cannot report saved after a pending download', async () => {
  for (const interrupted of ['changed', 'cancelled']) {
    const download = deferred(); let started = false;
    const f = harness({ download: () => { started = true; return download.promise; } });
    const saving = f.actions.save(); await until(() => started);
    if (interrupted === 'changed') f.change(); else f.actions.cancel();
    download.resolve();
    assert.equal(await saving, false);
    assert.deepEqual(f.savedNotifications, []);
    assert.match(f.statuses.at(-1)[0], interrupted === 'changed' ? /工作内容已变化/ : /已取消保存/);
  }
});

test('restore observers run after successful commit, and commit failure skips the observer', async () => {
  const events = [];
  const f = harness({ commit: () => events.push('commit'), onRestored: () => events.push('restored') });
  const bytes = await createWorkProgress(f.input);
  assert.equal(await f.actions.restore(bytes), true);
  assert.deepEqual(events, ['commit', 'restored']);
  const failed = harness({ commit: () => { throw new Error('commit failed'); } });
  assert.equal(await failed.actions.restore(bytes), false);
  assert.deepEqual(failed.restoredNotifications, []);
  assert.match(failed.statuses.at(-1)[0], /commit failed/);
});

test('throwing or rejecting observers do not change successful save and restore status', async () => {
  for (const observer of [() => { throw new Error('observer failed'); }, () => Promise.reject(new Error('observer failed asynchronously'))]) {
    const f = harness({ onSaved: observer, onRestored: observer });
    assert.equal(await f.actions.save(), true);
    assert.equal(f.downloads.length, 1);
    assert.match(f.statuses.at(-1)[0], /已下载/);
    assert.notEqual(f.statuses.at(-1)[1], true);
    const bytes = await createWorkProgress(f.input);
    assert.equal(await f.actions.restore(bytes), true);
    assert.ok(f.events.includes('commit'));
    assert.match(f.statuses.at(-1)[0], /已恢复/);
    assert.notEqual(f.statuses.at(-1)[1], true);
    assert.equal(f.actions.isBusy(), false);
  }
  await new Promise(resolve => setImmediate(resolve));
});
