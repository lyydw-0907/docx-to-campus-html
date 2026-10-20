// This module only reads converter-owned preview HTML and manifest metadata.
// Inspection markup is a separate document: it never annotates exported HTML.
const INSPECTION_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const CSP_PREFIX = `<meta http-equiv="Content-Security-Policy" content="${INSPECTION_CSP}">`;
const BLOCKED_ELEMENTS = new Set('script iframe frame frameset object embed base link video audio source track form input button select textarea'.split(' '));

function manifestProblem(formulas) {
  if (!Array.isArray(formulas) || !formulas.length) return '当前文档没有可检查的公式清单。';
  for (let position = 0; position < formulas.length; position++) {
    const formula = formulas[position];
    if (!formula || typeof formula !== 'object' || Array.isArray(formula)
      || formula.index !== position + 1 || typeof formula.tex !== 'string' || !formula.tex.length) {
      return '公式清单的编号、顺序或原始 TeX 不完整，无法确认公式位置。';
    }
  }
  return '';
}

/**
 * A warning becomes an action only for one canonical, 1-based global reference.
 * Exact duplicate messages are omitted, preserving their first occurrence.
 * Malformed non-string warning entries are ignored; messages stay plain strings.
 */
export function collectFormulaWarnings(result) {
  const actionable = [];
  const general = [];
  const formulas = result?.manifest?.formulas;
  const validManifest = !manifestProblem(formulas);
  const warnings = result?.manifest?.warnings;
  const seen = new Set();
  for (const message of Array.isArray(warnings) ? warnings : []) {
    if (typeof message !== 'string' || !message.trim() || seen.has(message)) continue;
    seen.add(message);
    const references = [...message.matchAll(/第\s*([^，。；：！？,\n;:!?]*?)\s*(?:个\s*)?公式/g)];
    const reference = references.length === 1 ? references[0][1].trim() : '';
    const index = /^[1-9]\d*$/.test(reference) ? Number(reference) : NaN;
    if (validManifest && Number.isSafeInteger(index) && index <= formulas.length) actionable.push({ message, index });
    else general.push(message);
  }
  return { actionable, general };
}

function elements(parent, tag = '*') {
  return Array.from(parent.getElementsByTagName(tag));
}

function browserParseDocument(source) {
  if (typeof globalThis.DOMParser !== 'function' || !globalThis.document?.createElement) throw new Error('当前环境不支持本地预览解析。');
  // Template contents remain inert, including images. Remove resource URLs
  // before DOMParser can construct image/iframe nodes in a detached document.
  const template = globalThis.document.createElement('template');
  template.innerHTML = source;
  removeActiveContent(Array.from(template.content.querySelectorAll('*')));
  return new globalThis.DOMParser().parseFromString(CSP_PREFIX + template.innerHTML, 'text/html');
}

function exactMathTarget(document, formulas, index) {
  const math = elements(document, 'math');
  if (math.length !== formulas.length) return { reason: '原始预览中的 MathML 数量与公式清单不同，无法确认公式位置。' };
  for (let position = 0; position < math.length; position++) {
    const annotations = elements(math[position], 'annotation').filter(node => node.getAttribute('encoding')?.toLowerCase() === 'application/x-tex');
    // HTML parsing normalizes line endings, while the manifest keeps raw TeX.
    if (annotations.length !== 1 || annotations[0].textContent !== formulas[position].tex.replace(/\r\n?/g, '\n')) {
      return { reason: '原始预览中的 MathML 原始 TeX 或文档顺序与公式清单不同，无法确认公式位置。' };
    }
  }
  return { target: math[index - 1] };
}

function cssDimension(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10000
    ? Number(value.toFixed(3)) : null;
}

function imageMatches(image, formula) {
  const width = cssDimension(formula.width);
  const height = cssDimension(formula.height);
  return width !== null && height !== null && image.getAttribute('alt') === formula.tex
    && Number(image.getAttribute('width')) === width && Number(image.getAttribute('height')) === height;
}

function exactPngTarget(document, formulas, index) {
  if (elements(document, 'math').length) return { reason: '原始预览的公式格式与 PNG 公式清单不同，无法确认公式位置。' };
  if (formulas.some(formula => cssDimension(formula.width) === null || cssDimension(formula.height) === null)) {
    return { reason: '公式清单缺少可确认的图片尺寸，无法确认 PNG 公式位置。' };
  }
  // Use occurrences, not unique filenames/sources: identical formulas reuse assets.
  const candidates = elements(document, 'img').filter(image => formulas.some(formula => imageMatches(image, formula)));
  if (candidates.length !== formulas.length || candidates.some((image, position) => !imageMatches(image, formulas[position]))) {
    return { reason: '原始预览中的公式图片描述或顺序不能唯一对应公式清单，无法确认 PNG 公式位置。' };
  }
  return { target: candidates[index - 1] };
}

