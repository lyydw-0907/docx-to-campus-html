import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { load } from 'cheerio';
import sharp from 'sharp';
import { renderFormula } from './math.mjs';
import { extractMathMLBatch, sanitizeMathML } from './mathml.mjs';
import { formatThreeLineTables } from './tables.mjs';
import { analyzeEquationParagraph, analyzeStandaloneMathParagraph, cleanIncompleteEquationMarker } from './equations.mjs';
import { extractOMMLLayout, applyOMMLLimits, applyOMMLLimitCommands } from './omml-layout.mjs';
import { prepareWordFormatting, restoreWordFormatting } from './word-format.mjs';
import { splitCampusSections } from './sections.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const INPUT_LIMIT = 20 * 1024 * 1024;
const EXPANDED_LIMIT = 100 * 1024 * 1024;
const ENTRY_LIMIT = 32 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_FORMULAS = 1000;
const MAX_IMAGES = 500;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
const digest = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);
const cssNumber = (number) => Number(number.toFixed(3)).toString();

/** Check declared ZIP sizes before any decompression. ZIP64 and multi-disk archives are unnecessary for DOCX. */
function validateZip(input) {
  if (!Buffer.isBuffer(input) || !input.length) throw new Error('请提供非空的 DOCX 文件。');
  if (input.length > INPUT_LIMIT) throw new Error('DOCX 超过 20 MB 输入限制。');
  let end = -1;
  for (let offset = input.length - 22; offset >= Math.max(0, input.length - 65557); offset--) {
    if (input.readUInt32LE(offset) === 0x06054b50 && offset + 22 + input.readUInt16LE(offset + 20) === input.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('文件不是受支持的 DOCX（ZIP 文件结构无效）。');
  const entries = input.readUInt16LE(end + 10);
  const centralSize = input.readUInt32LE(end + 12);
  const centralOffset = input.readUInt32LE(end + 16);
  if (input.readUInt16LE(end + 4) || input.readUInt16LE(end + 6) || input.readUInt16LE(end + 8) !== entries || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('不支持多卷或 ZIP64 格式的 DOCX。');
  if (!entries || entries > MAX_ENTRIES || centralOffset + centralSize > end) throw new Error('DOCX 文件条目过多或目录结构无效。');
  const names = new Set();
  const compressedEntries = [];
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > centralOffset + centralSize || input.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCX ZIP 目录损坏。');
    const compressed = input.readUInt32LE(cursor + 20);
    const expanded = input.readUInt32LE(cursor + 24);
    const nameLength = input.readUInt16LE(cursor + 28);
    const extraLength = input.readUInt16LE(cursor + 30);
    const commentLength = input.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new Error('DOCX ZIP 目录损坏。');
    const name = input.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!name || name.startsWith('/') || /[\\:\u0000]/.test(name) || name.split('/').includes('..') || names.has(name)) throw new Error('DOCX 含不安全或重复的文件路径。');
    if (input.readUInt16LE(cursor + 8) & 1) throw new Error('请先解除 Word 文件的密码保护。');
    const method = input.readUInt16LE(cursor + 10);
    if (method !== 0 && method !== 8) throw new Error('DOCX 使用了不支持的压缩方式。');
    total += expanded;
    if (expanded > ENTRY_LIMIT || total > EXPANDED_LIMIT || expanded > Math.max(compressed, 1) * 1000) throw new Error('DOCX 解压体积或压缩比超过安全限制。');
    const localOffset = input.readUInt32LE(cursor + 42);
    if (localOffset + 30 > centralOffset || input.readUInt32LE(localOffset) !== 0x04034b50 || input.readUInt16LE(localOffset + 8) !== method) throw new Error('DOCX 本地文件结构无效。');
    const localNameLength = input.readUInt16LE(localOffset + 26);
    const dataOffset = localOffset + 30 + localNameLength + input.readUInt16LE(localOffset + 28);
    if (dataOffset + compressed > centralOffset) throw new Error('DOCX 压缩数据范围无效。');
    if (input.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8') !== name) throw new Error('DOCX 本地路径与 ZIP 目录不一致。');
    compressedEntries.push({ method, expanded, dataOffset, compressed });
    names.add(name);
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('DOCX ZIP 目录长度无效。');
  // Central-directory sizes can be forged. Enforce the limit in the inflater too,
  // before JSZip's CRC check or Pandoc can expand any archive entry.
  for (const entry of compressedEntries) {
    const compressed = input.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
    let actual;
    try { actual = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded) }); }
    catch { throw new Error('DOCX 压缩数据损坏，或实际解压尺寸超过声明值。'); }
    if (actual.length !== entry.expanded) throw new Error('DOCX 实际解压尺寸与 ZIP 声明不一致。');
  }
  return { entries, expandedBytes: total };
}

