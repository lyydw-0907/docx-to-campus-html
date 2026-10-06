import { load } from 'cheerio';

const SCRIPT_TAGS = new Set(['msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover']);
const UNDER_TAGS = { msub: 'munder', msup: 'mover', msubsup: 'munderover' };
const SIDE_TAGS = { munder: 'msub', mover: 'msup', munderover: 'msubsup' };
const BIG_OPERATORS = new Set([...'∑∏∐∫∬∭∮∯∰⋂⋃⋀⋁⨀⨁⨂⨃⨄⨅⨆']);
const TRANSPARENT_BASE_TAGS = new Set(['mrow', 'mstyle']);
const TEX_NARY_OPERATORS = {
  sum: '∑', prod: '∏', coprod: '∐',
  int: '∫', iint: '∬', iiint: '∭', iiiint: '⨌',
  oint: '∮', oiint: '∯', oiiint: '∰',
  bigcap: '⋂', bigcup: '⋃', bigwedge: '⋀', bigvee: '⋁',
  bigodot: '⨀', bigoplus: '⨁', bigotimes: '⨂',
  biguplus: '⨄', bigsqcap: '⨅', bigsqcup: '⨆',
};

/** Read each original OMML formula in document order without rewriting its content. */
export function extractOMMLLayout(xml) {
  if (typeof xml !== 'string') throw new TypeError('OMML XML must be a string.');
  const $ = load(xml, { xmlMode: true }, false);
  return $('m\\:oMath').toArray().map((math) => {
    const naries = $(math).find('m\\:nary').toArray()
      .filter((node) => $(node).closest('m\\:oMath')[0] === math)
      .map((node) => {
        const properties = $(node).children('m\\:naryPr').first();
        const location = properties.children('m\\:limLoc').attr('m:val');
        return {
          // An absent/unknown character is not guessed from another formula.
          operator: properties.children('m\\:chr').attr('m:val') ?? null,
          limitLocation: ['undOvr', 'subSup'].includes(location) ? location : null,
        };
      });
    const content = $(math).children().toArray();
    const array = content.length === 1 && content[0].name === 'm:eqArr' ? content[0] : null;
    return { naries, eqArrSingleRow: Boolean(array && $(array).children('m\\:e').length === 1) };
  });
}

function scriptForOperator($, operator) {
  let base = operator;
  while (base.parent && TRANSPARENT_BASE_TAGS.has(base.parent.name)) {
    const children = $(base.parent).children().toArray();
    if (children.length !== 1 || children[0] !== base) break;
    base = base.parent;
  }
  const script = base.parent;
  return script && SCRIPT_TAGS.has(script.name) && $(script).children()[0] === base ? script : null;
}

function hasCompactContext($, operator, root) {
  // Follow inherited math-style and the automatic child rules, then apply each
  // nearer displaystyle override. An outer compact style is not irreversible.
  // MathML Core UA rules: https://www.w3.org/TR/mathml-core/#user-agent-stylesheet
  // msqrt and the first/base child of mroot change math-shift, not math-style.
  const path = [root, ...$(operator).parentsUntil(root).toArray().reverse(), operator];
  let compact = root.attribs.display !== 'block';
  for (const node of path) {
    const parent = node.parent;
    if (parent?.type === 'tag') {
      const position = $(parent).children().toArray().indexOf(node);
      if (parent.name === 'mfrac' || position > 0 && (parent.name === 'mroot' || SCRIPT_TAGS.has(parent.name) || parent.name === 'mmultiscripts')) {
        compact = true;
      }
    }
    if (node.name === 'mtable') compact = true;
    if (node.attribs?.displaystyle === 'true') compact = false;
    else if (node.attribs?.displaystyle === 'false') compact = true;
  }
  return compact;
}