function localImage(source) {
  return typeof source === 'string' && !/[\s\u0000-\u001f\u007f]/.test(source)
    && (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/]+=*$/i.test(source) || /^blob:[^\s]+$/i.test(source));
}

function removeActiveContent(nodes) {
  for (const element of nodes) {
    const name = (element.localName || element.tagName || '').toLowerCase();
    if (BLOCKED_ELEMENTS.has(name) || (name === 'meta' && element.getAttribute('http-equiv'))) {
      element.parentNode?.removeChild(element);
      continue;
    }
    for (const attribute of Array.from(element.attributes || [])) {
      const attributeName = attribute.name.toLowerCase();
      if (/^on/.test(attributeName) || ['srcset', 'poster', 'href', 'xlink:href', 'action', 'formaction'].includes(attributeName)
        || (attributeName === 'src' && (name !== 'img' || !localImage(attribute.value)))) element.removeAttribute(attribute.name);
    }
  }
}

function prepareInspectionDocument(document, target, index) {
  const html = document.documentElement;
  let head = elements(document, 'head')[0];
  if (!head) {
    head = document.createElement('head');
    html.insertBefore(head, html.firstChild);
  }
  // The parser already received a CSP first. Rebuild it as the first head child
  // for the serialized iframe document, removing the original permissive policy.
  removeActiveContent(elements(document));
  let parent = target;
  while (parent && parent !== html) parent = parent.parentNode;
  if (parent !== html) throw new Error('公式位置已被移除。');
  const policy = document.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', INSPECTION_CSP);
  head.insertBefore(policy, head.firstChild);
  const existingIds = new Set(elements(document).map(element => element.getAttribute('id')).filter(Boolean));
  const base = `campus-formula-inspection-${index}`;
  let anchor = base;
  for (let suffix = 2; existingIds.has(anchor); suffix++) anchor = `${base}-${suffix}`;
  target.setAttribute('id', anchor);
  const style = document.createElement('style');
  style.textContent = `#${anchor}:target{outline:3px solid #b45309!important;outline-offset:5px;background-color:#fff2b3!important;scroll-margin-block:96px}html{scroll-behavior:auto}body{overflow-wrap:anywhere}img{max-width:100%;height:auto}`;
  head.appendChild(style);
  return { preview: `<!doctype html>\n${html.outerHTML || html.toString()}`, anchor };
}

/**
 * Build a separate, local-only inspection document from result.preview.
 * index is strictly 1-based and must agree with every manifest entry's index.
 * options.parseDocument(source) may inject a DOM-compatible parser in tests;
 * it receives a restrictive CSP before the trusted original preview HTML.
 * The caller keeps sandbox="" and appends #anchor to its Blob iframe URL.
 * Unconfirmed locations return exact manifest TeX, no preview/anchor, and a reason.
 */
export function createFormulaInspection(result, index, options = {}) {
  const formulas = result?.manifest?.formulas;
  const formula = Array.isArray(formulas) && Number.isSafeInteger(index) && index > 0 ? formulas[index - 1] : undefined;
  const fallback = {
    index: Number.isSafeInteger(index) ? index : null,
    tex: typeof formula?.tex === 'string' ? formula.tex : '',
    preview: '', anchor: '', available: false, reason: '',
  };
  const fail = reason => ({ ...fallback, reason });
  if (!Number.isSafeInteger(index) || index < 1) return fail('公式编号必须是从 1 开始的整数。');
  const problem = manifestProblem(formulas);
  if (problem) return fail(problem);
  if (index > formulas.length) return fail('该公式编号超出当前文档的公式清单。');
  if (typeof result.preview !== 'string' || !result.preview.trim()) return fail('当前文档没有可检查的原始本地预览。');
  const imageMode = result.manifest.options?.imageMode;
  if (imageMode !== undefined && imageMode !== 'embedded') return fail('公式检查只使用原始嵌入图片预览，不读取校内地址或本地资产路径。');
  const format = result.manifest.options?.formulaFormat || formula.format;
  if (format !== 'mathml' && format !== 'png') return fail('当前公式格式不支持精确位置检查。');
  try {
    const parseDocument = options?.parseDocument || browserParseDocument;
    if (typeof parseDocument !== 'function') return fail('本地预览解析器无效。');
    const document = parseDocument(CSP_PREFIX + result.preview);
    if (!document?.documentElement || typeof document.getElementsByTagName !== 'function' || !elements(document, 'body').length) {
      return fail('原始本地预览无法解析为完整正文。');
    }
    const location = format === 'mathml' ? exactMathTarget(document, formulas, index) : exactPngTarget(document, formulas, index);
    if (!location.target) return fail(location.reason);
    if (format === 'png' && !localImage(location.target.getAttribute('src'))) return fail('该公式图片不是可用的本地嵌入资源，无法显示其位置。');
    const clone = prepareInspectionDocument(document, location.target, index);
    return { ...fallback, ...clone, available: true, reason: '' };
  } catch {
    return fail('原始本地预览解析失败，无法确认公式位置。');
  }
}