async function inspectDocx(input, warnings) {
  const archiveInfo = validateZip(input);
  const zip = await JSZip.loadAsync(input, { checkCRC32: true });
  if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) throw new Error('文件缺少 Word 文档结构，请使用 .docx 格式。');
  let sourceFormulaCount = 0;
  let omittedFormulaCount = 0;
  let noteFormulaCount = 0;
  let documentLayout = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/\.(?:xml|rels)$/i.test(entry.name)) continue;
    const content = await entry.async('string');
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content)) throw new Error('DOCX 含不受支持的 XML 实体或 DTD。');
    if (/\.rels$/i.test(entry.name)) {
      const $ = load(content, { xmlMode: true });
      $('*').each((_, element) => {
        const attributes = element.attribs ?? {};
        if (String(attributes.TargetMode).toLowerCase() === 'external' && !String(attributes.Type).endsWith('/hyperlink')) {
          throw new Error('DOCX 含外部图片或外部资源。请先在 Word 中嵌入资源；转换器不会联网下载。');
        }
      });
    }
    const count = (content.match(/<(?:[\w.-]+:)?oMath(?=[\s>])/g) ?? []).length;
    if (entry.name === 'word/document.xml') documentLayout = extractOMMLLayout(content);
    if (/^word\/(?:footnotes|endnotes)\.xml$/.test(entry.name)) noteFormulaCount += count;
    if (/^word\/(?:document|footnotes|endnotes)\.xml$/.test(entry.name)) sourceFormulaCount += count;
    else omittedFormulaCount += count;
  }
  if (sourceFormulaCount > MAX_FORMULAS) throw new Error('原生公式超过 1000 个，请分段转换。');
  if (omittedFormulaCount) warnings.push(`页眉、页脚等非正文部件包含 ${omittedFormulaCount} 个原生公式；本原型只转换正文及被引用的脚注、尾注。`);
  return { ...archiveInfo, sourceFormulaCount, omittedFormulaCount, noteFormulaCount, documentLayout };
}

export async function resolvePandocPath(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.PANDOC_PATH) return process.env.PANDOC_PATH;
  const local = path.join(PROJECT_ROOT, 'tools', 'pandoc', process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
  try { await access(local); return local; } catch { return 'pandoc'; }
}

