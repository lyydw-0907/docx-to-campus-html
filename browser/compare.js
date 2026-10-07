// Browser-safe source comparison; HTML is parsed without loading resources.
import { load } from './html.js';

export function safeImageUrl(value) {
  if (typeof value !== 'string') throw new Error('图片地址必须是绝对 HTTP(S) URL。');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('图片地址必须是无账号密码的绝对 HTTP(S) URL。');
  return url.href;
}

function count(values) {
  const result = Object.create(null);
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return result;
}

function styleValues(style) {
  const result = new Map();
  for (const declaration of String(style || '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 1) continue;
    result.set(declaration.slice(0, colon).trim().toLowerCase(),
      declaration.slice(colon + 1).trim().replace(/\s+/g, ' ').toLowerCase());
  }
  return result;
}

function imageSnapshot($, el) {
  const styles = styleValues($(el).attr('style'));
  return {
    src: $(el).attr('src') || '',
    width: ($(el).attr('width') || '').trim(),
    height: ($(el).attr('height') || '').trim(),
    style: {
      width: styles.get('width') || '',
      height: styles.get('height') || '',
      verticalAlign: styles.get('vertical-align') || '',
    },
  };
}

/** Prefer preserved sources; rewritten URLs can only be paired tentatively. */
function compareImages(before, after) {
  const available = new Map();
  after.forEach((image, index) => {
    if (!image.src) return;
    if (!available.has(image.src)) available.set(image.src, []);
    available.get(image.src).push(index);
  });
  const matches = new Map();
  const used = new Set();
  before.forEach((image, index) => {
    const candidates = available.get(image.src);
    if (!candidates?.length) return;
    const afterIndex = candidates.shift();
    matches.set(index, { afterIndex, match: 'source' });
    used.add(afterIndex);
  });
  const unmatchedBefore = before.map((_, index) => index).filter(index => !matches.has(index));
  const unmatchedAfter = after.map((_, index) => index).filter(index => !used.has(index));
  const pairedCount = Math.min(unmatchedBefore.length, unmatchedAfter.length);
  for (let i = 0; i < pairedCount; i++) {
    matches.set(unmatchedBefore[i], { afterIndex: unmatchedAfter[i], match: 'order' });
    used.add(unmatchedAfter[i]);
  }
  const changes = [];
  before.forEach((previous, index) => {
    const pair = matches.get(index);
    if (!pair) {
      changes.push({ index: index + 1, afterIndex: null, match: 'missing', before: previous, after: null,
        changes: ['image'], status: 'missing', note: '回读源码中没有找到对应图片；请检查真实页面。' });
      return;
    }
    const current = after[pair.afterIndex];
    const fields = ['src', 'width', 'height'].filter(key => previous[key] !== current[key]);
    for (const key of ['width', 'height', 'verticalAlign']) {
      if (previous.style[key] !== current.style[key]) fields.push(`style.${key}`);
    }
    if (index !== pair.afterIndex) fields.push('position');
    if (!fields.length) return;
    const geometryChanged = fields.some(key => !['src', 'position'].includes(key));
    changes.push({
      index: index + 1,
      afterIndex: pair.afterIndex + 1,
      match: pair.match,
      before: previous,
      after: current,
      changes: fields,
      status: geometryChanged ? 'geometry-changed' : fields.includes('src') ? 'source-rewritten' : 'reordered',
      note: pair.match === 'source'
        ? '按保留的图片 src 对应；这里比较的是源码属性和样式，尚未验证视觉效果。'
        : '图片 src 已变化或缺失，按未匹配图片的出现顺序推测对应关系。URL 改写可能是正常上传或代理处理，不能据此判定图片支持失败。',
    });
  });
  after.forEach((current, index) => {
    if (!used.has(index)) changes.push({ index: index + 1, afterIndex: index + 1, match: 'added', before: null,
      after: current, changes: ['image'], status: 'added', note: '回读源码中出现额外图片，未确认其与原图片的对应关系。' });
  });
  return changes;
}

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const MATH_TOKEN_TAGS = new Set(['mi', 'mo', 'mn', 'mtext', 'ms']);
const MATH_ANNOTATION_TAGS = new Set(['annotation', 'annotation-xml']);

function attributesOf(node) {
  return Object.keys(node.attribs || {}).sort().map(name => ({
    name,
    namespace: node['x-attribsNamespace']?.[name] || '',
    prefix: node['x-attribsPrefix']?.[name] || '',
    value: node.attribs[name],
  }));
}

function codePoints(text) {
  return Array.from(text, character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

function isElement(node) {
  return ['tag', 'script', 'style'].includes(node.type);
}

/** Only formatting whitespace surrounding element children is insignificant. */
function mathChildren(node, annotation = false) {
  const children = node.children || [];
  if (annotation || MATH_TOKEN_TAGS.has(node.name) || !children.some(isElement)) return children;
  return children.filter(child => child.type !== 'text' || !/^[\t\n\r\f ]*$/.test(child.data));
}

function elementRecord(node, path) {
  return { path, tag: node.name, namespace: node.namespace || '', attributes: attributesOf(node) };
}

/** Iterative traversal avoids a call-stack limit on deeply nested input. */
function annotationSnapshot(root, path) {
  const records = [];
  const stack = [{ node: root, path }];
  while (stack.length) {
    const current = stack.pop();
    const { node } = current;
    if (isElement(node)) {
      records.push(elementRecord(node, current.path));
      const children = mathChildren(node, true);
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({ node: children[index], path: [...current.path, index] });
      }
    } else {
      const text = node.data || '';
      records.push({ path: current.path, tag: `#${node.type}`, namespace: '', text, codePoints: codePoints(text) });
    }
  }
  return { path, records };
}

function mathSnapshot(root) {
  const structure = [];
  const tokens = [];
  const annotations = [];
  let elementCount = 0;
  let tokenCount = 0;
  const stack = [{ node: root, path: [], parent: null }];
  while (stack.length) {
    const current = stack.pop();
    const { node, path, parent } = current;
    if (isElement(node)) {
      elementCount++;
      const record = elementRecord(node, path);
      if (node.namespace === MATHML_NAMESPACE && MATH_ANNOTATION_TAGS.has(node.name)) {
        // Keep its location in the presentation tree, but compare its payload separately.
        structure.push({ path, tag: record.tag, namespace: record.namespace });
        annotations.push(annotationSnapshot(node, path));
        continue;
      }
      structure.push(record);
      if (node.namespace === MATHML_NAMESPACE && MATH_TOKEN_TAGS.has(node.name)) tokenCount++;
      const children = mathChildren(node);
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({ node: children[index], path: [...path, index], parent: node });
      }
    } else if (node.type === 'text') {
      const text = node.data || '';
      tokens.push({ path, tag: parent?.name || '#text', namespace: parent?.namespace || '', text, codePoints: codePoints(text) });
    } else {
      structure.push({ path, tag: `#${node.type}`, namespace: '', text: node.data || '' });
    }
  }
  return {
    summary: { text: tokens.map(token => token.text).join(''), elementCount, tokenCount, annotationCount: annotations.length },
    structure, tokens, annotations,
  };
}

function changesByPath(before, after) {
  const previous = new Map(before.map(record => [JSON.stringify(record.path), record]));
  const current = new Map(after.map(record => [JSON.stringify(record.path), record]));
  const changes = [];
  for (const key of new Set([...previous.keys(), ...current.keys()])) {
    const a = previous.get(key) || null;
    const b = current.get(key) || null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const fields = !a || !b ? ['node'] : [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter(field => field !== 'path' && JSON.stringify(a[field]) !== JSON.stringify(b[field]));
    changes.push({ path: (a || b).path, before: a, after: b, changes: fields });
  }
  return changes;
}

/** Match formulas by their appearance order; do not equate Unicode lookalikes. */
function compareMath(before, after) {
  const changes = [];
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const a = before[index];
    const b = after[index];
    const structureChanges = changesByPath(a?.structure || [], b?.structure || []);
    const tokenChanges = changesByPath(a?.tokens || [], b?.tokens || []);
    const annotationChanges = changesByPath(a?.annotations || [], b?.annotations || []);
    const structurePreserved = Boolean(a && b) && structureChanges.length === 0;
    const tokensPreserved = Boolean(a && b) && tokenChanges.length === 0;
    const annotationPreserved = Boolean(a && b) && annotationChanges.length === 0;
    if (structurePreserved && tokensPreserved && annotationPreserved) continue;
    changes.push({
      index: index + 1,
      before: a?.summary || null,
      after: b?.summary || null,
      structurePreserved, tokensPreserved, annotationPreserved,
      structureChanges, tokenChanges, annotationChanges,
    });
  }
  return changes;
}

function inspect(fragment) {
  const $ = load(fragment, null, false);
  // Snapshot before the general source report removes unsafe elements: even an
  // annotation-xml payload change must remain visible to the math comparison.
  const maths = $('math').toArray().map(mathSnapshot);
  $('script,style,iframe,object').remove();
  const tags = count($('*').toArray().map(el => el.tagName));
  const styles = count($('[style]').toArray().flatMap(el => ($(el).attr('style') || '').split(';').map(declaration => {
    const index = declaration.indexOf(':');
    return index < 1 ? '' : `${declaration.slice(0, index).trim().toLowerCase()}:${declaration.slice(index + 1).trim().replace(/\s+/g, ' ').toLowerCase()}`;
  }).filter(Boolean)));
  const images = $('img').toArray().map(el => imageSnapshot($, el));
  const text = $.root().text().replace(/\s+/g, ' ').trim().normalize('NFC');
  return { tags, styles, images, text, maths, spans: count($('[colspan],[rowspan]').toArray().flatMap(el => ['colspan', 'rowspan'].filter(key => $(el).attr(key)).map(key => `${key}:${$(el).attr(key)}`))) };
}

export function compareFragments(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string' || !before.trim() || !after.trim()) throw new Error('请提供保存前和重新打开后的两份 HTML 源码。');
  const a = inspect(before);
  const b = inspect(after);
  const rows = [];
  for (const [kind, previous, current] of [['tag', a.tags, b.tags], ['style', a.styles, b.styles], ['cell-span', a.spans, b.spans]]) {
    for (const feature of Object.keys({ ...previous, ...current }).sort()) {
      const x = previous[feature] || 0;
      const y = current[feature] || 0;
      rows.push({ kind, feature, before: x, after: y, status: x === y ? 'unchanged' : y < x ? 'reduced' : 'increased' });
    }
  }
  const oldSources = count(a.images.map(img => img.src));
  const newSources = count(b.images.map(img => img.src));
  const unchangedSources = Object.keys(oldSources).reduce((sum, src) => sum + (src ? Math.min(oldSources[src], newSources[src] || 0) : 0), 0);
  const mathChanges = compareMath(a.maths, b.maths);
  return {
    verification: 'source-compared-only',
    textPreserved: a.text === b.text,
    imageCountBefore: a.images.length,
    imageCountAfter: b.images.length,
    unchangedImageSources: unchangedSources,
    imagesWithDimensionsBefore: a.images.filter(img => img.width && img.height).length,
    imagesWithDimensionsAfter: b.images.filter(img => img.width && img.height).length,
    imageChanges: compareImages(a.images, b.images),
    mathCountBefore: a.maths.length,
    mathCountAfter: b.maths.length,
    mathPreserved: mathChanges.length === 0,
    mathChanges,
    rows,
    notes: [
      '这是源码差异报告，不能自动证明图片加载、字号或基线视觉效果正确。',
      '图片 URL 改写可能是学校上传或代理处理；需要在重新打开的页面检查图片是否加载。',
      '标签或样式减少也可能是等价改写；请结合页面效果判断。',
      'MathML 按公式出现顺序比较结构、属性、原始字符码点和注释；数学内容不做 Unicode 归一化。仅忽略数学元素之间的缩进空白，源码相同不能自动证明数学排版正确。',
      '完成一次测试不代表所有文档兼容，当前学校配置仍需记录实际测试结果。',
    ],
  };
}
