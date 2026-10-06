import { load } from 'cheerio';

const FIELDS = [
  { id: 'research-purpose', title: '研究目的' },
  { id: 'research-status', title: '国内外研究现状和发展动态' },
  { id: 'research-content', title: '研究内容' },
  { id: 'innovation', title: '创新点与项目特色' },
  { id: 'technical-route', title: '技术路线、拟解决的问题' },
  { id: 'schedule', title: '项目研究进度安排' },
  { id: 'conditions', title: '已具备的条件，尚缺少的条件及解决方法', aliases: ['已有基础'] },
  { id: 'expected-results', title: '预期成果' }
];
const HEADING = /^h([1-6])$/;
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'body', 'td', 'th']);
const NOT_SECTION_CONTEXT = new Set(['li', 'blockquote', 'caption', 'figcaption', 'thead', 'tfoot']);
// These are inherited typography properties. Document-table borders, preferred
// widths, cell padding and paragraph margins must not become section geometry.
const INHERITED_STYLES = new Set([
  'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant',
  'line-height', 'color', 'text-align', 'text-indent', 'white-space',
  'letter-spacing', 'word-spacing', 'direction', 'text-transform'
]);

function normalizedHeading(value) {
  return String(value).trim().replace(/[:：]+$/, '').replace(/[\s\u200b\u200c\u200d\ufeff,，、]/g, '');
}

const FIELD_BY_HEADING = new Map(FIELDS.flatMap(field => [field.title, ...(field.aliases ?? [])].map(title => [normalizedHeading(title), field])));

function headingLevel(element) {
  return Number(HEADING.exec(element.name ?? '')?.[1]) || 0;
}

function ownCells($, table) {
  return $(table).find('td,th').toArray().filter(cell => $(cell).closest('table')[0] === table);
}

function eligibleContainer($, container) {
  if (container.type !== 'root' && !CONTAINERS.has(container.name)) return false;
  const contexts = [container, ...$(container).parents().toArray()];
  if (contexts.some(element => NOT_SECTION_CONTEXT.has(element.name))) return false;
  // Headings in real data tables describe cells, not school form fields. Only
  // one-cell document wrappers are safe to detach, including nested wrappers.
  return contexts.filter(element => element.name === 'table').every(table => ownCells($, table).length === 1);
}

