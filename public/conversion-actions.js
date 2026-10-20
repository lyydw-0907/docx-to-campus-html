/** Convert a candidate without changing the displayed document until commit. */
export function createConversionActions({ capture, convert, commit, isCurrent, busy, status, onCommitted }) {
  let pending;
  async function run({ input, params, loadInput }) {
    if (pending) return false;
    const operation = {};
    pending = operation;
    let snapshot;
    try {
      snapshot = capture();
      busy(true);
      status(loadInput ? '正在读取示例 Word…' : '正在转换正文和公式…');
      const source = loadInput ? await loadInput() : input;
      if (!isCurrent(snapshot)) return false;
      const result = await convert(source, params);
      if (!isCurrent(snapshot)) return false;
      commit(result, source, params);
      // UI observers cannot turn an already committed document into a failure.
      try { Promise.resolve(onCommitted?.()).catch(() => {}); } catch {}
      return true;
    } catch (error) {
      if (!snapshot || isCurrent(snapshot)) status(`${error.message || '转换未完成。'}${snapshot?.hasResult ? ' 当前工作已保留，可继续复制或保存进度。' : ''}`, true);
      return false;
    } finally {
      if (pending === operation) { pending = undefined; busy(false); }
    }
  }
  return { run, isBusy: () => Boolean(pending) };
}
