import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressGuard } from '../public/progress-guard.js';

test('no document starts clean and ignores edits, saves and page exit', () => {
  const changes = [];
  const guard = createProgressGuard({ onChange: state => changes.push(state) });
  const initial = { hasDocument: false, dirty: false, lastSavedAt: null, restored: false };
  assert.deepEqual(guard.snapshot(), initial);
  assert.equal(guard.capture(), undefined);
  assert.deepEqual(guard.changed(), initial);
  assert.equal(guard.saved(undefined), false);
  assert.deepEqual(changes, []);
  const event = { preventDefault: () => assert.fail('clean exit must remain untouched'), returnValue: 'unchanged' };
  guard.beforeUnload(event);
  assert.equal(event.returnValue, 'unchanged');
});

test('a successful new conversion starts dirty and a current ZIP save records the actual save time', () => {
  let time = 100;
  let clockCalls = 0;
  const changes = [];
  const guard = createProgressGuard({ onChange: state => changes.push(state), now: () => { clockCalls++; return time; } });
  assert.deepEqual(guard.newDocument(), { hasDocument: true, dirty: true, lastSavedAt: null, restored: false });
  const stamp = guard.capture();
  assert.equal(guard.capture(), stamp);
  assert.ok(Object.isFrozen(stamp));
  assert.equal(clockCalls, 0);
  time = 250;
  assert.equal(guard.saved(stamp), true);
  assert.deepEqual(guard.snapshot(), { hasDocument: true, dirty: false, lastSavedAt: 250, restored: false });
  assert.equal(clockCalls, 1);
  time = 500;
  guard.changed();
  assert.deepEqual(guard.snapshot(), { hasDocument: true, dirty: true, lastSavedAt: 250, restored: false });
  assert.equal(clockCalls, 1);
  assert.equal(changes.length, 3);
  assert.equal(changes[0].dirty, true);
  changes[0].lastSavedAt = 'caller mutation';
  const detached = guard.snapshot(); detached.dirty = false;
  assert.equal(guard.snapshot().lastSavedAt, 250);
  assert.equal(guard.snapshot().dirty, true);
});

test('edits reject stale revision stamps even if the document was already dirty', () => {
  let clockCalls = 0;
  const changes = [];
  const guard = createProgressGuard({ now: () => ++clockCalls, onChange: state => changes.push(state) });
  guard.newDocument();
  const first = guard.capture();
  guard.changed();
  const second = guard.capture();
  guard.changed();
  assert.notEqual(first, second);
  assert.notEqual(second, guard.capture());
  assert.equal(guard.saved(first), false);
  assert.equal(guard.saved(second), false);
  assert.equal(clockCalls, 0);
  assert.equal(changes.length, 3);
  assert.equal(guard.snapshot().dirty, true);
  assert.equal(guard.saved(guard.capture()), true);
  assert.equal(clockCalls, 1);
});

test('new documents invalidate old stamps and clear previous save times', () => {
  const guard = createProgressGuard({ now: () => 700 });
  guard.newDocument();
  const oldDocument = guard.capture();
  assert.equal(guard.saved(oldDocument), true);
  guard.newDocument();
  const state = { hasDocument: true, dirty: true, lastSavedAt: null, restored: false };
  assert.deepEqual(guard.snapshot(), state);
  assert.equal(guard.saved(oldDocument), false);
  assert.deepEqual(guard.snapshot(), state);
  const otherGuard = createProgressGuard(); otherGuard.newDocument();
  assert.equal(guard.saved(otherGuard.capture()), false);
  assert.equal(guard.saved({ ...guard.capture() }), false);
});

test('restoring creates a clean document without inventing a save timestamp', () => {
  let clockCalls = 0;
  const guard = createProgressGuard({ now: () => ++clockCalls });
  guard.newDocument();
  const oldDocument = guard.capture();
  guard.saved(oldDocument);
  assert.deepEqual(guard.restored(), { hasDocument: true, dirty: false, lastSavedAt: null, restored: true });
  const restoredStamp = guard.capture();
  assert.notEqual(restoredStamp, oldDocument);
  assert.equal(guard.saved(oldDocument), false);
  assert.equal(clockCalls, 1);
  guard.changed();
  assert.equal(guard.snapshot().dirty, true);
  assert.equal(guard.saved(restoredStamp), false);
  assert.equal(guard.saved(guard.capture()), true);
  assert.deepEqual(guard.snapshot(), { hasDocument: true, dirty: false, lastSavedAt: 2, restored: false });
});

test('beforeUnload invokes native confirmation only while current work is dirty', () => {
  const guard = createProgressGuard();
  let prevented = 0;
  const event = () => ({ preventDefault: () => prevented++, returnValue: 'unchanged' });
  guard.newDocument();
  const dirtyExit = event(); guard.beforeUnload(dirtyExit);
  assert.equal(prevented, 1);
  assert.equal(dirtyExit.returnValue, '');
  guard.saved(guard.capture());
  const savedExit = event(); guard.beforeUnload(savedExit);
  assert.equal(prevented, 1);
  assert.equal(savedExit.returnValue, 'unchanged');
  guard.changed();
  guard.beforeUnload(event());
  assert.equal(prevented, 2);
  guard.restored();
  guard.beforeUnload(event());
  assert.equal(prevented, 2);
});

test('observer failures do not undo state transitions', async () => {
  for (const onChange of [() => { throw new Error('UI failed'); }, () => Promise.reject(new Error('UI failed asynchronously'))]) {
    const guard = createProgressGuard({ onChange, now: () => 123 });
    guard.newDocument(); guard.changed();
    assert.equal(guard.saved(guard.capture()), true);
    assert.deepEqual(guard.snapshot(), { hasDocument: true, dirty: false, lastSavedAt: 123, restored: false });
    guard.restored();
    assert.equal(guard.snapshot().restored, true);
  }
  await new Promise(resolve => setImmediate(resolve));
});
