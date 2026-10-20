/** In-memory save state. Only an exact current document/revision can be saved. */
export function createProgressGuard({ onChange, now = Date.now } = {}) {
  let documentId = 0;
  let revision = 0;
  let stamp;
  let state = { hasDocument: false, dirty: false, lastSavedAt: null, restored: false };

  const snapshot = () => ({ ...state });
  function notify() {
    const value = snapshot();
    // A UI observer must not undo a document or save state transition.
    try { Promise.resolve(onChange?.(value)).catch(() => {}); } catch {}
    return value;
  }
  function start(restored) {
    documentId++;
    revision = 0;
    stamp = Object.freeze({ documentId, revision });
    state = { hasDocument: true, dirty: !restored, lastSavedAt: null, restored };
    return notify();
  }
  function changed() {
    if (!state.hasDocument) return snapshot();
    stamp = Object.freeze({ documentId, revision: ++revision });
    state.dirty = true;
    return notify();
  }
  function saved(savedStamp) {
    // Reference identity also rejects stamps from another guard instance.
    if (!state.hasDocument || savedStamp !== stamp) return false;
    state.dirty = false;
    state.lastSavedAt = now();
    state.restored = false;
    notify();
    return true;
  }
  function beforeUnload(event) {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  }
  return { newDocument: () => start(false), changed, capture: () => stamp,
    saved, restored: () => start(true), snapshot, beforeUnload };
}