function runPandoc(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let size = 0;
    let errorSize = 0;
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Pandoc 转换超过 60 秒，请缩小文档后重试。')); }, 60_000);
    child.stdout.on('data', (data) => {
      size += data.length;
      if (size > MAX_OUTPUT) { child.kill(); finish(new Error('转换结果超过 32 MB 限制。')); }
      else chunks.push(data);
    });
    child.stderr.on('data', (data) => { if (errorSize < 1024 * 1024) { errors.push(data); errorSize += data.length; } });
    child.on('error', (error) => finish(new Error(error.code === 'ENOENT' ? '未找到 Pandoc。请运行 npm run setup:pandoc，或配置 PANDOC_PATH。' : `Pandoc 启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`Pandoc 转换失败（${code}）：${Buffer.concat(errors).toString('utf8').slice(0, 1200)}`));
      else finish(null, { stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function countMath(node) {
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countMath(item), 0);
  if (!node || typeof node !== 'object') return 0;
  if (node.t === 'Math') return 1;
  return Object.values(node).reduce((sum, item) => sum + countMath(item), 0);
}

function collectMathNodes(node, result = []) {
  if (Array.isArray(node)) for (const item of node) collectMathNodes(item, result);
  else if (node && typeof node === 'object') {
    if (node.t === 'Math') result.push(node);
    else for (const item of Object.values(node)) collectMathNodes(item, result);
  }
  return result;
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  if (node.t === 'Str') return node.c;
  if (['Space', 'SoftBreak', 'LineBreak'].includes(node.t)) return ' ';
  if (['Strong', 'Emph', 'Superscript', 'Subscript', 'Strikeout', 'SmallCaps'].includes(node.t)) return textOf(node.c);
  return '';
}

function lengthInPixels(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(px|pt|in|cm|mm)?$/.exec(String(value));
  if (!match) return null;
  const factors = { px: 1, pt: 96 / 72, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };
  const size = Number(match[1]) * (factors[match[2] ?? 'px']);
  return size > 0 && size <= 10000 ? size : null;
}

function mappedSource(filename, mapping) {
  const value = mapping?.[filename];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少图片 ${filename} 的校内 URL 映射。请先通过学校编辑器上传全部资产。`);
  if (value.length > 4096 || /[\s\u0000-\u001f]/.test(value)) throw new Error(`图片 ${filename} 的 URL 无效。`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`图片 ${filename} 需要完整的 HTTP(S) URL。`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`图片 ${filename} 只接受不含账号密码的 HTTP(S) URL。`);
  return parsed.href;
}

const ALLOWED_TAGS = new Set('div p h1 h2 h3 h4 h5 h6 span strong b em i u sup sub s del br hr table caption colgroup col thead tbody tfoot tr th td ul ol li blockquote a figure figcaption'.split(' '));
const FORBIDDEN_TAGS = new Set('script style iframe object embed svg math form input button textarea select link meta base video audio source canvas'.split(' '));
const CSS_RULES = {
  'font-size': /^(?:\d+(?:\.\d+)?)(?:px|pt|em|%)$/,
  'font-weight': /^(?:normal|bold|[1-9]00)$/,
  'font-style': /^(?:normal|italic)$/,
  'font-family': /^[\w\u3400-\u9fff ,"'-]{1,120}$/,
  color: /^(?:#[0-9a-f]{3,8}|black|white|red|blue|gray)$/i,
  'background-color': /^(?:#[0-9a-f]{3,8}|transparent|white)$/i,
  'text-align': /^(?:left|right|center|justify)$/,
  'text-indent': /^-?\d+(?:\.\d+)?(?:px|pt|em)$/,
  'margin-left': /^(?:auto|-?\d+(?:\.\d+)?(?:px|pt|em))$/,
  'margin-right': /^(?:auto|-?\d+(?:\.\d+)?(?:px|pt|em))$/,
  'margin-top': /^\d+(?:\.\d+)?(?:px|em)$/,
  'margin-bottom': /^\d+(?:\.\d+)?(?:px|em)$/,
  'list-style-position': /^(?:outside|inside)$/,
  'list-style-type': /^(?:decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|disc|circle|square)$/,
  'vertical-align': /^(?:baseline|middle|top|bottom|text-bottom|-?\d+(?:\.\d+)?px)$/,
  'line-height': /^(?:\d+(?:\.\d+)?(?:px|em|%)?|normal)$/,
  width: /^(?:\d+(?:\.\d+)?(?:px|%)|auto)$/,
  height: /^(?:\d+(?:\.\d+)?px|auto)$/,
  'max-width': /^(?:\d+(?:\.\d+)?(?:px|%)|none)$/,
  margin: /^-?\d+(?:\.\d+)?(?:px|em|%|)?(?: +-?\d+(?:\.\d+)?(?:px|em|%|)?){0,3}$/,
  padding: /^\d+(?:\.\d+)?(?:px|em)(?: +\d+(?:\.\d+)?(?:px|em|)?){0,3}$/,
  border: /^(?:0|none|[012](?:\.\d+)?px solid #[0-9a-f]{3,6})$/i,
  'border-top': /^(?:0|none|[012](?:\.\d+)?px solid #[0-9a-f]{3,6})$/i,
  'border-right': /^(?:0|none|[012](?:\.\d+)?px solid #[0-9a-f]{3,6})$/i,
  'border-bottom': /^(?:0|none|[012](?:\.\d+)?px solid #[0-9a-f]{3,6})$/i,
  'border-left': /^(?:0|none|[012](?:\.\d+)?px solid #[0-9a-f]{3,6})$/i,
  'border-collapse': /^(?:collapse|separate)$/,
  'table-layout': /^(?:auto|fixed)$/,
  display: /^(?:inline|inline-block|block)$/,
  'white-space': /^(?:normal|nowrap)$/,
  'text-decoration': /^(?:none|underline|line-through)$/,
};

function cleanStyle(style) {
  const entries = new Map();
  for (const declaration of String(style ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (CSS_RULES[key]?.test(value)) entries.set(key, value);
  }
  return entries;
}

/** Native list markers already supply the list's left and hanging indentation. */
export function normalizeListParagraphStyles(blocks, paragraphStyles) {
  function visit(value, directListParagraph = false) {
    if (Array.isArray(value)) { for (const child of value) visit(child, directListParagraph); return; }
    if (!value || typeof value !== 'object') return;
    if (value.t === 'OrderedList' || value.t === 'BulletList') {
      const items = value.t === 'OrderedList' ? value.c[1] : value.c;
      for (const item of items) visit(item, true);
      return;
    }
    // Divs can wrap list paragraphs; blockquotes, tables and notes own their layout.
    if (value.t === 'Div') { visit(value.c[1], directListParagraph); return; }
    if (directListParagraph && ['Para', 'Plain'].includes(value.t) && paragraphStyles.has(value)) {
      const styles = cleanStyle(paragraphStyles.get(value));
      styles.delete('text-indent');
      styles.delete('margin-left');
      paragraphStyles.set(value, [...styles].map(([key, setting]) => `${key}:${setting}`).join(';'));
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(blocks);
}

/** Defense in depth: only converter-owned image sources survive, and styles/attributes are allowlisted. */
export function sanitizeHtml(html, { fontSize = 16, allowedImageSources = [], allowMathML = false, mathMLFormulas } = {}) {
  const $ = load(html, {}, false);
  const allowedImages = new Set(allowedImageSources);
  const equationTables = new Set($('table[data-campus-equation="true"]').toArray());
  const horizontalRuleTables = new Set($('table[data-campus-word-horizontal="true"]').toArray());
  const paragraphLayouts = new Map($('div[data-campus-paragraph-layout="true"]').toArray().flatMap(div => $(div).children('p').toArray().map(p => [p, cleanStyle($(div).attr('style'))])));
  $('table[data-campus-word-columns]').each((_, table) => {
    const widths = $(table).attr('data-campus-word-columns').split(',');
    const columns = $(table).children('colgroup').children('col');
    if (widths.length === columns.length && widths.every(value => /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= 100)) columns.each((index, col) => $(col).attr('style', `width:${widths[index]}%`));
  });
  if (allowMathML) {
    if (mathMLFormulas && $('math').length !== mathMLFormulas.length) throw new Error('HTML 写出后的原生公式数量不一致。');
    $('math').each((index, element) => {
      const cleaned = sanitizeMathML($.html(element), { fontSize: mathMLFormulas?.[index]?.fontSize ?? fontSize, display: $(element).attr('display') === 'block', expectedTex: mathMLFormulas?.[index]?.tex });
      $(element).replaceWith(cleaned.html);
    });
  }
  $('table[data-campus-equation="true"]').find('td,th').attr('data-campus-equation-cell', 'true');
  $('*').each((_, element) => {
    const tag = element.name.toLowerCase();
    const node = $(element);
    if (allowMathML && node.closest('math').length) return;
    if (FORBIDDEN_TAGS.has(tag)) { node.remove(); return; }
    if (tag !== 'img' && !ALLOWED_TAGS.has(tag)) { node.replaceWith(node.contents()); return; }
    const attributes = { ...element.attribs };
    const styles = cleanStyle(attributes.style);
    for (const key of Object.keys(element.attribs)) node.removeAttr(key);
    if (tag === 'img') {
      if (!allowedImages.has(attributes.src)) { node.remove(); return; }
      node.attr('src', attributes.src);
      node.attr('alt', String(attributes.alt ?? '').slice(0, 12000));
      for (const dimension of ['width', 'height']) {
        const size = Number(attributes[dimension]);
        if (Number.isFinite(size) && size > 0 && size <= 10000) node.attr(dimension, cssNumber(size));
        else { node.remove(); return; }
      }
    }
    if (tag === 'a' && attributes.href) {
      try {
        const url = new URL(attributes.href);
        if (['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) node.attr('href', url.href);
      } catch { if (/^#[\w-]+$/.test(attributes.href)) node.attr('href', attributes.href); }
    }
    if (tag === 'ol' || tag === 'ul') {
      // This is the only left-indent layer: do not stack Word paragraph indents.
      styles.set('margin', '8px 0px');
      styles.set('padding', '0px 0px 0px 2em');
      styles.set('text-indent', '0px');
      styles.set('list-style-position', 'outside');
      if (tag === 'ol') {
        const start = Number(attributes.start);
        if (/^-?\d+$/.test(attributes.start ?? '') && Number.isSafeInteger(start)) node.attr('start', String(start));
        if (/^[1aAiI]$/.test(attributes.type ?? '')) node.attr('type', attributes.type);
      }
    }
    if (tag === 'li') styles.set('text-indent', '0px');
    if (['td', 'th'].includes(tag)) {
      for (const name of ['colspan', 'rowspan']) {
        const count = Number(attributes[name]);
        if (Number.isInteger(count) && count > 1 && count <= 1000) node.attr(name, String(count));
      }
      if (!styles.has('text-align') && /^(left|center|right)$/.test(attributes.align ?? '')) styles.set('text-align', attributes.align);
      if (!styles.has('border')) styles.set('border', attributes['data-campus-equation-cell'] ? '0' : '1px solid #444');
      if (!styles.has('padding')) styles.set('padding', attributes['data-campus-equation-cell'] ? '0px' : '6px');
      if (!styles.has('vertical-align')) styles.set('vertical-align', 'middle');
      if (attributes['data-campus-equation-cell'] && /^(?:10|80)%$/.test(attributes.width ?? '')) node.attr('width', attributes.width);
    }
    if (tag === 'table') {
      if (!styles.has('border-collapse')) styles.set('border-collapse', 'collapse');
      if (!styles.has('width')) styles.set('width', '100%');
    }
    if (tag === 'p') {
      const layout = paragraphLayouts.get(element);
      if (layout) {
        styles.set('margin', '0px');
        styles.set('line-height', layout.get('line-height') || 'normal');
      } else {
        if (!styles.has('margin')) styles.set('margin', '0px 0px 8px');
        if (!styles.has('line-height')) styles.set('line-height', '1.5');
      }
    }
    if (/^h[1-6]$/.test(tag)) {
      if (!styles.has('font-size')) styles.set('font-size', `${cssNumber(fontSize * ({ h1: 1.5, h2: 1.25, h3: 1.125 }[tag] ?? 1))}px`);
      if (!styles.has('margin')) styles.set('margin', '16px 0px 8px');
    }
    if (styles.size) node.attr('style', [...styles].map(([key, value]) => `${key}:${value}`).join(';'));
  });
  function removeComments(element) {
    for (const child of [...(element.children ?? [])]) {
      if (child.type === 'comment') $(child).remove();
      else removeComments(child);
    }
  }
  removeComments($.root()[0]);
  formatThreeLineTables($, { excludedTables: equationTables, horizontalRuleTables });
  return $.root().html();
}

function previewDocument(fragment, imageMode, formulaFormat, hasImages) {
  const mode = { embedded: '嵌入图片（data URI）', files: '本地 assets 文件', mapped: '校内图片 URL' }[imageMode];
  const imagePolicy = imageMode === 'files' ? "'self' file: data: http: https:" : 'data: http: https:';
  const formulaNotice = formulaFormat === 'mathml' ? '原生公式（MathML）：合成样例已完成学校暂存回读验证；当前文档仍未验证。' : '公式图片：学校前端会清除图片基线样式，行内对齐尚未解决。';
  const imageNotice = hasImages ? `图片模式：${mode}；需通过学校插图功能上传并映射真实地址，上传与保存效果未验证。` : '此结果没有图片资产。';
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imagePolicy}; style-src 'unsafe-inline'"><title>DOCX 转换本地预览</title><style>body{max-width:860px;margin:32px auto;padding:0 20px;font-family:Arial,'Microsoft YaHei',sans-serif;color:#222}aside{font-size:14px;line-height:1.6;background:#f5f5f2;padding:16px;margin-bottom:24px;border:1px solid #deded8}img{max-width:100%}table{max-width:100%}</style></head><body><aside><strong>本地预览 · 当前文档学校保存效果未验证</strong><br>${formulaNotice}<br>${imageNotice}<br>当前文档仍需在华中农业大学大创系统保存并重新打开后检查。</aside>${fragment}</body></html>`;
}

/** Convert native OMML through Pandoc's mathematical AST and render the resulting TeX as real assets. */
export async function convertDocx(input, options = {}) {
  const fontSize = Number(options.fontSize ?? 16);
  const scale = Number(options.scale ?? 3);
  const formulaFormat = options.formulaFormat ?? 'png';
  const imageMode = options.imageMode ?? 'embedded';
  const fontMode = options.fontMode ?? 'uniform';
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48) throw new Error('正文字号应在 8–48 px 之间。');
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error('公式清晰度倍数应在 1–4 之间。');
  if (!['png', 'svg', 'mathml'].includes(formulaFormat)) throw new Error('公式格式只能为 png、svg 或 mathml。');
  if (!['embedded', 'files', 'mapped'].includes(imageMode)) throw new Error('图片模式应为 embedded、files 或 mapped。');
  if (!['word', 'uniform'].includes(fontMode)) throw new Error('字号模式应为 word 或 uniform。');
  const warnings = [];
  const source = await inspectDocx(input, warnings);
  const temp = await mkdtemp(path.join(tmpdir(), 'docx-campus-'));
  const mediaRoot = path.join(temp, 'media');
  const assets = [];
  const formulas = [];
  const sources = new Set();
  const byFilename = new Map();
  const formulaCache = new Map();
  let imageCount = 0;
  let totalAssetBytes = 0;
  const deadline = Date.now() + 120_000;
  try {
    const inputFile = path.join(temp, 'input.docx');
    const prepared = await prepareWordFormatting(input, { fontMode, fontSize });
    await writeFile(inputFile, prepared.input);
    const pandoc = await resolvePandocPath(options.pandocPath);
    const read = await runPandoc(pandoc, ['--from=docx+styles', '--to=json', `--extract-media=${mediaRoot}`, inputFile]);
    if (read.stderr.trim() && /\b(?:OMML|math|mathematical|TeX|equation)\b/i.test(read.stderr)) throw new Error(`Pandoc 报告公式读取问题，已停止导出：${read.stderr.trim().slice(0, 1200)}`);
    if (read.stderr.trim()) warnings.push(`Pandoc 读取提示：${read.stderr.trim().slice(0, 2000)}`);
    const ast = JSON.parse(read.stdout);
    const formatting = restoreWordFormatting(ast, prepared);
    normalizeListParagraphStyles(ast.blocks, formatting.paragraphStyles);
    warnings.push(...formatting.warnings);
    const formulaFontSize = node => formatting.mathFontSizes.get(node) ?? fontSize;
    const astFormulaCount = countMath(ast.blocks);
    if (astFormulaCount !== source.sourceFormulaCount) throw new Error(`原生公式数量不一致：Word 正文/脚注中有 ${source.sourceFormulaCount} 个，Pandoc 读取到 ${astFormulaCount} 个。已停止导出，避免漏公式。`);
    const mathNodes = collectMathNodes(ast.blocks);
    const sourceLayouts = new Map();
    if (!source.noteFormulaCount && source.documentLayout.length === mathNodes.length) {
      mathNodes.forEach((node, index) => sourceLayouts.set(node, source.documentLayout[index]));
    } else if (source.documentLayout.some(layout => layout.naries.some(nary => nary.limitLocation))) {
      warnings.push('正文与脚注数学节点无法按顺序确认对应，未恢复原 Word 的显式运算符上下限位置。');
    }
    const equationPlans = new Map();
    const centeredMathParagraphs = new Set();
    function planEquations(node) {
      if (Array.isArray(node)) { for (const item of node) planEquations(item); return; }
      if (!node || typeof node !== 'object') return;
      if (node.t === 'Para' || node.t === 'Plain') {
        const plan = analyzeEquationParagraph(node.c);
        if (plan) equationPlans.set(plan.math, plan);
        else if (analyzeStandaloneMathParagraph(node.c)) centeredMathParagraphs.add(node);
      }
      for (const value of Object.values(node)) planEquations(value);
    }
    planEquations(ast.blocks);
    const markerCleanups = new Map();
    if (options.removeIncompleteNumberMarkers !== false) {
      mathNodes.forEach((node, index) => {
        if (equationPlans.has(node)) return;
        const cleanup = cleanIncompleteEquationMarker(node.c[1], sourceLayouts.get(node));
        if (cleanup) {
          markerCleanups.set(node, cleanup);
          warnings.push(`第 ${index + 1} 个公式的单行 Word 方程数组末尾只有孤立 #；导出已去掉该排版标记，未添加编号。原始 TeX 记录保留。`);
        }
      });
    }
    const nativeMath = new Map();
    if (formulaFormat === 'mathml' && astFormulaCount) {
      const nodes = mathNodes;
      const descriptors = nodes.map((node) => ({ tex: equationPlans.get(node)?.renderTex ?? markerCleanups.get(node)?.renderTex ?? node.c[1], display: equationPlans.get(node)?.display ?? node.c[0].t === 'DisplayMath', fontSize: formulaFontSize(node) }));
      if (descriptors.some(({ tex }) => typeof tex !== 'string' || !tex.trim() || tex.length > 20_000)) throw new Error('原生公式为空或超过 20000 字符限制。');
      const batch = { 'pandoc-api-version': ast['pandoc-api-version'], meta: {}, blocks: descriptors.map(({ tex, display }) => ({ t: 'Para', c: [{ t: 'Math', c: [{ t: display ? 'DisplayMath' : 'InlineMath' }, tex] }] })) };
      const rendered = await runPandoc(pandoc, ['--from=json', '--to=html5', '--mathml', '--wrap=none'], JSON.stringify(batch));
      if (rendered.stderr.trim()) throw new Error(`Pandoc 报告 MathML 写出问题，已停止导出：${rendered.stderr.trim().slice(0, 1200)}`);
      const cleaned = extractMathMLBatch(rendered.stdout, descriptors, { fontSize });
      nodes.forEach((node, index) => {
        const layout = sourceLayouts.get(node);
        if (layout) {
          const adjusted = applyOMMLLimits(cleaned[index].html, layout);
          cleaned[index].html = adjusted.html;
          cleaned[index].sourceLayoutChanges = adjusted.changes;
          for (const warning of adjusted.warnings) warnings.push(`第 ${index + 1} 个公式：${warning}`);
        }
        // Keep the original source annotation while rendering only the equation body.
        if (descriptors[index].tex !== node.c[1]) {
          const $ = load(cleaned[index].html, { xmlMode: true }, false);
          $('annotation[encoding="application/x-tex"]').text(node.c[1]);
          cleaned[index].html = $.xml($('math')[0]);
        }
        nativeMath.set(node, cleaned[index]);
      });
    }

    function addAsset(asset) {
      const existing = byFilename.get(asset.filename);
      if (existing) return existing;
      totalAssetBytes += asset.data.length;
      const assetLimit = imageMode === 'embedded' ? 24 * 1024 * 1024 : 64 * 1024 * 1024;
      if (totalAssetBytes > assetLimit) throw new Error('生成的图片资产超过输出体积限制，请分段转换或降低公式清晰度倍数。');
      let src;
      if (imageMode === 'embedded') src = `data:${asset.mime};base64,${asset.data.toString('base64')}`;
      else if (imageMode === 'files') src = `assets/${asset.filename}`;
      else src = mappedSource(asset.filename, options.assetUrls);
      const stored = { ...asset, src };
      byFilename.set(asset.filename, stored);
      assets.push(stored);
      sources.add(src);
      return stored;
    }

    function imgHtml(asset, alt, depth = 0) {
      const width = cssNumber(asset.width);
      const height = cssNumber(asset.height);
      return `<img src="${escapeHtml(asset.src)}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" style="width:${width}px;height:${height}px;vertical-align:${cssNumber(-depth)}px;display:inline-block">`;
    }

    async function formulaHtml(node) {
      const formulaSize = formulaFontSize(node);
      const plan = equationPlans.get(node);
      const display = plan?.display ?? node.c[0].t === 'DisplayMath';
      const tex = node.c[1];
      const cleanup = markerCleanups.get(node);
      let renderTex = plan?.renderTex ?? cleanup?.renderTex ?? tex;
      let sourceLayoutChanges = [];
      if (formulaFormat !== 'mathml' && sourceLayouts.has(node)) {
        const adjusted = applyOMMLLimitCommands(renderTex, sourceLayouts.get(node));
        renderTex = adjusted.tex;
        sourceLayoutChanges = adjusted.changes;
        for (const warning of adjusted.warnings) warnings.push(`第 ${formulas.length + 1} 个公式：${warning}`);
      }
      const numbering = plan?.number ? { number: plan.number, ...(plan.markerSource ? { numberSource: plan.markerSource, renderTex, sourceDisplay: node.c[0].t === 'DisplayMath', ...(plan.wrapperRemoved ? { wrapperRemoved: plan.wrapperRemoved } : {}) } : {}) } : {};
      const renderingChanges = { ...(renderTex !== tex ? { renderTex } : {}), ...(cleanup ? { markerCleanup: cleanup.kind, wrapperRemoved: cleanup.wrapperRemoved } : {}) };
      if (!plan?.markerSource && !cleanup && /(?:\\#|＃)/.test(tex)) warnings.push(`第 ${formulas.length + 1} 个公式含未处理的 # 标记；已保留原数学内容。若它用于编号，请对照 Word 检查完整标签及位置。`);
      if (formulaFormat === 'mathml') {
        const rendered = nativeMath.get(node);
        if (!rendered) throw new Error('原生公式批量写出结果与文档节点不一致。');
        formulas.push({ index: formulas.length + 1, tex, display, fontSize: formulaSize, format: 'mathml', compatibilityChanges: rendered.compatibilityChanges, sourceLayoutChanges: rendered.sourceLayoutChanges ?? [], ...renderingChanges, ...numbering });
        return rendered.html;
      }
      const cacheKey = JSON.stringify([renderTex, display, formulaSize, scale, formulaFormat]);
      let rendered = formulaCache.get(cacheKey);
      if (!rendered) {
        let result;
        try { result = await renderFormula(renderTex, { display, fontSize: formulaSize, scale, format: formulaFormat }); }
        catch (error) { throw new Error(`第 ${formulas.length + 1} 个公式渲染失败：${error.message}`); }
        if (!Buffer.isBuffer(result.data) || !(result.width > 0) || !(result.height > 0) || !Number.isFinite(result.depth) || result.width > 10000 || result.height > 10000) throw new Error('公式渲染返回了无效的尺寸或图片。');
        const asset = addAsset({ filename: `formula-${digest(cacheKey)}.${result.extension}`, mime: result.mime, data: result.data, kind: 'formula', width: result.width, height: result.height });
        rendered = { asset, depth: result.depth };
        formulaCache.set(cacheKey, rendered);
      }
      const index = formulas.length + 1;
      formulas.push({ index, filename: rendered.asset.filename, tex, display, fontSize: formulaSize, width: rendered.asset.width, height: rendered.asset.height, depth: rendered.depth, sourceLayoutChanges, ...renderingChanges, ...numbering });
      return imgHtml(rendered.asset, tex, rendered.depth);
    }

    async function imageHtml(node) {
      if (++imageCount > MAX_IMAGES) throw new Error('图片超过 500 张，请分段转换。');
      const target = node.c[2][0];
      const candidate = path.resolve(target);
      const actual = await realpath(candidate).catch(() => { throw new Error('文档图片未能提取。请检查图片是否已嵌入 Word。'); });
      const root = await realpath(mediaRoot);
      const relative = path.relative(root, actual);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('图片路径超出本次转换的隔离目录。');
      const data = await readFile(actual);
      if (data.length > ENTRY_LIMIT) throw new Error('单张图片超过 32 MB 限制。');
      if (/\.(?:emf|wmf)$/i.test(actual)) throw new Error(`不支持文档图片格式 ${path.extname(actual)}；请先在 Word 中转为 PNG 或 JPEG，避免导出缺图。`);
      let metadata;
      try { metadata = await sharp(data, { limitInputPixels: 40_000_000 }).metadata(); } catch { throw new Error(`无法读取图片 ${path.basename(actual)}。请先在 Word 中转为 PNG 或 JPEG。`); }
      const format = metadata.format;
      if (!['png', 'jpeg', 'gif', 'webp'].includes(format)) throw new Error(`不支持文档图片格式 ${format ?? path.extname(actual)}；请先转为 PNG 或 JPEG，避免导出缺图。`);
      if (!(metadata.width > 0) || !(metadata.height > 0) || metadata.width * metadata.height > 40_000_000) throw new Error('图片像素数量超过 4000 万限制。');
      const attributes = Object.fromEntries(node.c[0][2]);
      const rotated = [5, 6, 7, 8].includes(metadata.orientation);
      const naturalWidth = rotated ? metadata.height : metadata.width;
      const naturalHeight = rotated ? metadata.width : metadata.height;
      const specifiedWidth = lengthInPixels(attributes.width);
      const specifiedHeight = lengthInPixels(attributes.height);
      const width = specifiedWidth ?? (specifiedHeight ? specifiedHeight * naturalWidth / naturalHeight : naturalWidth);
      const height = specifiedHeight ?? (specifiedWidth ? specifiedWidth * naturalHeight / naturalWidth : naturalHeight);
      if (width > 10000 || height > 10000) throw new Error('文档图片显示尺寸超过限制。');
      if (format === 'webp') warnings.push('文档含 WebP 图片；学校支持情况尚未验证，可在 Word 中转为 PNG 或 JPEG。');
      const extension = format === 'jpeg' ? 'jpg' : format;
      const mime = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
      const asset = addAsset({ filename: `image-${digest(data)}.${extension}`, mime, data, kind: 'image', width, height });
      return imgHtml({ ...asset, width, height }, textOf(node.c[1]) || node.c[2][1] || 'Word 图片');
    }

    async function transform(node) {
      if (Date.now() > deadline) throw new Error('文档转换超过 120 秒，请分段转换。');
      if (Array.isArray(node)) {
        const result = [];
        for (const item of node) result.push(await transform(item));
        return result;
      }
      if (!node || typeof node !== 'object') return node;
      if (node.t === 'Math') return { t: 'RawInline', c: ['html', await formulaHtml(node)] };
      if (node.t === 'Image') return { t: 'RawInline', c: ['html', await imageHtml(node)] };
      if (node.t === 'RawInline' || node.t === 'RawBlock') {
        warnings.push('已移除文档中的原始 HTML，防止脚本或不安全标签进入输出。');
        return { t: node.t, c: ['html', ''] };
      }
      if (node.t === 'Para' || node.t === 'Plain') {
        const math = node.c.find((item) => item.t === 'Math');
        const plan = math && equationPlans.get(math);
        if (plan) {
          const number = plan.number;
          const formula = await formulaHtml(math);
          const sizeStyle = `font-size:${cssNumber(formulaFontSize(math))}px`;
          const paragraphLayout = formatting.paragraphLayouts.get(node);
          const spacingStyle = paragraphLayout ? `margin:0px;${paragraphLayout}` : 'margin:8px 0px';
          const layout = number
            ? `<table data-campus-equation="true" style="width:100%;border:0;border-collapse:collapse;table-layout:fixed;${spacingStyle};${sizeStyle}"><tbody><tr><td width="10%" style="width:10%;border:0;padding:0px;vertical-align:middle"></td><td width="80%" style="width:80%;text-align:center;border:0;padding:0px;vertical-align:middle">${formula}</td><td width="10%" style="width:10%;text-align:right;white-space:nowrap;border:0;padding:0px;vertical-align:middle">${escapeHtml(number)}</td></tr></tbody></table>`
            : `<p style="text-align:center;${spacingStyle};${sizeStyle}">${formula}</p>`;
          return { t: 'RawBlock', c: ['html', layout] };
        }
      }
      const result = {};
      for (const [key, value] of Object.entries(node)) result[key] = await transform(value);
      let paragraphStyle = formatting.paragraphStyles.get(node);
      if (centeredMathParagraphs.has(node)) {
        // Word often centers a lone inline formula using a fixed character
        // indent. Center the paragraph at the available width instead, while
        // leaving every original inline and the math display mode intact.
        const centered = cleanStyle(paragraphStyle);
        for (const [name, value] of [['text-align', 'center'], ['text-indent', '0px'], ['margin-left', '0px'], ['margin-right', '0px']]) centered.set(name, value);
        paragraphStyle = [...centered].map(([name, value]) => `${name}:${value}`).join(';');
      }
      const paragraphLayout = formatting.paragraphLayouts.get(node);
      if ((paragraphStyle || paragraphLayout) && ['Para', 'Plain'].includes(node.t)) return { t: 'Div', c: [['', [], [['style', [paragraphStyle, paragraphLayout].filter(Boolean).join(';')], ...(paragraphLayout ? [['data-campus-paragraph-layout', 'true']] : [])]], [result]] };
      return result;
    }
    ast.blocks = await transform(ast.blocks);
    // Metadata does not belong to the school's editable body.
    ast.meta = {};
    const write = await runPandoc(pandoc, ['--from=json', '--to=html5', '--wrap=none'], JSON.stringify(ast));
    if (write.stderr.trim()) warnings.push(`Pandoc 写出提示：${write.stderr.trim().slice(0, 2000)}`);
    const body = sanitizeHtml(write.stdout, { fontSize, allowedImageSources: sources, allowMathML: formulaFormat === 'mathml', mathMLFormulas: formulaFormat === 'mathml' ? formulas : undefined });
    if (formulaFormat === 'mathml' && load(body, {}, false)('math').length !== formulas.length) throw new Error('HTML 清理后的原生公式数量不一致，已停止导出。');
    const fragment = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;font-size:${cssNumber(fontSize)}px;line-height:1.5;color:#111">\n${body}\n</div>`;
    const split = splitCampusSections(fragment, { assets });
    const sections = split.sections.map(section => ({ ...section,
      preview: previewDocument(section.fragment, imageMode, formulaFormat, section.assetFilenames.length > 0) }));
    warnings.push(...split.warnings);
    if (assets.length && imageMode === 'embedded') warnings.push('华中农大当前进展检查前端拒绝 data URI 图片；此嵌入版本仅供本地预览。请上传 assets 中的图片并使用真实 URL 映射，上传与保存效果尚未验证。');
    if (assets.length && imageMode === 'files') warnings.push('assets/ 相对路径仅供本地预览；粘贴到学校系统不会上传这些文件。');
    if (formulaFormat === 'svg' && formulas.length) warnings.push('学校系统对 SVG 上传和保存的支持尚未验证；默认图片格式优先使用 PNG。');
    if (formulaFormat === 'mathml' && formulas.length) warnings.push('原生 MathML 与右侧编号的合成样例已完成学校暂存回读验证；当前文档和其他页面仍未验证。兼容减号仅规范数学运算符，原始 TeX 注释保留。');
    if (formulaFormat !== 'mathml' && formulas.length) warnings.push('学校前端会清除公式图片的行内基线样式；PNG/SVG 图片上传与保存回读尚未验证，行内对齐尚未解决。');
    const manifest = {
      schemaVersion: 1,
      verification: 'unverified',
      source: { bytes: input.length, zipEntries: source.entries, expandedBytes: source.expandedBytes, nativeFormulaCount: source.sourceFormulaCount, omittedPartFormulaCount: source.omittedFormulaCount },
      options: { fontSize, fontMode, scale, formulaFormat, imageMode, tableStyle: 'three-line', removeIncompleteNumberMarkers: options.removeIncompleteNumberMarkers !== false },
      formatting: formatting.summary,
      sectioning: { fields: sections.filter(section => section.kind === 'field').length,
        unassigned: sections.filter(section => section.kind === 'unassigned').length },
      formulas,
      assets: assets.map(({ filename, mime, kind, width, height, data }) => ({ filename, mime, kind, width, height, bytes: data.length })),
      warnings: [...new Set(warnings)],
      notes: [formulaFormat === 'mathml' ? '公式采用浏览器原生 MathML；不生成数学图片，不需要 MathJax 或 KaTeX。' : '公式宽高和基线为逻辑 CSS 像素；PNG 使用更高像素密度渲染。', '普通表格默认三线表：顶线、表头下线和底线；没有明确表头时按第一行处理。', '保留文档中已有的简单公式编号，包括可确认的独立公式及单行方程数组末端 #(数字) 标记；不自动添加编号，采用左右等宽 10%、中央 80% 的固定无边框表格。', '原始 TeX 保留在清单和 MathML 注释中；renderTex 记录渲染正文，sourceLayoutChanges 记录准确匹配的原 OMML 运算符限位恢复。无法确认的限位保持原输出并提示。', '仅对源确认的单行 Word 方程数组中句号后的孤立 # 清理排版残留，记录 markerCleanup，不新增编号；可通过 removeIncompleteNumberMarkers:false 保留。', 'Word 任意页面布局与文本框不能保证复现；当前文档始终未完成学校保存验证。'],
    };
    return { fragment, preview: previewDocument(fragment, imageMode, formulaFormat, assets.length > 0), sections, assets: assets.map(({ src, ...asset }) => asset), manifest };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
