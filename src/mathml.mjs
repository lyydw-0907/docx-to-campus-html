import { load } from 'cheerio';

export const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const TAGS = new Set('math semantics annotation mrow mi mn mo mtext ms mspace mfrac msqrt mroot mstyle mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mtr mlabeledtr mtd'.split(' '));
const REMOVE_TAGS = new Set('script style annotation-xml svg foreignObject foreignobject img image iframe object embed a form input button textarea select link meta base video audio source canvas'.split(' '));
const TOKEN_TAGS = new Set(['mi', 'mn', 'mo', 'mtext', 'ms']);
const BOOLEAN = /^(?:true|false)$/;
const ALIGN = /^(?:left|center|right|top|bottom|baseline|axis)(?:\s+(?:left|center|right|top|bottom|baseline|axis))*$/;
const LENGTH = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|pc|in|cm|mm|%|width|height|depth)?$/;
const LENGTHS = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|pc|in|cm|mm|%)?(?:\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|pc|in|cm|mm|%)?)*$/;
const COLOR = /^(?:#[a-f\d]{3,8}|black|white|red|green|blue|gray|transparent)$/i;
const VARIANT = /^(?:normal|bold|italic|bold-italic|double-struck|fraktur|bold-fraktur|script|bold-script|sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace|initial|tailed|looped|stretched)$/;
const GENERAL_ATTRIBUTES = {
  mathvariant: VARIANT, mathsize: /^(?:small|normal|big|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?)$/,
  mathcolor: COLOR, mathbackground: COLOR, displaystyle: BOOLEAN, scriptlevel: /^[+-]?\d{1,2}$/,
};
const TAG_ATTRIBUTES = {
  math: { display: /^(?:inline|block)$/ },
  mo: { form: /^(?:prefix|infix|postfix)$/, fence: BOOLEAN, separator: BOOLEAN, stretchy: BOOLEAN, symmetric: BOOLEAN, largeop: BOOLEAN, movablelimits: BOOLEAN, accent: BOOLEAN, lspace: LENGTH, rspace: LENGTH, minsize: LENGTH, maxsize: /^(?:infinity|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?)$/ },
  mspace: { width: LENGTH, height: LENGTH, depth: LENGTH },
  mfrac: { linethickness: /^(?:thin|medium|thick|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?)$/, numalign: ALIGN, denomalign: ALIGN, bevelled: BOOLEAN },
  munder: { accentunder: BOOLEAN }, mover: { accent: BOOLEAN }, munderover: { accent: BOOLEAN, accentunder: BOOLEAN },
  ms: { lquote: /^.{0,64}$/s, rquote: /^.{0,64}$/s },
  mpadded: { width: LENGTH, height: LENGTH, depth: LENGTH, lspace: LENGTH, voffset: LENGTH },
  mfenced: { open: /^.{0,64}$/s, close: /^.{0,64}$/s, separators: /^.{0,64}$/s },
  menclose: { notation: /^(?:longdiv|actuarial|radical|box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike|phasorangle|madruwb)(?:\s+(?:longdiv|actuarial|radical|box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike|phasorangle|madruwb))*$/ },
  mtable: { align: /^(?:top|bottom|center|baseline|axis)(?:\s+-?\d{1,3})?$/, rowalign: ALIGN, columnalign: ALIGN, groupalign: /^[{} a-z]{1,100}$/, alignmentscope: BOOLEAN, columnwidth: /^(?:auto|fit|[\d.]+(?:em|ex|px|pt|%)?)(?:\s+(?:auto|fit|[\d.]+(?:em|ex|px|pt|%)?))*$/, width: LENGTH, rowspacing: LENGTHS, columnspacing: LENGTHS, rowlines: /^(?:none|solid|dashed)(?:\s+(?:none|solid|dashed))*$/, columnlines: /^(?:none|solid|dashed)(?:\s+(?:none|solid|dashed))*$/, frame: /^(?:none|solid|dashed)$/, framespacing: LENGTHS, equalrows: BOOLEAN, equalcolumns: BOOLEAN, side: /^(?:left|right|leftoverlap|rightoverlap)$/, minlabelspacing: LENGTH },
  mtr: { rowalign: ALIGN, columnalign: ALIGN }, mlabeledtr: { rowalign: ALIGN, columnalign: ALIGN },
  mtd: { rowalign: ALIGN, columnalign: ALIGN, rowspan: /^[1-9]\d{0,2}$/, columnspan: /^[1-9]\d{0,2}$/ },
};
const ARITY = { mfrac: 2, mroot: 2, msub: 2, msup: 2, msubsup: 3, munder: 2, mover: 2, munderover: 3 };

function fail(message) { throw new Error(`MathML 无法安全导出：${message}`); }
function cssNumber(number) { return Number(number.toFixed(3)).toString(); }

function elementPath(element, root) {
  const path = [];
  while (element !== root && element.parent) {
    const siblings = element.parent.children.filter((child) => child.type === 'tag');
    path.unshift(siblings.indexOf(element));
    element = element.parent;
  }
  return path.join('/');
}

/** Sanitize one converter-produced formula; retain TeX as text and normalize only minus operators. */
export function sanitizeMathML(html, { display = false, fontSize = 14, expectedTex } = {}) {
  if (typeof html !== 'string' || !html.trim() || html.length > 2 * 1024 * 1024) fail('数学片段为空或超过大小限制。');
  if (typeof display !== 'boolean' || !Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48) fail('公式显示模式或字号无效。');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(html)) fail('不允许 XML 实体或 DTD。');
  const $ = load(html, { xmlMode: true }, false);
  const roots = $('math');
  if (roots.length !== 1) fail('每个公式必须且只能包含一个 math 根节点。');
  const root = roots[0];
  if (root.attribs.xmlns && root.attribs.xmlns !== MATHML_NAMESPACE) fail('数学命名空间不受支持。');
  if ($(root).find('*').length > 10000) fail('数学节点过多。');
  const compatibilityChanges = [];
  const removedUnsafe = [];

  // Remove whole executable/foreign subtrees before examining mathematical layout.
  for (const element of $(root).find('*').toArray()) {
    if (!$(element).closest('math').length) continue;
    if (REMOVE_TAGS.has(element.name)) { removedUnsafe.push(element.name); $(element).remove(); }
  }
  for (const element of [root, ...$(root).find('*').toArray()]) {
    const tag = element.name;
    if (!TAGS.has(tag)) fail(`不支持数学结构 ${tag}。`);
    if (tag === 'math' && element !== root) fail('不支持嵌套 math 根节点。');
    if (tag === 'annotation') {
      if (element.attribs.encoding !== 'application/x-tex') { $(element).remove(); continue; }
      if ($(element).children().length) fail('TeX annotation 必须是纯文本。');
    }
    const attributes = { ...element.attribs };
    for (const name of Object.keys(element.attribs)) $(element).removeAttr(name);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'xmlns') {
        if (value !== MATHML_NAMESPACE) fail('数学子节点命名空间不受支持。');
        continue;
      }
      if (tag === 'annotation' && name === 'encoding') { $(element).attr('encoding', 'application/x-tex'); continue; }
      const rule = TAG_ATTRIBUTES[tag]?.[name] ?? GENERAL_ATTRIBUTES[name];
      if (rule?.test?.(value)) $(element).attr(name, value);
      if (name === 'style' && tag === 'mtd') {
        const align = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(value);
        if (align) $(element).attr('style', `text-align:${align[1].toLowerCase()}`);
      }
    }
    // Variables, text, numbers and the original annotation are never normalized.
    if ((tag === 'mo' || tag === 'mi') && !$(element).children().length) {
      const beforeText = $(element).text();
      const standaloneIdentifierMinus = tag === 'mi' && /^[−-]$/.test(beforeText.trim());
      if (tag === 'mo' && beforeText.includes('−') || standaloneIdentifierMinus) {
        const afterText = beforeText.replaceAll('−', '-');
        $(element).text(afterText);
        if (standaloneIdentifierMinus) element.name = 'mo';
        compatibilityChanges.push({ path: elementPath(element, root), beforeTag: tag, afterTag: element.name, beforeText, afterText, count: [...beforeText].filter((character) => character === '−').length, kind: 'minus-operator-normalized' });
      }
    }
  }
  function removeComments(element) {
    for (const child of [...(element.children ?? [])]) {
      if (child.type === 'comment') $(child).remove();
      else removeComments(child);
    }
  }
  removeComments(root);
  $(root).attr('xmlns', MATHML_NAMESPACE).attr('display', display ? 'block' : 'inline').attr('style', `font-size:${cssNumber(fontSize)}px;margin:0px`);

  for (const element of $(root).find('*').toArray()) {
    const children = $(element).children();
    if (ARITY[element.name] && children.length !== ARITY[element.name]) fail(`${element.name} 的子节点数量无效。`);
    if (TOKEN_TAGS.has(element.name) && children.length) fail(`${element.name} 不能包含数学子结构。`);
    if (['mtr', 'mlabeledtr'].includes(element.name) && children.toArray().some((child) => child.name !== 'mtd')) fail('矩阵行包含无效单元格。');
    if (element.name === 'mtable' && children.toArray().some((child) => !['mtr', 'mlabeledtr'].includes(child.name))) fail('矩阵包含无效行。');
  }
  const visible = $(root).find('mi,mn,mo,mtext,ms').toArray().filter((element) => !$(element).closest('annotation').length && $(element).text().trim());
  if (!visible.length) fail('没有可显示的数学内容。');
  const annotations = $(root).find('annotation[encoding="application/x-tex"]');
  if (annotations.length > 1) fail('公式包含重复 TeX annotation。');
  if (expectedTex !== undefined) {
    // Pandoc's Windows stdout translates line endings, including matrix TeX.
    // Accept only that transport change, then restore the exact AST source text.
    const normalizeEol = (value) => value.replace(/\r\n?/g, '\n');
    if (annotations.length !== 1 || normalizeEol(annotations.text()) !== normalizeEol(expectedTex)) fail('原始 TeX annotation 缺失或被改写。');
    annotations.text(expectedTex);
  }
  return { html: $.xml(root), compatibilityChanges, removedUnsafe, texAnnotation: annotations.text() };
}

/** Consume one Pandoc --mathml batch in the same order as its input Math nodes. */
export function extractMathMLBatch(html, formulas, { fontSize = 14 } = {}) {
  if (typeof html !== 'string' || !Array.isArray(formulas)) fail('数学批量结果无效。');
  const $ = load(html, { xmlMode: true }, false);
  const roots = $('math').toArray();
  if (roots.length !== formulas.length) fail(`公式数量不一致：期望 ${formulas.length} 个，写出 ${roots.length} 个。`);
  return roots.map((element, index) => sanitizeMathML($.xml(element), { display: formulas[index].display, fontSize: formulas[index].fontSize ?? fontSize, expectedTex: formulas[index].tex }));
}
