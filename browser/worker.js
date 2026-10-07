import { initializePandoc, convertDocxInBrowser } from '../src/browser-convert.mjs';

let initialized;
let busy = false;

async function loadEngine(id, url) {
  self.postMessage({ id, type: 'progress', message: '首次使用正在加载浏览器转换组件，Word 文件留在本机…' });
  const response = await fetch(url);
  if (!response.ok) throw new Error('浏览器转换组件下载失败，请检查网络后重试。');
  const expected = Number(response.headers.get('content-length') || 0);
  let binary;
  if (!response.body) binary = await response.arrayBuffer();
  else {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastUpdate = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length;
      if (Date.now() - lastUpdate > 500) {
        const amount = (received / 1024 / 1024).toFixed(1);
        self.postMessage({ id, type: 'progress', message: `正在加载浏览器转换组件 ${amount}${expected ? ` / ${(expected / 1024 / 1024).toFixed(1)}` : ''} MB；文档不会上传…` });
        lastUpdate = Date.now();
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    binary = bytes.buffer;
  }
  // Some static hosts add Content-Encoding:gzip and the browser has already
  // decompressed the response. Inspect its bytes instead of decompressing twice.
  const header = new Uint8Array(binary, 0, Math.min(4, binary.byteLength));
  if (header[0] === 0x1f && header[1] === 0x8b) {
    if (!globalThis.DecompressionStream) throw new Error('当前浏览器不支持转换组件解压，请更新浏览器后重试。');
    binary = await new Response(new Blob([binary]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  if (new Uint8Array(binary, 0, Math.min(4, binary.byteLength)).join(',') !== '0,97,115,109') throw new Error('转换组件内容不正确，请刷新或检查托管文件。');
  self.postMessage({ id, type: 'progress', message: '正在准备浏览器转换组件…' });
  await initializePandoc({ wasmBinary: binary });
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'convert') return;
  if (busy) { self.postMessage({ id: data.id, type: 'error', message: '转换任务仍在运行。' }); return; }
  busy = true;
  try {
    initialized ??= loadEngine(data.id, data.engineUrl).catch(error => { initialized = undefined; throw error; });
    await initialized;
    self.postMessage({ id: data.id, type: 'progress', message: '正在浏览器内转换正文、表格和 MathML 公式…' });
    const result = await convertDocxInBrowser(data.input, data.options);
    // Preview local data only. Mapped school URLs remain in copy/export text.
    const localPreview = html => html?.replace(/img-src[^;"']*/g, "img-src data: blob:");
    result.preview = localPreview(result.preview);
    for (const section of result.sections || []) section.preview = localPreview(section.preview);
    self.postMessage({ id: data.id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id: data.id, type: 'error', message: error.message || '文档转换未完成。' });
  } finally { busy = false; }
};
