import { createWorkProgress, readWorkProgress, validateRestoredProgress } from './work-progress.js';

/** Transactional user-downloaded progress. Candidate work never clears the page. */
export function createProgressActions({ capture, isCurrent, convert, validate, commit,
  download, status, busy, cancelConversion }) {
  let pending;
  let generation = 0;

  const active = operation => pending === operation && operation.generation === generation
    && !operation.controller.signal.aborted && isCurrent(operation.snapshot.context);

  function begin(kind) {
    if (pending) return undefined;
    const snapshot = capture(kind);
    const operation = { kind, snapshot, generation: ++generation, controller: new AbortController() };
    pending = operation;
    busy(kind);
    return operation;
  }
  function finish(operation) {
    if (pending !== operation) return;
    pending = undefined;
    busy(false);
  }
  function changed(operation) {
    if (pending === operation && !operation.controller.signal.aborted) {
      status('工作内容已变化，这次操作已停止。请重新保存或恢复进度。', true);
    }
  }
  async function save() {
    let operation;
    try {
      operation = begin('save');
      if (!operation) return false;
      status('正在保存原 Word 和工作进度…');
      const archive = await createWorkProgress(operation.snapshot);
      if (!active(operation)) { changed(operation); return false; }
      const stem = operation.snapshot.name.replace(/\.docx$/i, '');
      download(new Blob([archive], { type: 'application/zip' }), `${stem}-工作进度.zip`);
      status('工作进度已下载。下次选择这个进度文件即可恢复，无需解压或重新选择 Word。');
      return true;
    } catch (error) {
      if (!operation || pending === operation && !operation.controller.signal.aborted) status(error.message || '进度保存未完成。', true);
      return false;
    } finally { if (operation) finish(operation); }
  }
  async function restore(input) {
    let operation;
    try {
      operation = begin('restore');
      if (!operation) return false;
      status('正在读取进度文件…');
      const candidate = await readWorkProgress(input);
      if (!active(operation)) { changed(operation); return false; }
      status('正在重新转换原 Word 并核对工作进度…');
      const result = await convert(candidate.source, candidate.progress.params, operation.controller.signal);
      if (!active(operation)) { changed(operation); return false; }
      await validateRestoredProgress(candidate.progress, result);
      if (!active(operation)) { changed(operation); return false; }
      const mapping = await validate(candidate.progress.mapping, result);
      if (!active(operation)) { changed(operation); return false; }
      // The commit callback is synchronous: all decoding and validation finish first.
      commit(result, { ...candidate, mapping });
      status('工作进度已恢复。已确认的图片可以继续复制，待确认的对应关系仍需核对。');
      return true;
    } catch (error) {
      if (!operation || pending === operation && !operation.controller.signal.aborted) {
        status(`${error.message || '进度恢复未完成。'}当前工作已保留。`, true);
      }
      return false;
    } finally { if (operation) finish(operation); }
  }
  function cancel() {
    const operation = pending;
    if (!operation) return;
    generation++;
    operation.controller.abort();
    if (operation.kind === 'restore') cancelConversion?.();
    // Retain the lock until the cancelled task has actually settled. This prevents
    // a local converter that ignores AbortSignal from racing a subsequent task.
    status(operation.kind === 'restore' ? '已取消恢复，当前工作已保留。' : '已取消保存。');
  }
  return { save, restore, cancel, isBusy: () => Boolean(pending) };
}
