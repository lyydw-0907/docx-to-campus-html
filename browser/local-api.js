import JSZip from 'jszip';
import { load } from './html.js';
import { compareFragments, safeImageUrl } from './compare.js';
import { importImageUrls } from './image-import.js';
import { validateDocumentType } from '../src/sections.mjs';
import { resolveImageScope } from '../src/image-scope.mjs';

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const JOB_TTL = 30 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTENT_TYPE_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function reply(status, data, type = 'application/json; charset=utf-8', headers = {}) {
  return new Response(type.startsWith('application/json') ? JSON.stringify(data) : data, {
    status,
    headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers },
  });
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('本地文件数据无效。');
}

async function readBody(input, init, max, tooLarge = '请求过大。Word 文件最多 20 MB。') {
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(init?.headers ?? request?.headers);
  if (Number(headers.get('Content-Length')) > max) throw new Error(tooLarge);
  let value;
  if (init && Object.hasOwn(init, 'body')) value = init.body;
  else if (request) value = await request.arrayBuffer();
  if (value === undefined || value === null) value = new Uint8Array();
  if (typeof value === 'string') value = encoder.encode(value);
  else if (value instanceof Blob) {
    if (value.size > max) throw new Error(tooLarge);
    value = new Uint8Array(await value.arrayBuffer());
  }
  const result = bytes(value);
  if (result.byteLength > max) throw new Error(tooLarge);
  return result;
}