function contains(ancestor, descendant) {
  for (let node = descendant.parent; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

function typographyStyle(value) {
  return String(value ?? '').split(';').filter(declaration => {
    const colon = declaration.indexOf(':');
    return colon >= 0 && INHERITED_STYLES.has(declaration.slice(0, colon).trim().toLowerCase()) && declaration.slice(colon + 1).trim();
  }).map(declaration => declaration.trim()).join(';');
}

function escapedAttribute(value) {
  return String(value).replace(/[&"<>]/g, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]);
}

function wrapperStyles($, container) {
  return [...$(container).parents().toArray().reverse(), container].map(element => typographyStyle($(element).attr('style'))).filter(Boolean);
}

function wrappedFragment($, nodes, styles) {
  let fragment = nodes.map(node => $.html(node)).join('');
  // Keep relative font sizes in their original ancestor order rather than
  // flattening 80% over 20px into a wrapper with a changed font-size baseline.
  for (const style of [...styles].reverse()) fragment = `<div style="${escapedAttribute(style)}">${fragment}</div>`;
  return fragment;
}

function meaningfulNodes($, nodes) {
  return nodes.some(node => node.type === 'text' ? node.data.trim() : node.type === 'tag' && ($(node).text().trim() || $(node).is('img,math,table,hr') || $(node).find('img,math,table,hr').length));
}

function resourceCounts(fragment, assetsBySource) {
  const $ = load(fragment, {}, false);
  const assetFilenames = new Set();
  let formulaCount = $('math').length;
  let imageCount = 0;
  $('img').each((_, image) => {
    const assets = assetsBySource.get($(image).attr('src')) ?? [];
    for (const asset of assets) assetFilenames.add(asset.filename);
    if (assets.length && assets.every(asset => asset.kind === 'formula')) formulaCount++;
    else imageCount++;
  });
  return { assetFilenames: [...assetFilenames], formulaCount, imageCount };
}

/**
 * Split already sanitized HTML at one confident group of sibling field headings.
 * The whole-document fragment is never mutated; unsupported layouts return no
 * partial sections. The caller keeps that whole-document export available.
 */
export function splitCampusSections(fragment, { assets = [] } = {}) {
  const $ = load(String(fragment ?? ''), {}, false);
  const warnings = [];
  const fail = reason => ({ sections: [], warnings: [reason] });
  const groups = new Map();
  $('h1,h2,h3,h4,h5,h6').each((_, heading) => {
    const field = FIELD_BY_HEADING.get(normalizedHeading($(heading).text()));
    if (!field || !eligibleContainer($, heading.parent)) return;
    let levels = groups.get(heading.parent);
    if (!levels) groups.set(heading.parent, levels = new Map());
    const level = headingLevel(heading);
    let headings = levels.get(level);
    if (!headings) levels.set(level, headings = []);
    headings.push({ element: heading, field });
  });
  const candidates = [];
  for (const [container, levels] of groups) {
    for (const [level, matches] of levels) {
      const score = new Set(matches.map(match => match.field.id)).size;
      if (score >= 2) candidates.push({ container, level, matches, score });
    }
  }
  if (!candidates.length) return fail('未找到至少两个同一层级、同一容器中的学校栏目标题。已保留整篇转换结果，请按栏目手动选择正文。');
  candidates.sort((a, b) => b.score - a.score);
  const candidate = candidates[0];
  if (candidates[1]?.score === candidate.score || candidates.slice(1).some(other => other.container !== candidate.container && !contains(candidate.container, other.container))) {
    return fail('发现多个可能的栏目区域，无法确定唯一分栏位置。已保留整篇转换结果，未自动拆分。');
  }
  const nodes = $(candidate.container).contents().toArray();
  const matchedIndices = candidate.matches.map(match => nodes.indexOf(match.element));
  const firstMatched = Math.min(...matchedIndices);
  const lastMatched = Math.max(...matchedIndices);
  const boundaryNames = new Set();
  let currentField;
  for (let index = 0; index < nodes.length; index++) {
    const element = nodes[index];
    const level = headingLevel(element);
    if (!level) continue;
    const normalized = normalizedHeading($(element).text());
    const field = FIELD_BY_HEADING.get(normalized);
    if (level === candidate.level) {
      const name = field?.id ?? normalized;
      if (!name || boundaryNames.has(name)) return fail('栏目边界包含空标题或重复标题，无法确定正文归属。已保留整篇转换结果，未自动拆分。');
      boundaryNames.add(name);
      currentField = field;
    } else if (level < candidate.level) {
      if (field || index > firstMatched && index < lastMatched) return fail('学校栏目标题的层级不一致，或栏目之间存在更高层级标题。已保留整篇转换结果，未自动拆分。');
      currentField = undefined;
    } else if (field && field.id !== currentField?.id) {
      // A same-name lower heading inside its own field is an ordinary subsection.
      // A different confirmed field at that depth could instead be a wrong-level
      // boundary, so do not silently include it in another field's body.
      return fail('学校栏目标题混用了不同标题层级，无法安全区分外层栏目和内部小标题。已保留整篇转换结果，未自动拆分。');
    }
  }

  const styles = wrapperStyles($, candidate.container);
  const assetsBySource = new Map();
  for (const asset of assets) {
    if (typeof asset?.src !== 'string' || typeof asset?.filename !== 'string') continue;
    let matches = assetsBySource.get(asset.src);
    if (!matches) assetsBySource.set(asset.src, matches = []);
    matches.push(asset);
  }
  const sections = [];
  let unassigned = 0;
  function appendSection({ heading, field, content }) {
    const title = field?.title ?? (heading ? $(heading).text().trim() : '栏目之前的内容');
    const sectionFragment = wrappedFragment($, field ? content : [...(heading ? [heading] : []), ...content], styles);
    sections.push({
      id: field?.id ?? `unassigned-${++unassigned}`,
      title,
      kind: field ? 'field' : 'unassigned',
      sourceHeading: heading ? $(heading).text().trim() : '',
      fragment: sectionFragment,
      ...resourceCounts(sectionFragment, assetsBySource)
    });
    if (!field) warnings.push(`“${title}”尚未分配到学校栏目，已单独保留。`);
    else if (!meaningfulNodes($, content)) warnings.push(`“${title}”标题后没有正文，请确认该栏目是否留空。`);
  }
  const boundaries = nodes.map((element, index) => ({ element, index, level: headingLevel(element) })).filter(entry => entry.level && entry.level <= candidate.level);
  const prefix = nodes.slice(0, boundaries[0].index);
  if (meaningfulNodes($, prefix)) appendSection({ content: prefix });
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index];
    const field = boundary.level === candidate.level ? FIELD_BY_HEADING.get(normalizedHeading($(boundary.element).text())) : undefined;
    appendSection({ heading: boundary.element, field, content: nodes.slice(boundary.index + 1, boundaries[index + 1]?.index ?? nodes.length) });
  }
  return { sections, warnings };
}
