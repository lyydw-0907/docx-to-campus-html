import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversionActions } from '../public/conversion-actions.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(overrides = {}) {
  const original = { source: 'old Word', html: 'old mapped body', order: ['2', '1'], sourceName: 'original.docx', params: 'old options' };
  let displayed = original; let epoch = 1;
  const locks = [], messages = [], committed = [];
  let candidate = async input => ({ html: 'new body', source: input });
  const actions = createConversionActions({
    capture: () => ({ epoch, hasResult: Boolean(displayed) }),
    isCurrent: stamp => stamp.epoch === epoch,
    convert: (...args) => candidate(...args),
    commit: (result, input, params) => { displayed = { ...result, source: input, params }; committed.push(displayed); },
    onCommitted: overrides.onCommitted,
    busy: value => locks.push(value), status: (...args) => messages.push(args),
    ...overrides,
  });
  return { actions, original, locks, messages, committed, current: () => displayed,
    convertWith: fn => { candidate = fn; }, supersede: () => epoch++ };
}

test('candidate conversion retains the exact old source, mapping and pending order until successful commit', async () => {
  const f = setup(), waiting = deferred(); f.convertWith(() => waiting.promise);
  const work = f.actions.run({ input: 'new Word', params: 'captured settings' });
  assert.equal(f.current(), f.original); assert.equal(f.actions.isBusy(), true);
  assert.deepEqual(f.current().order, ['2', '1']);
  waiting.resolve({ html: 'candidate body' }); assert.equal(await work, true);
  assert.equal(f.current().source, 'new Word'); assert.equal(f.current().params, 'captured settings');
  assert.deepEqual(f.locks, [true, false]);
});

for (const reason of ['Invalid DOCX', 'Conversion cancelled', 'Engine timeout']) test(`${reason} keeps old working state and unlocks retry`, async () => {
  const f = setup(); f.convertWith(async () => { throw new Error(reason); });
  assert.equal(await f.actions.run({ input: 'bad', params: 'options' }), false);
  assert.equal(f.current(), f.original); assert.equal(f.actions.isBusy(), false);
  assert.match(f.messages.at(-1)[0], /当前工作已保留/);
  f.convertWith(async () => ({ html: 'retried body' }));
  assert.equal(await f.actions.run({ input: 'valid', params: 'retry' }), true);
  assert.equal(f.current().source, 'valid');
});

test('failed asynchronous demo load preserves old result without invoking conversion', async () => {
  const f = setup(); f.convertWith(() => { throw new Error('Must not convert'); });
  assert.equal(await f.actions.run({ params: 'demo options', loadInput: async () => { throw new Error('Demo GET failed'); } }), false);
  assert.equal(f.current(), f.original); assert.match(f.messages.at(-1)[0], /Demo GET failed/);
  assert.deepEqual(f.locks, [true, false]);
});

test('demo input and click-time settings are committed together; concurrent requests are ignored', async () => {
  const f = setup(), loading = deferred(); let calls = 0;
  f.convertWith(async (input, params) => { calls++; assert.equal(input, 'progress-demo'); assert.equal(params, 'progress/word/14'); return { html: 'demo body' }; });
  const first = f.actions.run({ params: 'progress/word/14', loadInput: () => loading.promise });
  assert.equal(await f.actions.run({ input: 'second', params: 'changed settings' }), false);
  assert.equal(calls, 0); loading.resolve('progress-demo'); assert.equal(await first, true);
  assert.equal(calls, 1); assert.equal(f.committed.length, 1);
});

test('superseded demo and candidate replies never replace the displayed workspace', async () => {
  const f = setup(), candidate = deferred(); f.convertWith(() => candidate.promise);
  const work = f.actions.run({ input: 'new', params: 'options' });
  f.supersede(); candidate.resolve({ html: 'stale' }); assert.equal(await work, false);
  assert.equal(f.current(), f.original); assert.equal(f.committed.length, 0);
  const loading = deferred(); const demo = f.actions.run({ params: 'demo', loadInput: () => loading.promise });
  f.supersede(); loading.resolve('stale demo'); assert.equal(await demo, false);
  assert.equal(f.current(), f.original);
});

test('commit observers only run for successful commits', async () => {
  let count = 0; const f = setup({ onCommitted: () => count++ });
  f.convertWith(async () => { throw new Error('failed'); });
  await f.actions.run({ input: 'bad' }); assert.equal(count, 0);
  f.convertWith(async () => ({ html: 'good' }));
  await f.actions.run({ input: 'good' }); assert.equal(count, 1);
});

test('observer exceptions do not report failure after a successful commit', async () => {
  for (const onCommitted of [() => { throw new Error('UI observer'); }, async () => { throw new Error('async observer'); }]) {
    const f = setup({ onCommitted });
    assert.equal(await f.actions.run({ input: 'good', params: 'saved options' }), true);
    assert.equal(f.current().source, 'good'); assert.equal(f.committed.length, 1);
    assert.deepEqual(f.locks, [true, false]);
  }
  await new Promise(resolve => setImmediate(resolve));
});
