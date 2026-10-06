import JSZip from 'jszip';
import { load } from 'cheerio';
import { WORD_NS, MATH_NS, localName, namespace, matches, elements, direct, attribute, val, closestParagraph } from './word-xml.mjs';
import { readTableProperties, mergeTableProperties, collectWordTables, restoreWordTables } from './word-tables.mjs';
import { createWordBoldResolver } from './word-bold.mjs';

const cssNumber = value => Number(value.toFixed(3)).toString();
const xmlAttribute = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

function serializePreservingMath($, originalXml) {
  const originals = elements($, 'oMath', MATH_NS).map(node => originalXml.slice(node.startIndex, node.endIndex + 1));
  const serialized = $.xml();
  if (!originals.length) return serialized;
  const parsed = load(serialized, { xmlMode: true, withStartIndices: true, withEndIndices: true });
  const math = elements(parsed, 'oMath', MATH_NS);
  if (math.length !== originals.length) throw new Error('准备 Word 格式时公式节点数量发生变化，已停止转换。');
  const pieces = [];
  let position = 0;
  math.forEach((node, index) => { pieces.push(serialized.slice(position, node.startIndex), originals[index]); position = node.endIndex + 1; });
  pieces.push(serialized.slice(position));
  return pieces.join('');
}

function readRun($, node) {
  if (!node) return {};
  const result = {};
  for (const name of ['sz', 'szCs']) {
    const value = val(direct($, node, name));
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function readParagraph($, node) {
  if (!node) return { paragraph: {} };
  const paragraph = {};
  const indent = direct($, node, 'ind');
  if (indent) paragraph.indent = Object.fromEntries(Object.entries(indent.attribs).filter(([name]) => namespace(indent, name, true) === WORD_NS).map(([name, value]) => [localName(name), value]));
  const alignment = val(direct($, node, 'jc'));
  if (alignment !== undefined) paragraph.alignment = alignment;
  const spacing = direct($, node, 'spacing');
  if (spacing) paragraph.spacing = Object.fromEntries(Object.entries(spacing.attribs).filter(([name]) => namespace(spacing, name, true) === WORD_NS).map(([name, value]) => [localName(name), value]));
  // pPr/rPr describes the paragraph mark glyph, not the text runs' font baseline.
  return { paragraph };
}

function merge(...layers) {
  const result = { paragraph: {}, run: {}, table: {} };
  for (const layer of layers) {
    if (!layer) continue;
    result.paragraph = { ...result.paragraph, ...layer.paragraph, indent: { ...result.paragraph.indent, ...layer.paragraph?.indent }, spacing: { ...result.paragraph.spacing, ...layer.paragraph?.spacing } };
    result.run = { ...result.run, ...layer.run };
    result.table = mergeTableProperties(result.table, layer.table);
  }
  return result;
}

function createStyles($, warn) {
  const records = new Map();
  for (const node of elements($, 'style')) {
    const id = attribute(node, 'styleId');
    if (!id) continue;
    const properties = readParagraph($, direct($, node, 'pPr'));
    const table = readTableProperties($, direct($, node, 'tblPr'));
    if (direct($, node, 'tblStylePr')) table.conditional = true;
    records.set(id, { id, type: attribute(node, 'type'), name: val(direct($, node, 'name')), default: ['1', 'true', 'on'].includes(attribute(node, 'default')), basedOn: val(direct($, node, 'basedOn')), paragraph: properties.paragraph, run: readRun($, direct($, node, 'rPr')), table });
  }
  const defaults = elements($, 'docDefaults')[0];
  const paragraphDefaults = direct($, direct($, defaults, 'pPrDefault'), 'pPr');
  const runDefaults = direct($, direct($, defaults, 'rPrDefault'), 'rPr');
  const base = merge(readParagraph($, paragraphDefaults), { run: readRun($, runDefaults) });
  const cache = new Map();
  function resolve(id, type, trail = []) {
    if (!id) return merge();
    const key = `${type}:${id}`;
    if (trail.includes(id) || trail.length >= 64) { warn('Word 样式继承存在循环或超过 64 层，已停止继续继承。'); return merge(); }
    if (cache.has(key)) return cache.get(key);
    const record = records.get(id);
    if (!record || record.type !== type) { warn('Word 中有缺失或类型不符的样式，只恢复可确认的直接格式。'); return merge(); }
    const result = merge(resolve(record.basedOn, type, [...trail, id]), record);
    cache.set(key, result);
    return result;
  }
  const defaultParagraph = [...records.values()].find(record => record.type === 'paragraph' && record.default)?.id;
  const defaultCharacter = [...records.values()].find(record => record.type === 'character' && record.default)?.id;
  const defaultTable = [...records.values()].find(record => record.type === 'table' && record.default)?.id;
  return { records, resolve, base, defaultParagraph, defaultCharacter, defaultTable };
}

function tableParagraphLayout(properties) {
  const spacing = properties.spacing || {};
  const numeric = value => /^\d+(?:\.\d+)?$/.test(value ?? '') && Number(value) <= 1_000_000;
  const gap = (twips, lines) => numeric(lines) ? `${cssNumber(Number(lines) / 100)}em` : numeric(twips) ? `${cssNumber(Number(twips) / 15)}px` : '0px';
  const declarations = [`margin-top:${gap(spacing.before, spacing.beforeLines)}`, `margin-bottom:${gap(spacing.after, spacing.afterLines)}`];
  const line = numeric(spacing.line) && Number(spacing.line) > 0 ? spacing.lineRule === 'exact' || spacing.lineRule === 'atLeast' ? `${cssNumber(Number(spacing.line) / 15)}px` : cssNumber(Number(spacing.line) / 240) : 'normal';
  // Word exact/atLeast lines may grow around tall math in HTML; do not clip mathematical content.
  declarations.push(`line-height:${line}`);
  return declarations.join(';');
}

function paragraphCss(properties, fontSize, fontMode, warn) {
  const declarations = [];
  if (fontMode === 'word') declarations.push(`font-size:${cssNumber(fontSize)}px`);
  if (properties.alignment !== undefined) {
    const alignment = { left: 'left', center: 'center', right: 'right', both: 'justify' }[properties.alignment];
    if (alignment) declarations.push(`text-align:${alignment}`);
    else warn('Word 中有无法精确恢复的段落对齐方式，未替换为其他对齐方式。');
  }
  const indent = properties.indent || {};
  const measure = (characters, twips, sign = 1) => {
    const raw = characters !== undefined ? characters : twips;
    if (raw === undefined) return;
    const numeric = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(numeric) || Math.abs(numeric) > 1_000_000) { warn('Word 中有无效或超出范围的缩进值，未套用该缩进。'); return; }
    return `${cssNumber(sign * numeric / (characters !== undefined ? 100 : 15))}${characters !== undefined ? 'em' : 'px'}`;
  };
  const hanging = indent.hangingChars !== undefined || indent.hanging !== undefined;
  const firstLine = hanging ? measure(indent.hangingChars, indent.hanging, -1) : measure(indent.firstLineChars, indent.firstLine);
  const left = measure(indent.startChars ?? indent.leftChars, indent.start ?? indent.left);
  const right = measure(indent.endChars ?? indent.rightChars, indent.end ?? indent.right);
  for (const [property, value] of [['text-indent', firstLine], ['margin-left', left], ['margin-right', right]]) if (value !== undefined) declarations.push(`${property}:${value}`);
  return declarations.join(';');
}

function addStylesRelationship(zip, documentRelationships, contentTypes) {
  {
    const $ = load(documentRelationships || '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', { xmlMode: true });
    const relationships = $('*').toArray().filter(node => localName(node.name) === 'Relationship');
    if (!relationships.some(node => node.attribs.Type?.endsWith('/styles'))) {
      const ids = new Set(relationships.map(node => node.attribs.Id));
      let id = 'rIdCampusFormattingStyles';
      while (ids.has(id)) id += 'X';
      $($('*').toArray().find(node => localName(node.name) === 'Relationships')).append(`<Relationship xmlns="http://schemas.openxmlformats.org/package/2006/relationships" Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
      zip.file('word/_rels/document.xml.rels', $.xml());
    }
  }
  if (contentTypes) {
    const $ = load(contentTypes, { xmlMode: true });
    if (!$('*').toArray().some(node => localName(node.name) === 'Override' && node.attribs.PartName === '/word/styles.xml')) {
      $($('*').toArray().find(node => localName(node.name) === 'Types')).append('<Override xmlns="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>');
      zip.file('[Content_Types].xml', $.xml());
    }
  }
}

/** Annotate a disposable DOCX copy. Original document bytes and math nodes are untouched. */
export async function prepareWordFormatting(input, { fontMode = 'uniform', fontSize = 16 } = {}) {
  if (!['word', 'uniform'].includes(fontMode)) throw new Error('字号模式应为 word 或 uniform。');
  if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48) throw new Error('回退字号应在 8–48 px 之间。');
  const zip = await JSZip.loadAsync(input);
  const warnings = new Set();
  const warn = message => warnings.add(message);
  const originalStyles = await zip.file('word/styles.xml')?.async('string');
  const $styles = load(originalStyles || `<w:styles xmlns:w="${WORD_NS}"/>`, { xmlMode: true });
  const stylesRoot = elements($styles, 'styles')[0];
  if (!stylesRoot) throw new Error('Word 样式文件缺少有效的 styles 节点。');
  $styles(stylesRoot).attr('xmlns:w', WORD_NS);
  const styles = createStyles($styles, warn);
  const boldStyles = createWordBoldResolver($styles, warn);
  const occupied = new Set([...styles.records.values()].flatMap(style => [style.id, style.name]));
  let prefix = 'CampusFormatting';
  while ([...occupied].some(name => name?.startsWith(prefix))) prefix += 'X';
  const paragraphFormats = new Map();
  const runFormats = new Map();
  const tableFormats = new Map();
  const runStyleKeys = new Map();
  const summary = { fontMode, fallbackFontSize: fontSize, sourceParagraphs: 0, sourceRuns: 0, sourceMath: 0, originalParagraphSizes: 0, fallbackParagraphSizes: 0, originalRunSizes: 0, fallbackRunSizes: 0 };
  const font = (properties, kind) => {
    if (fontMode === 'uniform') return fontSize;
    const raw = properties.sz ?? properties.szCs;
    const size = typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 2 / 3 : NaN;
    if (Number.isFinite(size) && size >= 8 && size <= 48) { if (kind) summary[`original${kind}Sizes`]++; return size; }
    if (kind) summary[`fallback${kind}Sizes`]++;
    if (raw !== undefined) warn('Word 中有无效或不在 8–48 px 范围内的字号，使用所选回退字号。');
    return fontSize;
  };
  const appendStyle = (type, label, basedOn) => {
    $styles(stylesRoot).append(`<w:style w:type="${type}" w:customStyle="1" w:styleId="${label}"><w:name w:val="${label}"/>${basedOn && styles.records.has(basedOn) ? `<w:basedOn w:val="${xmlAttribute(basedOn)}"/>` : ''}</w:style>`);
  };
  const replaceStyle = ($, node, propertiesName, styleName, label) => {
    let properties = direct($, node, propertiesName);
    if (!properties) { $(node).prepend(`<w:${propertiesName}/>`); properties = direct($, node, propertiesName); }
    $(properties).children().filter((_, child) => matches(child, styleName)).remove();
    $(properties).prepend(`<w:${styleName} w:val="${label}"/>`);
  };
  for (const entryName of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    const entry = zip.file(entryName);
    if (!entry) continue;
    const originalXml = await entry.async('string');
    const $ = load(originalXml, { xmlMode: true, withStartIndices: true, withEndIndices: true });
    const root = $.root().children().get(0);
    if (root) $(root).attr('xmlns:w', WORD_NS);
    const tableLayouts = collectWordTables($, styles, warn);
    const sourceTableStyles = new Map();
    for (const [table, format] of tableLayouts.tables) {
      const originalStyle = val(direct($, direct($, table, 'tblPr'), 'tblStyle')) || styles.defaultTable;
      sourceTableStyles.set(table, originalStyle);
      const label = `${prefix}T${String(tableFormats.size + 1).padStart(6, '0')}`;
      tableFormats.set(label, format);
      appendStyle('table', label, originalStyle);
      replaceStyle($, table, 'tblPr', 'tblStyle', label);
    }
    for (const paragraph of elements($, 'p')) {
      if ($(paragraph).parents().toArray().some(node => ['footnote', 'endnote'].includes(localName(node.name)) && ['separator', 'continuationSeparator'].includes(attribute(node, 'type')))) continue;
      const properties = direct($, paragraph, 'pPr');
      const originalStyle = val(direct($, properties, 'pStyle')) || styles.defaultParagraph;
      const sourceTable = $(paragraph).parents().toArray().find(node => matches(node, 'tbl'));
      const tableStyle = sourceTableStyles.get(sourceTable);
      const paragraphBold = boldStyles.resolve(originalStyle, undefined, undefined, tableStyle).bold;
      const format = merge(styles.base, styles.resolve(styles.defaultParagraph, 'paragraph'), styles.resolve(originalStyle, 'paragraph'), readParagraph($, properties));
      const paragraphSize = font(format.run, 'Paragraph');
      const ownMath = $(paragraph).find('*').toArray().filter(node => matches(node, 'oMath', MATH_NS) && closestParagraph($, node) === paragraph);
      const mathSizeSources = [];
      const mathSizes = ownMath.map(math => {
        if (fontMode === 'uniform') { mathSizeSources.push('uniform'); return fontSize; }
        const controls = $(math).find('*').toArray().filter(node => matches(node, 'ctrlPr', MATH_NS));
        const mathParagraph = $(math).parents().toArray().find(node => matches(node, 'oMathPara', MATH_NS));
        const paragraphControls = mathParagraph ? $(direct($, mathParagraph, 'oMathParaPr', MATH_NS)).find('*').toArray().filter(node => matches(node, 'ctrlPr', MATH_NS)) : [];
        const controlRuns = [...controls, ...paragraphControls].map(control => readRun($, direct($, control, 'rPr'))).filter(run => run.sz !== undefined || run.szCs !== undefined);
        if (controlRuns.length) {
          const unique = [...new Set(controlRuns.map(run => font(run)))];
          if (unique.length > 1) { mathSizeSources.push('paragraph'); warn('Word 公式有多个不同控制字号，未猜测整条公式的字号，使用其段落字号。'); return paragraphSize; }
          mathSizeSources.push('control');
          return unique[0];
        }
        const mathRuns = $(math).find('*').toArray().filter(node => matches(node, 'r', MATH_NS)).map(run => readRun($, direct($, run, 'rPr')));
        const explicitRuns = mathRuns.filter(run => run.sz !== undefined || run.szCs !== undefined);
        if (explicitRuns.length) {
          const unique = [...new Set(explicitRuns.map(run => font(run)))];
          if (explicitRuns.length === mathRuns.length && unique.length === 1) { mathSizeSources.push('run'); return unique[0]; }
          warn('Word 公式正文的字号不一致或未完全指定，使用其段落字号。');
        }
        mathSizeSources.push('paragraph');
        return paragraphSize;
      });
      const label = `${prefix}P${String(++summary.sourceParagraphs).padStart(6, '0')}`;
      const descendants = $(paragraph).find('*').toArray();
      const empty = !mathSizes.length && !descendants.some(node => matches(node, 't') && $(node).text().trim() || ['drawing', 'pict', 'tab', 'br', 'footnoteReference', 'endnoteReference'].some(name => matches(node, name)));
      const cellFormat = tableLayouts.paragraphCells.get(paragraph);
      paragraphFormats.set(label, { css: paragraphCss(format.paragraph, paragraphSize, fontMode, warn), bold: paragraphBold, layoutCss: cellFormat ? tableParagraphLayout(format.paragraph) : undefined, cellFormat, fontSize: paragraphSize, mathFontSizes: mathSizes, mathSizeSources, index: summary.sourceParagraphs, empty });
      summary.sourceMath += mathSizes.length;
      appendStyle('paragraph', label, originalStyle);
      replaceStyle($, paragraph, 'pPr', 'pStyle', label);
      const runs = $(paragraph).find('*').toArray().filter(node => matches(node, 'r') && closestParagraph($, node) === paragraph && !$(node).parents().toArray().some(parent => matches(parent, 'oMath', MATH_NS) || matches(parent, 'oMathPara', MATH_NS)));
      for (const run of runs) {
        const runProperties = direct($, run, 'rPr');
        const originalRunStyle = val(direct($, runProperties, 'rStyle')) || styles.defaultCharacter;
        const runFormat = merge({ run: format.run }, styles.resolve(styles.defaultCharacter, 'character'), styles.resolve(originalRunStyle, 'character'), { run: readRun($, runProperties) });
        const runSize = font(runFormat.run, 'Run');
        const runBold = boldStyles.resolve(originalStyle, val(direct($, runProperties, 'rStyle')), runProperties, tableStyle).bold;
        const key = JSON.stringify([originalRunStyle, runSize, runBold]);
        let runLabel = runStyleKeys.get(key);
        if (!runLabel) {
          runLabel = `${prefix}R${String(runFormats.size + 1).padStart(6, '0')}`;
          runStyleKeys.set(key, runLabel);
          runFormats.set(runLabel, { fontSize: runSize, bold: runBold });
          appendStyle('character', runLabel, originalRunStyle);
        }
        replaceStyle($, run, 'rPr', 'rStyle', runLabel);
        summary.sourceRuns++;
      }
    }
    zip.file(entryName, serializePreservingMath($, originalXml));
  }
  zip.file('word/styles.xml', $styles.xml());
  if (!originalStyles) addStylesRelationship(zip, await zip.file('word/_rels/document.xml.rels')?.async('string'), await zip.file('[Content_Types].xml')?.async('string'));
  return { input: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), paragraphFormats, runFormats, tableFormats, fontMode, fontSize, warnings: [...warnings], summary };
}

/** Restore safe formatting by temporary identity, never by paragraph text. */
export function restoreWordFormatting(ast, prepared) {
  const paragraphStyles = new Map();
  const paragraphLayouts = new Map();
  const mathFontSizes = new Map();
  const warnings = new Set(prepared.warnings);
  const seen = new Set();
  const unwrapped = Symbol('unwrapped');
  const marker = (attributes, lookup) => {
    if (!Array.isArray(attributes)) return;
    const name = attributes[2]?.find(([key]) => key === 'custom-style')?.[1];
    return lookup.has(name) ? name : attributes[1]?.find(name => lookup.has(name));
  };
  const addStyle = (attributes, css) => {
    const retained = attributes[2].filter(([name]) => name !== 'custom-style' && name !== 'style');
    const existing = attributes[2].find(([name]) => name === 'style')?.[1];
    if (existing || css) retained.push(['style', [existing, css].filter(Boolean).join(';')]);
    attributes[2] = retained;
  };
  const restoredTables = restoreWordTables(ast, prepared, marker, message => warnings.add(message));
  function countMath(value) {
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + countMath(item), 0);
    if (!value || typeof value !== 'object' || value.t === 'Note') return 0;
    if (value.t === 'Math') return 1;
    if (value.t === 'Div' && marker(value.c[0], prepared.paragraphFormats) || value.t === 'Header' && marker(value.c[1], prepared.paragraphFormats)) return 0;
    return Object.values(value).reduce((sum, child) => sum + countMath(child), 0);
  }
  function context(label, content) {
    const format = prepared.paragraphFormats.get(label);
    const mismatch = countMath(content) !== format.mathFontSizes.length;
    if (mismatch) warnings.add('部分 Word 公式与段落中的公式数量不一致，该段所有公式使用段落字号，未按位置猜测字号。');
    return { format, cursor: 0, label, mismatch };
  }
  function finish(scope) {
    seen.add(scope.label);
    if (scope.cursor !== scope.format.mathFontSizes.length) warnings.add('部分 Word 公式无法按段落身份精确对应字号，只恢复已确认的对应关系。');
  }
  function visit(value, scope) {
    if (Array.isArray(value)) return value.flatMap(item => { const restored = visit(item, scope); return restored?.[unwrapped] ? restored.nodes : [restored]; });
    if (!value || typeof value !== 'object') return value;
    if (value.t === 'Div') {
      const label = marker(value.c[0], prepared.paragraphFormats);
      if (label) {
        const inner = context(label, value.c[1]);
        const nodes = visit(value.c[1], inner);
        finish(inner);
        return { [unwrapped]: true, nodes };
      }
    }
    if (value.t === 'Header') {
      const label = marker(value.c[1], prepared.paragraphFormats);
      if (label) {
        const inner = context(label, value.c[2]);
        value.c[1][1] = value.c[1][1].filter(name => !prepared.paragraphFormats.has(name));
        addStyle(value.c[1], [inner.format.css, `font-weight:${inner.format.bold ? 'bold' : 'normal'}`, inner.format.layoutCss ? `margin:0px;${inner.format.layoutCss}` : undefined].filter(Boolean).join(';'));
        value.c[2] = visit(value.c[2], inner);
        finish(inner);
        return value;
      }
    }
    if (value.t === 'Span') {
      const label = marker(value.c[0], prepared.runFormats);
      if (label) {
        const firstMath = scope?.cursor || 0;
        const nodes = visit(value.c[1], scope);
        if (nodes.some(node => node.t === 'Math') && nodes.every(node => ['Math', 'Space', 'SoftBreak'].includes(node.t))) {
          for (const [index, math] of nodes.filter(node => node.t === 'Math').entries()) {
            if (!scope || !['control', 'run'].includes(scope.format.mathSizeSources?.[firstMath + index])) mathFontSizes.set(math, scope?.mismatch ? scope.format.fontSize : prepared.runFormats.get(label).fontSize);
          }
          return { [unwrapped]: true, nodes };
        }
        const format = prepared.runFormats.get(label);
        const css = [prepared.fontMode === 'word' ? `font-size:${cssNumber(format.fontSize)}px` : undefined,
          `font-weight:${format.bold ? 'bold' : 'normal'}`].filter(Boolean).join(';');
        value.c = [['', [], [['style', css]]], nodes];
        // The explicit inner weight also wins when host styles alter strong/heading defaults.
        return format.bold ? { t: 'Strong', c: [value] } : value;
      }
    }
    if (value.t === 'Math') {
      const size = prepared.fontMode === 'uniform' ? prepared.fontSize : scope?.mismatch ? scope.format.fontSize : scope?.format.mathFontSizes[scope.cursor] ?? scope?.format.fontSize ?? prepared.fontSize;
      if (scope) scope.cursor++;
      else if (prepared.fontMode === 'word') warnings.add('部分公式没有可确认的 Word 段落身份，使用所选回退字号。');
      mathFontSizes.set(value, size);
      return value;
    }
    if ((value.t === 'Para' || value.t === 'Plain') && scope) {
      paragraphStyles.set(value, scope.format.css);
      if (scope.format.layoutCss) paragraphLayouts.set(value, scope.format.layoutCss);
    }
    // Only normalize reader-inferred emphasis in paragraphs whose source identity is known.
    if (value.t === 'Strong' && scope) return { [unwrapped]: true, nodes: visit(value.c, scope) };
    // Footnote blocks have their own paragraph identities, not the enclosing text's math order.
    for (const key of Object.keys(value)) value[key] = visit(value[key], value.t === 'Note' ? undefined : scope);
    if (value.t === 'Span' && value.c[1].some(node => node.t === 'Math') && value.c[1].every(node => ['Math', 'Space', 'SoftBreak'].includes(node.t))) return { [unwrapped]: true, nodes: value.c[1] };
    return value;
  }
  ast.blocks = visit(ast.blocks, undefined);
  const missing = [...prepared.paragraphFormats].filter(([label]) => !seen.has(label));
  const unmatched = missing.filter(([, format]) => !format.empty).length;
  if (unmatched) warnings.add(`${unmatched} 段 Word 格式在转换结果中没有可确认的身份；未将其格式套用到其他内容。`);
  return { paragraphStyles, paragraphLayouts, mathFontSizes, warnings: [...warnings], summary: { ...prepared.summary, restoredTables, sourceTables: prepared.tableFormats.size, restoredParagraphs: paragraphStyles.size, restoredMath: mathFontSizes.size, unmatchedParagraphs: unmatched, unmatchedEmptyParagraphs: missing.length - unmatched, generatedRunStyles: prepared.runFormats.size } };
}