async function readJson(input, init, max, tooLarge) {
  const body = await readBody(input, init, max, tooLarge);
  try { return JSON.parse(decoder.decode(body)); }
  catch { throw new Error('请求格式无效，请提供有效的 JSON 数据。'); }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function base64(value) {
  // Keep each function call well below browser argument/stack limits.
  let binary = '';
  for (let start = 0; start < value.byteLength; start += 0x8000) {
    binary += String.fromCharCode(...value.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function imageDataSource(asset) { return `data:${asset.mime};base64,${base64(asset.data)}`; }

function sourceMappings(result, urls, assets = resolveImageScope(result).assets) {
  if (!plainObject(urls)) throw new Error('图片地址列表无效。');
  const sources = new Map();
  const mapped = new Map();
  for (const asset of assets) {
    if (!Object.hasOwn(urls, asset.filename) || !urls[asset.filename]) throw new Error(`请先填写图片地址：${asset.filename}`);
    const supplied = urls[asset.filename];
    if (typeof supplied !== 'string' || supplied.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(supplied)) throw new Error('图片地址必须是无账号密码的绝对 HTTP(S) URL。');
    const url = safeImageUrl(supplied);
    if (mapped.has(url)) throw new Error(`图片地址重复：${mapped.get(url)} 与 ${asset.filename} 对应同一个学校图片地址，请检查图片对应关系。`);
    mapped.set(url, asset.filename);
    sources.set(imageDataSource(asset), url);
  }
  return sources;
}

function rewriteImages(html, sources) {
  if (!/<img\b/i.test(html)) return html;
  const $ = load(html, null, /^<!doctype/i.test(html.trimStart()) || /<html[\s>]/i.test(html));
  $('img').each((_, element) => {
    const source = $(element).attr('src');
    if (!sources.has(source)) throw new Error('导出图片与资产清单不一致，请重新转换。');
    $(element).attr('src', sources.get(source));
  });
  return $.html();
}

function mapSectionCopy(result, sectionId, urls = {}) {
  if (typeof sectionId !== 'string' || !sectionId) throw new Error('复制栏目标识无效，请重新选择学校栏目。');
  const scope = resolveImageScope(result, sectionId);
  const sources = sourceMappings(result, urls, scope.assets);
  const selected = sectionId === 'whole' ? {
    id: 'whole', title: '整篇文档', kind: 'whole', fragment: result.fragment,
    assetFilenames: result.assets.map(asset => asset.filename),
    formulaCount: result.manifest.formulas?.length ?? 0,
    imageCount: result.assets.filter(asset => asset.kind !== 'formula').length,
  } : scope.section;
  const fragment = selected.fragment;
  if (typeof fragment !== 'string' || !(/<(?:img|math|table|hr)\b/i.test(fragment) || fragment.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|#160);/g, ' ').trim())) {
    throw new Error('此栏目没有正文内容，请检查 Word。');
  }
  const metadata = Object.fromEntries(Object.keys(selected).filter(key => key !== 'fragment' && key !== 'preview').map(key => [key, selected[key]]));
  return { ...metadata, fragment: rewriteImages(fragment, sources) };
}

function mapExport(result, mode = 'embedded', urls = {}) {
  if (!['embedded', 'mapped'].includes(mode)) throw new Error('未知的图片导出方式。');
  if (mode === 'embedded') return { fragment: result.fragment, preview: result.preview, manifest: result.manifest, sections: result.sections };
  const sources = sourceMappings(result, urls);
  return {
    fragment: rewriteImages(result.fragment, sources),
    // Previews retain embedded originals so their image CSP remains valid and
    // opening a downloaded preview never requests the supplied school URLs.
    preview: result.preview,
    sections: result.sections.map(section => ({ ...section, fragment: rewriteImages(section.fragment, sources) })),
    manifest: { ...result.manifest, options: { ...result.manifest.options, imageMode: 'mapped' }, verification: 'unverified',
      warnings: [...(result.manifest.warnings || []), '已使用提供的学校图片地址；未请求这些地址，仍需学校保存后回读验证。'] },
  };
}

function mathMlProbe() {
  return [
    '<p>COMPAT-PROBE-MATHML · 仅用于可删除的测试草稿</p>',
    '<h2>H2-标题测试</h2>',
    '<p>P-正文 <strong>STRONG-加粗</strong> <em>EM-斜体</em> X<sub>SUB-下标</sub> X<sup>SUP-上标</sup><br>BR-换行</p>',
    '<p style="font-family:Arial,sans-serif;font-size:16px;line-height:1.8;text-align:center;margin:8px 0;color:#234567">STYLE-字号行距居中颜色</p>',
    '<table style="border-collapse:collapse;width:100%;border-top:1px solid #000;border-bottom:1px solid #000"><tbody><tr><th>TH-表头</th><th>TH-值</th></tr><tr><td colspan="2" style="padding:6px;text-align:center">TD-COLSPAN-合并单元格</td></tr></tbody></table>',
    '<p>MATHML-原生数学 <math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup><mo>-</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow><annotation encoding="application/x-tex">x_i^2-\\frac{1}{2}</annotation></semantics></math></p>',
    '<p style="text-align:center">MATHML-独立公式 <math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><msub><mi>x</mi><mi>i</mi></msub></mrow></math></p>',
    '<p>UPLOADED-普通图片请另用学校插图按钮插入一张测试图片，保存后重新打开并检查源码。</p>',
    '<p>END-PROBE-请保存测试草稿，离开页面，再重新打开后复制 HTML 源码。</p>',
  ].join('\n');
}

function validateResult(result) {
  if (!result || typeof result.fragment !== 'string' || typeof result.preview !== 'string' || !plainObject(result.manifest) || !Array.isArray(result.assets)) {
    throw new Error('浏览器转换结果无效。');
  }
  const filenames = new Set();
  const assets = result.assets.map(asset => {
    if (!asset || typeof asset.filename !== 'string' || !asset.filename || /[\/\\\u0000-\u001f\u007f]/.test(asset.filename) ||
      ['.', '..'].includes(asset.filename) || filenames.has(asset.filename) || typeof asset.mime !== 'string') throw new Error('图片文件清单无效，请重新转换。');
    filenames.add(asset.filename);
    return { ...asset, data: bytes(asset.data) };
  });
  if (result.sections !== undefined && !Array.isArray(result.sections)) throw new Error('栏目信息无效，请重新转换。');
  return { ...result, assets, sections: result.sections || [] };
}

async function exportZip(result, exported, mode, reportProgress) {
  const zip = new JSZip();
  zip.file('fragment.html', exported.fragment);
  zip.file('preview.html', exported.preview);
  zip.file('manifest.json', JSON.stringify(exported.manifest, null, 2));
  const index = [];
  const ids = new Set();
  for (const section of exported.sections) {
    if (!/^[a-z][a-z0-9-]*$/.test(section.id) || ids.has(section.id)) throw new Error('导出栏目标识无效或重复，请重新转换。');
    ids.add(section.id);
    const fragmentFile = `sections/${section.id}.html`;
    zip.file(fragmentFile, section.fragment);
    const previewFile = section.preview === undefined ? undefined : `sections/${section.id}-preview.html`;
    if (previewFile) zip.file(previewFile, section.preview);
    index.push({ id: section.id, title: section.title, kind: section.kind, sourceHeading: section.sourceHeading,
      fragmentFile, ...(previewFile ? { previewFile } : {}), assetFilenames: section.assetFilenames,
      formulaCount: section.formulaCount, imageCount: section.imageCount,
      destination: section.kind === 'field' ? `学校“${section.title}”编辑框` : '待确认归属，不直接粘贴到已知栏目' });
  }
  if (index.length) zip.file('sections/index.json', JSON.stringify(index, null, 2));
  const instructions = [
    index.length ? 'sections/index.json 列出各栏目。将 kind 为 field 的栏目 HTML 正文分别复制到学校对应编辑框的源码模式；待分配内容请先确认归属。整篇 fragment.html 保留所有内容，preview.html 仅供本地核对。' : 'fragment.html 保留整篇内容，请核对学校各栏目后自行分配。preview.html 仅供本地预览。',
    mode === 'mapped' ? '正文图片已替换为所提供的学校地址，并保留宽高。预览继续使用本地嵌入原图，不请求学校图片地址。工具未请求这些地址。' : result.assets.length ? '正文含嵌入图片时仅供本地预览。下载上传用图片，按编号通过学校插图工具上传；粘贴学校源码识别地址，确认对应关系后导出替换地址的正文。' : '此包不含图片，确认栏目归属后可复制正文。',
    '公式使用原生 MathML，无需上传公式图片；当前文档仍需在学校保存、重新打开后检查公式、正文、表格与图片。',
    '普通表格默认三线表；公式编号表格保持无边框。请检查实际学校保存效果。',
    '文档、学校源码和图片地址仅在此浏览器内处理。工具没有上传图片、保存学校草稿或提交申报。',
  ];
  zip.file('使用说明.txt', instructions.join('\n') + '\n');
  for (const asset of result.assets) zip.file(`assets/${asset.filename}`, asset.data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }, metadata => reportProgress?.({ stage: 'export', percent: metadata.percent }));
}

/** Fetch-compatible local routes. Only the bundled synthetic example may use fetch. */
export function createBrowserApi({ convert, onProgress, demoUrl, progressDemoUrl } = {}) {
  if (typeof convert !== 'function') throw new Error('需要浏览器本地转换函数。');
  const origin = new URL(globalThis.location?.href || 'http://browser.local/').origin;
  const jobs = new Map();
  let converting = false;
  let disposed = false;
  const demoPromises = new Map();
  const reportProgress = event => { try { onProgress?.(event); } catch { /* Progress observers do not affect data processing. */ } };

  function releaseJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    for (const url of job.urls.values()) URL.revokeObjectURL(url);
    clearTimeout(job.expiry);
    jobs.delete(id);
  }

  function prune() {
    for (const [id, job] of jobs) if (Date.now() - job.time >= JOB_TTL) releaseJob(id);
  }

  function remember(result) {
    prune();
    while (jobs.size >= 3) releaseJob(jobs.keys().next().value);
    const id = crypto.randomUUID();
    const urls = new Map();
    for (const asset of result.assets) urls.set(asset.filename, URL.createObjectURL(new Blob([asset.data], { type: asset.mime })));
    const expiry = setTimeout(() => releaseJob(id), JOB_TTL);
    expiry.unref?.();
    jobs.set(id, { result, time: Date.now(), urls, expiry });
    return id;
  }

  function getJob(id) {
    prune();
    const job = jobs.get(id);
    if (!job) {
      const error = new Error('本地转换结果已过期，请重新转换。');
      error.code = 'JOB_EXPIRED';
      throw error;
    }
    return job;
  }

  function assetUrl(jobId, filename) { return getJob(jobId).urls.get(filename) || ''; }

  function summaries(result, id) {
    const digits = Math.max(2, String(result.assets.length).length);
    return result.assets.map(({ filename, mime, kind, width, height }, offset) => ({ filename, mime, kind, width, height,
      uploadFilename: `${String(offset + 1).padStart(digits, '0')}-${filename}`,
      ...(id ? { previewUrl: assetUrl(id, filename) } : {}) }));
  }

  async function request(input, init = {}) {
    try {
      if (disposed) throw new Error('本地处理已关闭，请刷新页面。');
      prune();
      const isRequest = input instanceof Request;
      const url = new URL(isRequest ? input.url : String(input), `${origin}/`);
      if (url.origin !== origin) throw new Error('本地处理不支持外部请求。');
      const method = String(init.method || (isRequest ? input.method : 'GET')).toUpperCase();
      const signal = init.signal ?? (isRequest ? input.signal : undefined);
      signal?.throwIfAborted();
      if (method === 'GET' && url.pathname === '/api/probe') return reply(200, { fragment: mathMlProbe() });
      if (method === 'GET' && url.pathname === '/api/demo-docx') {
        const documentType = validateDocumentType(url.searchParams.get('documentType') ?? 'application');
        const selectedUrl = documentType === 'progress' ? progressDemoUrl : demoUrl;
        if (!selectedUrl) throw new Error(documentType === 'progress' ? '进展检查合成示例未配置。' : '合成示例未配置。');
        const example = new URL(selectedUrl, globalThis.location?.href || `${origin}/`);
        if (example.origin !== origin || !['http:', 'https:'].includes(example.protocol)) throw new Error('合成示例必须来自当前网站的静态文件。');
        if (!demoPromises.has(documentType)) demoPromises.set(documentType, (async () => {
          const response = await fetch(example.href, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
          if (!response.ok) throw new Error('示例读取失败。');
          if (Number(response.headers.get('Content-Length')) > MAX_DOCUMENT_BYTES) throw new Error('示例文件超过 20 MB。');
          const data = new Uint8Array(await response.arrayBuffer());
          if (data.byteLength > MAX_DOCUMENT_BYTES) throw new Error('示例文件超过 20 MB。');
          return data;
        })());
        let data;
        try { data = await demoPromises.get(documentType); }
        catch (error) { demoPromises.delete(documentType); throw error; }
        signal?.throwIfAborted();
        return reply(200, data, CONTENT_TYPE_DOCX, { 'Content-Disposition': `attachment; filename="${documentType === 'progress' ? 'progress-demo.docx' : 'demo.docx'}"` });
      }
      if (method === 'POST' && url.pathname === '/api/compare') {
        const data = await readJson(input, init, 2 * 1024 * 1024, '源码对比请求过大，最多 2 MB。');
        if (!plainObject(data)) throw new Error('请提供保存前和重新打开后的两份 HTML 源码。');
        return reply(200, compareFragments(data.before, data.after));
      }
      if (method === 'POST' && url.pathname === '/api/convert') {
        if (converting) return reply(409, { error: '正在转换另一个文档，请稍后再试。' });
        converting = true;
        try {
          const documentType = validateDocumentType(url.searchParams.get('documentType') ?? 'application');
          const fontMode = url.searchParams.get('fontMode') ?? 'uniform';
          const fontSize = Number(url.searchParams.get('fontSize') || 16);
          const scale = Number(url.searchParams.get('scale') || 3);
          const formulaFormat = url.searchParams.get('formulaFormat') || 'mathml';
          if (!['word', 'uniform'].includes(fontMode)) throw new Error('字号模式应为 word 或 uniform。');
          if (![14, 16, 18, 20].includes(fontSize) || ![2, 3, 4].includes(scale)) throw new Error('字号或清晰度选项无效。');
          if (formulaFormat !== 'mathml') throw new Error('浏览器本地转换仅支持原生 MathML 公式。');
          const document = await readBody(input, init, MAX_DOCUMENT_BYTES);
          if (!document.byteLength) throw new Error('请选择一个 .docx 文件。');
          signal?.throwIfAborted();
          reportProgress({ stage: 'convert', percent: 0, message: '正在本地转换正文和公式…' });
          const result = validateResult(await convert(document, { documentType, fontMode, fontSize, scale, formulaFormat: 'mathml' }));
          signal?.throwIfAborted();
          if (disposed) throw new Error('本地处理已关闭，请刷新页面。');
          const jobId = remember(result);
          reportProgress({ stage: 'convert', percent: 100, message: '本地转换完成。' });
          return reply(200, { jobId, fragment: result.fragment, preview: result.preview, manifest: result.manifest,
            assets: summaries(result, jobId), sections: result.sections });
        } finally { converting = false; }
      }
      const importMatch = url.pathname.match(/^\/api\/import-images\/([^/]+)$/);
      if (method === 'POST' && importMatch) {
        const { result } = getJob(importMatch[1]);
        const data = await readJson(input, init, 4 * 1024 * 1024, '图片源码请求过大，最多 4 MB。');
        if (!plainObject(data) || typeof data.html !== 'string') throw new Error('请提供含 HTML 源码的图片地址请求。');
        if (encoder.encode(data.html).byteLength > 2 * 1024 * 1024) throw new Error('图片 HTML 源码过大，最多 2 MB。');
        if (data.pageUrl !== undefined && typeof data.pageUrl !== 'string') throw new Error('学校页面地址应为 HTTP(S) 地址文本。');
        const scope = resolveImageScope(result, data.sectionId);
        const names = new Set(scope.assetFilenames);
        const assets = summaries(result).filter(asset => names.has(asset.filename));
        return reply(200, { ...importImageUrls(data.html, assets, { pageUrl: data.pageUrl }), sectionId: scope.id, assetFilenames: scope.assetFilenames });
      }
      const uploadMatch = url.pathname.match(/^\/api\/upload-images\/([^/]+)$/);
      if (method === 'GET' && uploadMatch) {
        const { result } = getJob(uploadMatch[1]);
        const scope = resolveImageScope(result, url.searchParams.has('sectionId') ? url.searchParams.get('sectionId') : undefined);
        if (!scope.assets.length) throw new Error('当前栏目不含图片，无需上传。');
        const names = new Set(scope.assetFilenames);
        const assets = summaries(result).filter(asset => names.has(asset.filename));
        const byFilename = new Map(scope.assets.map(asset => [asset.filename, asset]));
        const zip = new JSZip();
        assets.forEach(asset => zip.file(asset.uploadFilename, byFilename.get(asset.filename).data));
        zip.file('上传顺序.txt', '请按文件名前的编号逐张通过学校编辑器的插图工具上传。上传后复制含图片的学校 HTML 源码，粘贴回本工具识别地址，并核对图片顺序。\n工具没有上传图片、保存草稿或提交申报。\n\n' + assets.map(asset => asset.uploadFilename).join('\n') + '\n');
        return reply(200, await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), 'application/zip', { 'Content-Disposition': 'attachment; filename="upload-images.zip"' });
      }
      const assetMatch = url.pathname.match(/^\/api\/assets\/([a-f\d-]{36})\/([^/]+)$/);
      if (method === 'GET' && assetMatch) {
        const { result } = getJob(assetMatch[1]);
        const asset = result.assets.find(item => item.filename === decodeURIComponent(assetMatch[2]));
        return asset ? reply(200, asset.data, asset.mime) : reply(404, { error: '图片不存在。' });
      }
      const exportMatch = url.pathname.match(/^\/api\/export\/([a-f\d-]{36})$/);
      if (method === 'POST' && exportMatch) {
        const options = await readJson(input, init, 1024 * 1024, '导出选项请求过大，最多 1 MB。');
        if (!plainObject(options) || (options.urls !== undefined && !plainObject(options.urls))) throw new Error('图片导出选项无效。');
        if (options.format !== undefined && (options.format !== 'json' || options.mode !== 'mapped')) throw new Error('图片导出格式无效；json 格式仅用于已映射图片地址的 mapped 模式。');
        if (options.sectionId !== undefined && (typeof options.sectionId !== 'string' || options.format !== 'json' || options.mode !== 'mapped')) throw new Error('栏目复制选项无效；仅支持 mapped json 格式的栏目或整篇正文。');
        const { result } = getJob(exportMatch[1]);
        if (options.sectionId !== undefined) return reply(200, { section: mapSectionCopy(result, options.sectionId, options.urls) });
        const exported = mapExport(result, options.mode, options.urls);
        if (options.format === 'json') return reply(200, { fragment: exported.fragment, manifest: exported.manifest, sections: exported.sections });
        const archive = await exportZip(result, exported, options.mode || 'embedded', reportProgress);
        signal?.throwIfAborted();
        return reply(200, archive, 'application/zip', { 'Content-Disposition': 'attachment; filename="campus-html.zip"' });
      }
      return reply(404, { error: '本地操作不存在。' });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      return reply(error.code === 'JOB_EXPIRED' ? 410 : 400, { error: error.message || '本地处理未完成。', ...(error.code === 'JOB_EXPIRED' ? { code: error.code } : {}) });
    }
  }

  function clearJobs() { for (const id of [...jobs.keys()]) releaseJob(id); }
  function dispose() { clearJobs(); demoPromises.clear(); disposed = true; }
  return { request, assetUrl, clearJobs, dispose };
}
