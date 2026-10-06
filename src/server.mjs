import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import JSZip from 'jszip';
import { convertDocx } from './convert.mjs';
import { makeDemoDocx } from './fixtures.mjs';
import { compareFragments, createProbe, safeImageUrl } from './probe.mjs';
import { importImageUrls } from './image-import.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 20 * 1024 * 1024;
const jobs = new Map();
let converting = false;
let probe;

function reply(response, status, data, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  response.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function body(request, max = MAX_BODY, tooLarge = '请求过大。Word 文件最多 20 MB。') {
  const chunks = [];
  let length = 0;
  if (Number(request.headers['content-length']) > max) throw new Error(tooLarge);
  for await (const chunk of request) {
    length += chunk.length;
    if (length > max) throw new Error(tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function assetSummaries(result) {
  const digits = Math.max(2, String(result.assets.length).length);
  return result.assets.map(({ filename, mime, kind, width, height }, index) => ({
    filename, mime, kind, width, height,
    uploadFilename: `${String(index + 1).padStart(digits, '0')}-${filename}`,
  }));
}

function remember(result) {
  const id = randomUUID();
  while (jobs.size >= 3) jobs.delete(jobs.keys().next().value);
  jobs.set(id, { result, time: Date.now() });
  return id;
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job || Date.now() - job.time > 30 * 60 * 1000) {
    const error = new Error('本地转换结果已过期，请重新转换。');
    error.code = 'JOB_EXPIRED';
    throw error;
  }
  return job.result;
}

function imageSourceMappings(result, urls) {
  const sources = new Map();
  const mappedUrls = new Map();
  for (const asset of result.assets) {
    if (!urls[asset.filename]) throw new Error(`请先填写图片地址：${asset.filename}`);
    const imageUrl = safeImageUrl(urls[asset.filename]);
    if (mappedUrls.has(imageUrl)) throw new Error(`图片地址重复：${mappedUrls.get(imageUrl)} 与 ${asset.filename} 对应同一个学校图片地址，请检查图片对应关系。`);
    mappedUrls.set(imageUrl, asset.filename);
    sources.set(`data:${asset.mime};base64,${asset.data.toString('base64')}`, imageUrl);
  }
  return sources;
}

function rewriteImageSources(html, sources) {
  if (!/<img\b/i.test(html)) return html;
  const $ = load(html, null, html.trimStart().startsWith('<!DOCTYPE') || html.includes('<html'));
  $('img').each((_, el) => {
    const source = $(el).attr('src');
    if (!sources.has(source)) throw new Error('导出图片与资产清单不一致，请重新转换。');
    $(el).attr('src', sources.get(source));
  });
  return $.html();
}

/** Map the selected section or complete body requested for copying, without previews. */
export function mapSectionCopy(result, sectionId, urls = {}) {
  if (typeof sectionId !== 'string' || !sectionId) throw new Error('复制栏目标识无效，请重新选择学校栏目。');
  // A scoped copy uses the same complete mapping validation as a full export.
  const sources = imageSourceMappings(result, urls);
  const sections = result.sections || [];
  const selected = sectionId === 'whole' ? {
      id: 'whole', title: '整篇文档', kind: 'whole', fragment: result.fragment,
      assetFilenames: result.assets.map(asset => asset.filename),
      formulaCount: result.manifest.formulas?.length ?? 0,
      imageCount: result.assets.filter(asset => asset.kind !== 'formula').length,
    } : sections.find(section => section.id === sectionId && ['field', 'unassigned'].includes(section.kind));
  if (!selected) throw new Error('该内容不是可复制的正文，请重新选择。');
  const fragment = selected.fragment;
  if (typeof fragment !== 'string' || !(/<(?:img|math|table|hr)\b/i.test(fragment)
    || fragment.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|#160);/g, ' ').trim())) {
    throw new Error('此栏目没有正文内容，请检查 Word。');
  }
  const metadata = Object.fromEntries(Object.keys(selected).filter(key => key !== 'fragment' && key !== 'preview').map(key => [key, selected[key]]));
  return { ...metadata, fragment: rewriteImageSources(fragment, sources) };
}

export function mapExport(result, mode = 'embedded', urls = {}) {
  if (!['embedded', 'mapped'].includes(mode)) throw new Error('未知的图片导出方式。');
  const sections = result.sections || [];
  if (mode === 'embedded') return { fragment: result.fragment, preview: result.preview, manifest: result.manifest, sections };
  const sources = imageSourceMappings(result, urls);
  const rewrite = html => rewriteImageSources(html, sources);
  return {
    fragment: rewrite(result.fragment),
    preview: rewrite(result.preview),
    sections: sections.map(section => ({
      ...section,
      fragment: rewrite(section.fragment),
      ...(section.preview === undefined ? {} : { preview: rewrite(section.preview) }),
    })),
    manifest: { ...result.manifest, options: { ...result.manifest.options, imageMode: 'mapped' }, verification: 'unverified', warnings: [...result.manifest.warnings, '已使用提供的学校图片地址；未请求这些地址，仍需学校保存后回读验证。'] },
  };
}

export function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const authority = request.headers.host;
      if (!authority || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(authority)) return reply(response, 403, { error: '仅允许本机访问。' });
      if (request.headers.origin && ![`http://${authority}`, `https://${authority}`].includes(request.headers.origin)) return reply(response, 403, { error: '请求来源不匹配。' });
      const url = new URL(request.url, `http://${authority}`);
      if (request.method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'GET' && ['/', '/app.js', '/image-mapping.js', '/image-order.js', '/job-recovery.js', '/section-view.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
        return reply(response, 200, await readFile(`${publicRoot}${name}`), type);
      }
      if (request.method === 'GET' && url.pathname === '/api/demo-docx') {
        response.setHeader('Content-Disposition', 'attachment; filename="demo.docx"');
        return reply(response, 200, await makeDemoDocx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      }
      if (request.method === 'GET' && url.pathname === '/api/probe') {
        probe ??= createProbe();
        return reply(response, 200, { fragment: await probe });
      }
      if (request.method === 'POST' && url.pathname === '/api/compare') {
        const data = JSON.parse((await body(request, 2 * 1024 * 1024)).toString());
        return reply(response, 200, compareFragments(data.before, data.after));
      }
      if (request.method === 'POST' && url.pathname === '/api/convert') {
        if (converting) return reply(response, 409, { error: '正在转换另一个文档，请稍后再试。' });
        converting = true;
        try {
          const fontMode = url.searchParams.get('fontMode') ?? 'uniform';
          if (!['word', 'uniform'].includes(fontMode)) throw new Error('字号模式应为 word 或 uniform。');
          const input = await body(request);
          if (!input.length) throw new Error('请选择一个 .docx 文件。');
          const fontSize = Number(url.searchParams.get('fontSize') || 16);
          const scale = Number(url.searchParams.get('scale') || 3);
          const formulaFormat = url.searchParams.get('formulaFormat') || 'png';
          if (![14, 16, 18, 20].includes(fontSize) || ![2, 3, 4].includes(scale)) throw new Error('字号或清晰度选项无效。');
          if (!['mathml', 'png'].includes(formulaFormat)) throw new Error('公式输出应为 mathml 或 png。');
          const result = await convertDocx(input, { fontMode, fontSize, scale, imageMode: 'embedded', formulaFormat });
          const jobId = remember(result);
          return reply(response, 200, { jobId, fragment: result.fragment, preview: result.preview, manifest: result.manifest, assets: assetSummaries(result), sections: result.sections || [] });
        } finally { converting = false; }
      }
      const importMatch = url.pathname.match(/^\/api\/import-images\/([^/]+)$/);
      if (request.method === 'POST' && importMatch) {
        const result = getJob(importMatch[1]);
        let data;
        try { data = JSON.parse((await body(request, 4 * 1024 * 1024, '图片源码请求过大，最多 4 MB。')).toString()); }
        catch (error) {
          if (error instanceof SyntaxError) throw new Error('图片源码请求格式无效，请提供 HTML 源码。');
          throw error;
        }
        if (!data || Array.isArray(data) || typeof data !== 'object' || typeof data.html !== 'string') throw new Error('请提供含 HTML 源码的图片地址请求。');
        if (Buffer.byteLength(data.html, 'utf8') > 2 * 1024 * 1024) throw new Error('图片 HTML 源码过大，最多 2 MB。');
        if (data.pageUrl !== undefined && typeof data.pageUrl !== 'string') throw new Error('学校页面地址应为 HTTP(S) 地址文本。');
        return reply(response, 200, importImageUrls(data.html, assetSummaries(result), { pageUrl: data.pageUrl }));
      }
      const uploadMatch = url.pathname.match(/^\/api\/upload-images\/([^/]+)$/);
      if (request.method === 'GET' && uploadMatch) {
        const result = getJob(uploadMatch[1]);
        if (!result.assets.length) throw new Error('当前转换结果不含图片，无需上传。');
        const summaries = assetSummaries(result);
        const zip = new JSZip();
        result.assets.forEach((asset, index) => zip.file(summaries[index].uploadFilename, asset.data));
        zip.file('上传顺序.txt', '请按文件名开头的编号逐张通过学校编辑器的“插入图片”上传。上传后从源码模式一次复制包含这些图片的 HTML，粘贴到本工具的图片地址识别区。\n实际学校上传后的排列顺序仍需检查；本工具没有上传图片、保存草稿或提交申报。若学校改变文件名，核对预览顺序后再确认地址对应关系。\n\n' + summaries.map(asset => asset.uploadFilename).join('\n') + '\n');
        response.setHeader('Content-Disposition', 'attachment; filename="upload-images.zip"');
        return reply(response, 200, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'application/zip');
      }
      const assetMatch = url.pathname.match(/^\/api\/assets\/([a-f\d-]{36})\/([^/]+)$/);
      if (request.method === 'GET' && assetMatch) {
        const asset = getJob(assetMatch[1]).assets.find(item => item.filename === decodeURIComponent(assetMatch[2]));
        if (!asset) return reply(response, 404, { error: '图片不存在。' });
        return reply(response, 200, asset.data, asset.mime);
      }
      const exportMatch = url.pathname.match(/^\/api\/export\/([a-f\d-]{36})$/);
      if (request.method === 'POST' && exportMatch) {
        const options = JSON.parse((await body(request, 1024 * 1024)).toString());
        if (!options || Array.isArray(options) || typeof options !== 'object' || options.urls !== undefined && (!options.urls || Array.isArray(options.urls) || typeof options.urls !== 'object')) throw new Error('图片导出选项无效。');
        if (options.format !== undefined && (options.format !== 'json' || options.mode !== 'mapped')) throw new Error('图片导出格式无效；json 格式仅用于已映射图片地址的 mapped 模式。');
        if (options.sectionId !== undefined && (typeof options.sectionId !== 'string' || options.format !== 'json' || options.mode !== 'mapped')) throw new Error('栏目复制选项无效；仅支持 mapped json 格式的栏目或整篇正文。');
        const result = getJob(exportMatch[1]);
        if (options.sectionId !== undefined) return reply(response, 200, { section: mapSectionCopy(result, options.sectionId, options.urls) });
        const exported = mapExport(result, options.mode, options.urls);
        if (options.format === 'json') return reply(response, 200, { fragment: exported.fragment, manifest: exported.manifest, sections: exported.sections });
        const zip = new JSZip();
        zip.file('fragment.html', exported.fragment);
        zip.file('preview.html', exported.preview);
        zip.file('manifest.json', JSON.stringify(exported.manifest, null, 2));
        const sectionIndex = [];
        const sectionIds = new Set();
        for (const section of exported.sections) {
          if (!/^[a-z][a-z0-9-]*$/.test(section.id) || sectionIds.has(section.id)) throw new Error('导出栏目标识无效或重复，请重新转换。');
          sectionIds.add(section.id);
          const fragmentFile = `sections/${section.id}.html`;
          zip.file(fragmentFile, section.fragment);
          const previewFile = section.preview === undefined ? undefined : `sections/${section.id}-preview.html`;
          if (previewFile) zip.file(previewFile, section.preview);
          sectionIndex.push({
            id: section.id, title: section.title, kind: section.kind, sourceHeading: section.sourceHeading,
            fragmentFile, ...(previewFile ? { previewFile } : {}),
            assetFilenames: section.assetFilenames, formulaCount: section.formulaCount, imageCount: section.imageCount,
            destination: section.kind === 'field' ? `学校“${section.title}”编辑框` : '待确认归属，不直接粘贴到已知栏目',
          });
        }
        if (sectionIndex.length) zip.file('sections/index.json', JSON.stringify(sectionIndex, null, 2));
        const nativeMath = result.manifest.options?.formulaFormat === 'mathml';
        const copyInstructions = sectionIndex.length
          ? '已按申报栏目分别导出正文。请先查看 sections/index.json，将 kind 为 field 的栏目 HTML 分别复制到对应学校编辑框；蓝色栏目名称由学校自动显示，片段不重复包含该外层标题。kind 为 unassigned 的内容需确认归属后再使用。不要将根目录 fragment.html 的整篇内容粘贴到单个栏目，也不要复制预览文件。\n'
          : '当前文档未能确定申报栏目。根目录 fragment.html 保留整篇内容，请核对学校各编辑框后自行分配，不能将整篇直接粘贴到单个栏目；preview.html 仅供本地预览。\n';
        const exportInstructions = options.mode === 'mapped'
          ? '本包为已替换图片地址的 HTML。正文片段使用所提供的绝对 HTTP(S) 图片地址，保留导出宽高；这些地址应来自学校插图功能实际上传的图片，不能编造地址或上传记录。\n'
          : result.assets.length
            ? '本包为图片与本地预览。fragment.html 含嵌入图片时仅供本地预览，不能直接粘贴到华中农大当前“进展检查”编辑器；该前端会替换 data URI 图片。可在工具中下载“上传用图片”，按编号逐张通过学校插图功能上传；然后一次复制学校编辑器中包含图片的 HTML 源码，粘贴回工具识别地址，再导出映射版本。学校改名时需核对图片顺序后确认，仍可逐张手动填写实际 URL。实际学校上传顺序尚未验证。\n'
            : '本包不含图片。确认归属的栏目正文可以复制到学校对应编辑框的源码模式；preview.html 是本地预览。\n';
        const formulaInstructions = nativeMath
          ? '公式使用原生 MathML，无需上传公式图片，兼容减号已处理。此前合成样例已通过华中农大“进展检查”暂存回读；此文档尚未完成学校保存回读，不能据此保证所有公式或正式提交后的呈现。\n'
          : '公式使用图片。当前“进展检查”前端会清除图片行内样式，将显示宽高写入属性；vertical-align 基线样式会丢失，行内公式对齐尚未解决。\n';
        zip.file('使用说明.txt', copyInstructions + exportInstructions + formulaInstructions + '普通表格默认三线表；公式编号表格保持无边框。三线表边框的学校保存效果尚未验证。\n当前文档仍需在可删除的测试草稿中保存并重新打开，检查公式、正文、表格及普通图片。工具没有执行学校保存或提交。不要将正式材料用于兼容性测试。\n');
        for (const asset of result.assets) zip.file(`assets/${asset.filename}`, asset.data);
        response.setHeader('Content-Disposition', 'attachment; filename="campus-html.zip"');
        return reply(response, 200, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'application/zip');
      }
      return reply(response, 404, { error: '页面不存在。' });
    } catch (error) {
      return reply(response, error.code === 'JOB_EXPIRED' ? 410 : 400, { error: error.message || '转换未完成。', ...(error.code === 'JOB_EXPIRED' ? { code: error.code } : {}) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4317);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Word → HTML: http://127.0.0.1:${port}\nDocuments are processed locally. Each document needs a school save-and-reopen check.`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
