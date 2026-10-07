import { createBrowserApi } from './local-api.js';

let worker;
let sequence = 0;
let active;
let closed = false;
const engineUrl = new URL('./pandoc.wasm.gz', import.meta.url).href;
const status = message => {
  const node = document.getElementById('status');
  if (node) { node.textContent = message; node.classList.remove('error'); }
};

function finish(error, result) {
  const pending = active;
  if (!pending) return;
  active = undefined;
  clearTimeout(pending.timer);
  const cancel = document.getElementById('cancel-conversion');
  if (cancel) cancel.hidden = true;
  if (error) pending.reject(error);
  else pending.resolve(result);
}

function stop(message) {
  worker?.terminate();
  worker = undefined;
  finish(new Error(message));
}

function ensureWorker() {
  if (worker) return worker;
  const target = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'campus-word-converter' });
  worker = target;
  target.onmessage = ({ data }) => {
    if (worker !== target || !active || data.id !== active.id) return;
    if (data.type === 'progress') status(data.message);
    else if (data.type === 'result') finish(undefined, data.result);
    else if (data.type === 'error') {
      worker?.terminate(); worker = undefined;
      finish(new Error(data.message || '浏览器转换未完成。'));
    }
  };
  target.onerror = event => {
    event.preventDefault();
    if (worker !== target) return;
    stop(event.message || '浏览器转换组件未能运行，请使用较新的 Edge、Chrome 或 Firefox。');
  };
  return target;
}

async function convert(input, options) {
  if (closed) throw new Error('页面已离开，请重新打开工具。');
  if (active) throw new Error('正在转换另一个文档，请稍后再试。');
  if (!globalThis.Worker || !globalThis.crypto?.subtle) throw new Error('请通过 HTTPS 或 localhost 打开，并使用支持 WebAssembly 的现代浏览器。');
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const pending = { id, resolve, reject, timer: setTimeout(() => stop('浏览器转换超过三分钟，已停止任务。请分段转换或缩小文档后重试。'), 180_000) };
    // Reserve the conversion before reading a Blob so cancellation and another
    // conversion cannot race with its asynchronous arrayBuffer() operation.
    active = pending;
    const cancel = document.getElementById('cancel-conversion');
    if (cancel) cancel.hidden = false;
    (async () => {
      const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer())
        : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input);
      if (closed || active !== pending) return;
      const target = ensureWorker();
      target.postMessage({ id, type: 'convert', input: bytes, options, engineUrl });
    })().catch(error => { if (active === pending) stop(error.message || '浏览器转换未完成。'); });
  });
}

export const browserApi = createBrowserApi({ convert,
  demoUrl: new URL('./demo.docx', import.meta.url).href,
  progressDemoUrl: new URL('./progress-demo.docx', import.meta.url).href });
export const localRequest = (input, init) => browserApi.request(input, init);
export const assetUrl = (jobId, filename) => browserApi.assetUrl(jobId, filename);
document.getElementById('cancel-conversion')?.addEventListener('click', () => stop('转换已取消。可以重新选择 Word 文件。'));
window.addEventListener('pagehide', () => {
  closed = true;
  stop('页面已离开，本地转换已停止。');
  browserApi.dispose?.();
});
// A restored back/forward-cache page still contains its disposed API and old
// UI. Reload it to recreate the tool without retaining document material.
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
