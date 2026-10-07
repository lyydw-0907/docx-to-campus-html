import { Buffer } from 'buffer';
import { Inflate } from 'fflate';
import { createPandocInstance } from '../node_modules/pandoc-wasm/src/core.js';
import { convertDocxWithRuntime } from './convert-core.mjs';
import { browserImageMetadata } from './browser-images.mjs';

const MAX_OUTPUT = 32 * 1024 * 1024;
let instancePromise;
let conversionQueue = Promise.resolve();

/** Load the vendored engine once; callers may supply its static URL or already downloaded bytes. */
export function initializePandoc({ wasmUrl = new URL('./pandoc.wasm', import.meta.url), wasmBinary } = {}) {
  if (!instancePromise) {
    instancePromise = (async () => {
      let binary = wasmBinary;
      if (!binary) {
        const response = await fetch(wasmUrl, { credentials: 'omit' });
        if (!response.ok) throw new Error('转换引擎加载失败，请刷新页面后重试。');
        binary = await response.arrayBuffer();
      }
      return createPandocInstance(binary);
    })().catch(error => { instancePromise = undefined; throw error; });
  }
  return instancePromise;
}

/** A forged ZIP directory cannot make validation allocate an unbounded inflated entry. */
export function inflateBounded(data, maximum) {
  const chunks = [];
  let size = 0;
  const inflater = new Inflate(chunk => {
    size += chunk.length;
    if (size > maximum) throw new Error('DOCX 实际解压尺寸超过 ZIP 声明。');
    chunks.push(chunk);
  });
  // Small input pieces bound each temporary inflater allocation even for a ZIP bomb.
  for (let offset = 0; offset < data.length; offset += 256) {
    const end = Math.min(data.length, offset + 256);
    inflater.push(data.subarray(offset, end), end === data.length);
  }
  if (!data.length) inflater.push(new Uint8Array(), true);
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
}

async function digest(data) {
  if (!globalThis.crypto?.subtle) throw new Error('当前地址不支持安全转换，请使用 HTTPS 或 localhost 打开工具。');
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(hash).toString('hex').slice(0, 16);
}

export function checkedPandocOutput(result) {
  const stdout = String(result.stdout ?? '');
  const rawStderr = String(result.stderr ?? '');
  // The official WASM API writes structured warnings to a separate channel.
  // The shared core consumes stderr for both notices and fail-closed math errors.
  const warningLines = [...new Set((Array.isArray(result.warnings) ? result.warnings : []).map(warning =>
    typeof warning?.pretty === 'string' && warning.pretty.trim() ? warning.pretty.trim()
      : typeof warning === 'string' ? warning.trim() : JSON.stringify(warning)
  ).filter(text => text && !rawStderr.includes(text)))];
  const stderr = [rawStderr.trimEnd(), ...warningLines].filter(Boolean).join('\n');
  if (new TextEncoder().encode(stdout).length > MAX_OUTPUT) throw new Error('转换结果超过 32 MB 限制。');
  if (!stdout.trim()) throw new Error(`浏览器 Pandoc 转换失败：${stderr.slice(0, 1200) || '未生成文档内容。'}`);
  return { stdout, stderr };
}

const browserRuntime = {
  zipOutputType: 'uint8array',
  inflate: inflateBounded,
  digest,
  imageMetadata: browserImageMetadata,
  renderFormula() { throw new Error('在线版当前只支持 MathML 原生公式；高清公式图片请使用本地版。'); },
  async createSession() {
    const pandoc = await initializePandoc();
    let media = new Map();
    return {
      async readDocx(input) {
        const result = await pandoc.convert({ from: 'docx+styles', to: 'json', 'input-files': ['input.docx'], 'extract-media': 'media' }, null,
          { 'input.docx': new Blob([new Uint8Array(input)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) });
        media = new Map(Object.entries(result.mediaFiles ?? {}));
        return checkedPandocOutput(result);
      },
      async writeAst(input, { mathml = false } = {}) {
        const result = await pandoc.convert({ from: 'json', to: 'html5', wrap: 'none', ...(mathml ? { 'html-math-method': { method: 'mathml' } } : {}) }, input, {});
        return checkedPandocOutput(result);
      },
      async readImage(target) {
        if (typeof target !== 'string' || !target.startsWith('media/') || /[\\:\u0000]/.test(target) || target.split('/').includes('..')) {
          throw new Error('图片路径超出本次转换的隔离目录。');
        }
        const blob = media.get(target);
        if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('文档图片未能提取。请检查图片是否已嵌入 Word。');
        return { name: target.split('/').at(-1), data: Buffer.from(await blob.arrayBuffer()) };
      },
      dispose() { media.clear(); }
    };
  }
};

/** All DOCX bytes, media and resulting HTML stay inside this browser's worker. */
export function convertDocxInBrowser(input, options = {}) {
  if (options.formulaFormat && options.formulaFormat !== 'mathml') return Promise.reject(new Error('在线版当前只支持 MathML 原生公式。'));
  const operation = async () => {
    let bytes = input;
    if (bytes instanceof Blob) bytes = await bytes.arrayBuffer();
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (!(bytes instanceof Uint8Array)) throw new Error('请提供 DOCX 文件的二进制内容。');
    return convertDocxWithRuntime(Buffer.from(bytes), { fontSize: 14, fontMode: 'word', ...options, formulaFormat: 'mathml' }, browserRuntime);
  };
  const pending = conversionQueue.then(operation, operation);
  conversionQueue = pending.catch(() => {});
  return pending;
}
