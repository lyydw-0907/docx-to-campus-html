import { load } from './html.js';
import { safeImageUrl } from './compare.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const IDENTITY_ATTRIBUTES = ['data-filename', 'alt', 'title'];

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function resolvedImageUrl(value, pageUrl) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source || source.length > 4096 || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error('图片地址无效。');
  }
  // URL parsing may remove embedded controls or reinterpret backslashes. Reject
  // them before resolving, and use the same protocol/credential check as export.
  if (source.includes('\\')) throw new Error('图片地址无效。');
  const absolute = pageUrl ? new URL(source, pageUrl).href : source;
  return safeImageUrl(absolute);
}

/**
 * Parse pasted HTML without rendering it or requesting any image. Exact matches
 * require a complete preserved asset filename. Appearance-order candidates are
 * only a proposal for explicit user confirmation, never automatic matches.
 */
export function importImageUrls(html, assets, { pageUrl } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('请粘贴学校编辑器的 HTML 源码。');
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error('HTML 源码不能超过 2 MB。');
  if (!Array.isArray(assets) || assets.some(asset => !asset || typeof asset.filename !== 'string' || !asset.filename.trim() ||
    (asset.uploadFilename !== undefined && (typeof asset.uploadFilename !== 'string' || !asset.uploadFilename.trim())))) {
    throw new Error('图片文件列表无效，请重新转换 Word。');
  }
  let baseUrl;
  if (pageUrl !== undefined && pageUrl !== null && pageUrl !== '') {
    try { baseUrl = resolvedImageUrl(pageUrl); } catch { throw new Error('学校页面地址需要无账号密码的完整 HTTP(S) 地址。'); }
  }

  const warnings = [];
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  const assetCounts = new Map();
  for (const { filename } of assets) assetCounts.set(filename, (assetCounts.get(filename) || 0) + 1);
  const filenames = [...assetCounts.keys()];
  const identifiers = new Map();
  for (const asset of assets) {
    for (const identity of new Set([asset.filename, asset.uploadFilename].filter(Boolean))) {
      if (!identifiers.has(identity)) identifiers.set(identity, new Map());
      identifiers.get(identity).set(asset.filename, identity === asset.filename ? 'filename' : 'uploadFilename');
    }
  }
  let ambiguous = false;
  for (const [filename, count] of assetCounts) {
    if (count > 1) {
      ambiguous = true;
      warn(`图片文件名重复，未自动匹配：${filename}`);
    }
  }
  for (const [identity, targets] of identifiers) {
    if (targets.size > 1) {
      ambiguous = true;
      warn(`图片文件名别名冲突，未自动匹配：${identity}`);
    }
  }

  const $ = load(html, null, false);
  // These contain code, inert fragments or fallback content rather than the
  // editor's actual uploaded images. Cheerio only parses; no browser is used.
  $('script,style,template,noscript,iframe,object').remove();
  const imageNodes = $('img').toArray();
  const images = [];
  let rejectedCount = 0;
  imageNodes.forEach((node, offset) => {
    const index = offset + 1;
    let url;
    try {
      url = resolvedImageUrl($(node).attr('src'), baseUrl);
    } catch {
      rejectedCount++;
      warn(`第 ${index} 张图片地址无效或不安全；相对地址需提供学校页面地址。`);
      return;
    }
    const claims = new Map();
    const basename = decoded(new URL(url).pathname.split('/').pop() || '');
    const primary = identifiers.get(basename) || new Map();
    for (const [filename, method] of primary) claims.set(filename, method);
    let hasAttributeHint = false;
    for (const attribute of IDENTITY_ATTRIBUTES) {
      const identity = decoded(($(node).attr(attribute) || '').trim());
      for (const filename of identifiers.get(identity)?.keys() || []) {
        hasAttributeHint = true;
        if (!claims.has(filename)) claims.set(filename, attribute);
      }
    }
    if (claims.size > 1) {
      ambiguous = true;
      warn(`第 ${index} 张图片的文件名标识冲突，未自动匹配。`);
    } else if (!primary.size && hasAttributeHint) {
      warn(`第 ${index} 张图片仅保留文字文件名提示，需要确认对应关系。`);
    }
    images.push({ index, url, claims, primary });
  });

  const byFilename = new Map();
  const byUrl = new Map();
  for (const image of images) {
    if (!byUrl.has(image.url)) byUrl.set(image.url, []);
    byUrl.get(image.url).push(image);
    for (const filename of image.claims.keys()) {
      if (!byFilename.has(filename)) byFilename.set(filename, []);
      byFilename.get(filename).push(image);
    }
  }
  const duplicateUrls = new Set();
  for (const [url, occurrences] of byUrl) {
    if (occurrences.length > 1) {
      duplicateUrls.add(url);
      ambiguous = true;
      warn('源码中有重复图片地址，未按重复位置自动匹配或推测顺序。');
    }
  }
  for (const [filename, occurrences] of byFilename) {
    if (occurrences.length > 1) {
      ambiguous = true;
      warn(`多张图片指向同一文件名，未自动匹配：${filename}`);
    }
  }

  const matches = [];
  const used = new Set();
  for (const filename of filenames) {
    const occurrences = byFilename.get(filename) || [];
    if (assetCounts.get(filename) !== 1 || occurrences.length !== 1) continue;
    const image = occurrences[0];
    if (image.claims.size !== 1 || image.primary.size !== 1 || !image.primary.has(filename) || duplicateUrls.has(image.url)) continue;
    matches.push({ filename, url: image.url, method: image.primary.get(filename) });
    used.add(image.index);
  }
  const matchedNames = new Set(matches.map(match => match.filename));
  const unmatchedAssets = filenames.filter(filename => !matchedNames.has(filename));
  const unusedImages = images.filter(image => !used.has(image.index)).map(({ index, url }) => ({ index, url }));
  const orderReady = unmatchedAssets.length > 0 && !ambiguous && rejectedCount === 0 && unusedImages.length === unmatchedAssets.length;
  const orderCandidates = orderReady
    ? unmatchedAssets.map((filename, index) => ({ filename, ...unusedImages[index] }))
    : [];
  if (orderReady) warn('文件名未保留；顺序匹配仅供确认，请确认这些都是本次上传的图片且上传顺序一致。');
  else if (unmatchedAssets.length && !ambiguous && !rejectedCount) {
    warn('待匹配文件与剩余图片数量不同，不能按顺序对应；请只粘贴本次上传的图片源码。');
  }
  if (!imageNodes.length) warn('源码中没有找到图片。');
  const canAdjustOrder = !ambiguous && rejectedCount === 0 && images.length === assets.length && images.length > 0;
  const imageChoices = canAdjustOrder ? images.map(({ index, url }) => ({ index, url })) : [];
  return { detectedCount: imageNodes.length, matches, unmatchedAssets, unusedImages, warnings, orderCandidates, orderReady, imageChoices, canAdjustOrder };
}