/** Restore only source-confirmed n-ary limit positions; ambiguous matches remain unchanged. */
export function applyOMMLLimits(mathML, layout) {
  const unchanged = (warning) => ({ html: mathML, changes: [], warnings: warning ? [warning] : [] });
  if (typeof mathML !== 'string') throw new TypeError('MathML must be a string.');
  const naries = layout?.naries;
  if (!Array.isArray(naries) || !naries.length || !naries.some((node) => ['undOvr', 'subSup'].includes(node.limitLocation))) return unchanged();
  if (naries.some((node) => typeof node.operator !== 'string' || !node.operator)) {
    return unchanged('源 OMML 的 n-ary 运算符未明确，未恢复公式上下限位置。');
  }
  const $ = load(mathML, { xmlMode: true }, false);
  const roots = $('math').toArray();
  if (roots.length !== 1) return unchanged('MathML 根节点数量不一致，未恢复公式上下限位置。');
  const root = roots[0];
  const sourceOperators = new Set(naries.map((node) => node.operator));
  const operators = $(root).find('mo').toArray().filter((node) => {
    if ($(node).closest('annotation,annotation-xml').length) return false;
    const symbol = $(node).text();
    return BIG_OPERATORS.has(symbol) || sourceOperators.has(symbol) || node.attribs.largeop === 'true';
  });
  if (operators.length !== naries.length) {
    return unchanged(`源 OMML 与 MathML 的 n-ary 运算符数量不一致（${naries.length}/${operators.length}），未恢复公式上下限位置。`);
  }
  if (operators.some((node, index) => $(node).text() !== naries[index].operator)) {
    return unchanged('源 OMML 与 MathML 的 n-ary 运算符顺序或字符不一致，未恢复公式上下限位置。');
  }
  const plans = operators.map((operator, index) => ({ operator, script: scriptForOperator($, operator), source: naries[index], index }));
  for (const { script } of plans) {
    if (!script) continue;
    const expectedChildren = ['msubsup', 'munderover'].includes(script.name) ? 3 : 2;
    if ($(script).children().length !== expectedChildren) {
      return unchanged('MathML n-ary 上下限结构不完整，未恢复公式上下限位置。');
    }
  }
  const changes = [];
  for (const { operator, script, source, index } of plans) {
    if (!['undOvr', 'subSup'].includes(source.limitLocation)) continue;
    const beforeTag = script?.name ?? 'mo';
    const beforeMovableLimits = operator.attribs.movablelimits ?? null;
    const afterTag = source.limitLocation === 'undOvr' ? UNDER_TAGS[beforeTag] ?? beforeTag : SIDE_TAGS[beforeTag] ?? beforeTag;
    if (script && beforeTag !== afterTag) {
      script.name = afterTag;
      if (source.limitLocation === 'subSup') {
        // Accent attributes belong to under/over constructs, not side scripts.
        $(script).removeAttr('accent').removeAttr('accentunder');
      }
    }
    // Existing under/over placement in an ordinary block equation already agrees
    // with Word. Avoid changing previously verified trees without a layout need.
    if (source.limitLocation === 'undOvr' && (beforeTag !== afterTag || hasCompactContext($, operator, root))) {
      $(operator).attr('movablelimits', 'false');
    }
    const afterMovableLimits = operator.attribs.movablelimits ?? null;
    if (beforeTag !== afterTag || beforeMovableLimits !== afterMovableLimits) {
      changes.push({ kind: 'omml-limit-location-restored', naryIndex: index + 1, operator: source.operator, limitLocation: source.limitLocation, beforeTag, afterTag, beforeMovableLimits, afterMovableLimits });
    }
  }
  return { html: changes.length ? $.xml(root) : mathML, changes, warnings: [] };
}

/** Encode source-confirmed limits for TeX image rendering, leaving source TeX to the caller. */
export function applyOMMLLimitCommands(tex, layout) {
  if (typeof tex !== 'string') throw new TypeError('TeX must be a string.');
  const unchanged = (warning) => ({ tex, changes: [], warnings: warning ? [warning] : [] });
  const naries = layout?.naries;
  if (!Array.isArray(naries) || !naries.length || !naries.some((node) => ['undOvr', 'subSup'].includes(node.limitLocation))) return unchanged();
  const knownSymbols = new Set(Object.values(TEX_NARY_OPERATORS));
  if (naries.some((node) => !knownSymbols.has(node.operator))) {
    return unchanged('源 OMML 的 n-ary 运算符无法确认对应的 TeX 命令，未恢复图片公式上下限位置。');
  }
  const candidates = [];
  const commandPattern = new RegExp(`\\\\(${Object.keys(TEX_NARY_OPERATORS).join('|')})(?![A-Za-z])`, 'g');
  for (const match of tex.matchAll(commandPattern)) {
    let precedingSlashes = 0;
    for (let index = match.index - 1; index >= 0 && tex[index] === '\\'; index--) precedingSlashes++;
    // A TeX line-break/literal slash must not manufacture an operator candidate.
    if (precedingSlashes % 2) continue;
    const end = match.index + match[0].length;
    const modifier = /^(\s*)(\\(?:limits|nolimits|displaylimits))(?![A-Za-z])/.exec(tex.slice(end));
    const modifierStart = modifier ? end + modifier[1].length : end;
    const modifierEnd = modifier ? modifierStart + modifier[2].length : end;
    if (modifier && /^\s*\\(?:limits|nolimits|displaylimits)(?![A-Za-z])/.test(tex.slice(modifierEnd))) {
      return unchanged('TeX n-ary 运算符包含重复上下限命令，未恢复图片公式上下限位置。');
    }
    candidates.push({ command: match[1], operator: TEX_NARY_OPERATORS[match[1]], modifier: modifier?.[2] ?? null, modifierStart, modifierEnd });
  }
  if (candidates.length !== naries.length) {
    return unchanged(`源 OMML 与 TeX 的 n-ary 运算符数量不一致（${naries.length}/${candidates.length}），未恢复图片公式上下限位置。`);
  }
  if (candidates.some((candidate, index) => candidate.operator !== naries[index].operator)) {
    return unchanged('源 OMML 与 TeX 的 n-ary 运算符顺序或字符不一致，未恢复图片公式上下限位置。');
  }
  const replacements = [];
  const changes = [];
  candidates.forEach((candidate, index) => {
    const source = naries[index];
    if (!['undOvr', 'subSup'].includes(source.limitLocation)) return;
    const modifier = source.limitLocation === 'undOvr' ? '\\limits' : '\\nolimits';
    if (candidate.modifier === modifier) return;
    replacements.push({ start: candidate.modifierStart, end: candidate.modifierEnd, replacement: modifier });
    changes.push({ kind: 'omml-limit-command-restored', naryIndex: index + 1, operator: source.operator, limitLocation: source.limitLocation, command: candidate.command, beforeCommand: candidate.modifier, afterCommand: modifier });
  });
  let result = tex;
  for (const { start, end, replacement } of replacements.toReversed()) result = result.slice(0, start) + replacement + result.slice(end);
  return { tex: result, changes, warnings: [] };
}
