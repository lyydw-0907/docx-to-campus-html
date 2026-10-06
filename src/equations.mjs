// Pandoc leaves Word's linear #(n) notation inside Math.c[1]. Split only a
// complete marker at the outer edge of an otherwise standalone equation.
const HAS_HASH = /\\#|[#＃]/;
const TEX_SPACE = /\\[ \t]/g;

function simpleText(nodes) {
  if (!Array.isArray(nodes)) return null;
  let text = '';
  for (const node of nodes) {
    if (!node || typeof node !== 'object') return null;
    if (node.t === 'Str' && typeof node.c === 'string') text += node.c;
    else if (['Space', 'SoftBreak', 'LineBreak'].includes(node.t)) text += ' ';
    else if (['Strong', 'Emph'].includes(node.t)) {
      const nested = simpleText(node.c);
      if (nested === null) return null;
      text += nested;
    } else if (node.t === 'Span') {
      const nested = simpleText(node.c?.[1]);
      if (nested === null) return null;
      text += nested;
    } else return null;
  }
  return text;
}

function plainNumber(text) {
  const normalized = text.normalize('NFKC');
  return /^(?:\(\s*\d+(?:[.-]\d+)*\s*\)|\d+(?:[.-]\d+)*)$/.test(normalized) ? text : null;
}

function markedNumber(text) {
  const match = /^[#＃]\s*(.+)$/.exec(text.trim());
  if (!match) return null;
  const number = match[1].trim();
  return /^\(\s*\d+(?:[.-]\d+)*\s*\)$/.test(number.normalize('NFKC')) ? number : null;
}

// Return each outer marker's source offset. Braces delimit commands such as
// \text; environments delimit arrays, including numbered rows of an eqArr.
function outerMarkers(tex) {
  const positions = [];
  const environments = [];
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < tex.length; index++) {
    const character = tex[index];
    if (character === '\\') {
      const command = /^\\([A-Za-z]+)/.exec(tex.slice(index));
      if (command && ['begin', 'end'].includes(command[1])) {
        const declaration = /^\\(begin|end)\s*\{([^{}]+)\}/.exec(tex.slice(index));
        if (!declaration) return null;
        if (declaration[1] === 'begin') environments.push(declaration[2]);
        else if (environments.pop() !== declaration[2]) return null;
        index += declaration[0].length - 1;
      } else if (command) index += command[0].length - 1;
      else {
        if (tex[index + 1] === '#' && braces === 0 && environments.length === 0 && brackets === 0) positions.push(index);
        // A top-level line break is a multi-line expression, not one numbered
        // equation. Array row separators are allowed inside their environment.
        if (tex[index + 1] === '\\' && braces === 0 && environments.length === 0) return null;
        index++;
      }
      continue;
    }
    if (character === '{') braces++;
    else if (character === '}') { if (--braces < 0) return null; }
    else if (braces === 0 && environments.length === 0) {
      if ('(['.includes(character)) brackets++;
      else if (')]'.includes(character)) { if (--brackets < 0) return null; }
      else if (character === '＃' && brackets === 0) positions.push(index);
    }
  }
  return braces === 0 && brackets === 0 && environments.length === 0 ? positions : null;
}

function completeBody(tex) {
  const body = tex.replace(/(?:\s|\\[ \t])+$/g, '');
  if (!body || HAS_HASH.test(body)) return null;
  // Do not turn a mathematical operand such as f(x)=#(2) into an empty RHS.
  if (/[=+\-*/<>≤≥≠≈×÷∼≃≅∝⊕⊗⊙⊖⊘∧∨∩∪⊂⊃⊆⊇∈∉≺≻≼≽&|,:;^_([{]$/.test(body)) return null;
  if (/\\(?:cdot|times|div|pm|mp|le|leq|ge|geq|ne|neq|approx|equiv|sim|simeq|cong|propto|asymp|doteq|otimes|oplus|odot|ominus|oslash|in|notin|subset|supset|subseteq|supseteq|prec|succ|preceq|succeq|to|rightarrow|leftarrow|mapsto|land|lor|wedge|vee|cup|cap)$/.test(body)) return null;
  return body;
}

function mathTail(tex) {
  const markers = outerMarkers(tex);
  if (!markers || markers.length !== 1) return null;
  const position = markers[0];
  const markerLength = tex[position] === '\\' ? 2 : 1;
  const number = markedNumber('#' + tex.slice(position + markerLength).replace(TEX_SPACE, ' '));
  const renderTex = completeBody(tex.slice(0, position));
  return number && renderTex ? { number, renderTex } : null;
}

function singleRowArrayBody(tex) {
  // Word's right-aligned equation array can be just one mathematical row.
  // Pandoc retains that wrapper around a linear #(n) marker. Unwrap only this
  // exact one-column shape; real matrices and multi-line arrays stay intact.
  const wrapper = /^\s*\\begin\{array\}\{r\}\s*([\s\S]*?)\s*\\end\{array\}\s*$/.exec(tex);
  if (!wrapper) return null;
  const body = wrapper[1].trim();
  if (/\\(?:begin|end)\b/.test(body)) return null;
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '\\') {
      const command = /^\\[A-Za-z]+/.exec(body.slice(index));
      index += command ? command[0].length - 1 : 1;
    } else if (body[index] === '&') return null;
  }
  return body;
}

function singleRowArrayTail(tex) {
  // mathTail rejects row separators, repeated markers and incomplete operands.
  const body = singleRowArrayBody(tex);
  const tail = body ? mathTail(body) : null;
  return tail ? { ...tail, wrapperRemoved: 'single-row-array' } : null;
}

/** Remove a source-confirmed Word layout marker, never invent a missing number. */
export function cleanIncompleteEquationMarker(tex, layout) {
  if (!layout?.eqArrSingleRow || typeof tex !== 'string') return null;
  const body = singleRowArrayBody(tex);
  if (!body) return null;
  const markers = outerMarkers(body);
  if (!markers || markers.length !== 1) return null;
  const position = markers[0];
  const suffix = body.slice(position).replace(TEX_SPACE, ' ').trim();
  if (!['\\#', '＃'].includes(suffix)) return null;
  const renderTex = completeBody(body.slice(0, position));
  // A terminating full stop plus a bare marker in a single Word eqArr is
  // formatting residue. An ordinary hash operand or a partial label is kept.
  if (!renderTex || !/[.。]$/.test(renderTex)) return null;
  return { renderTex, wrapperRemoved: 'single-row-array', kind: 'incomplete-word-number-marker-removed' };
}

/**
 * Return a layout plan without changing Pandoc's source AST. An InlineMath is
 * promoted only when it is alone and has an explicit, complete #(n) marker.
 */
export function analyzeEquationParagraph(inlines) {
  if (!Array.isArray(inlines)) return null;
  const mathNodes = inlines.filter(node => node?.t === 'Math');
  if (mathNodes.length !== 1) return null;
  const math = mathNodes[0];
  const mode = math.c?.[0]?.t;
  const tex = math.c?.[1];
  if (!['DisplayMath', 'InlineMath'].includes(mode) || typeof tex !== 'string' || !tex.trim()) return null;
  const text = simpleText(inlines.filter(node => node !== math));
  if (text === null) return null;
  const rest = text.trim();
  const tail = mathTail(tex) ?? singleRowArrayTail(tex);
  if (tail) {
    if (rest) return null; // Repeated or conflicting outside labels are ambiguous.
    return { math, number: tail.number, renderTex: tail.renderTex, display: true, markerSource: 'math-tail', ...(tail.wrapperRemoved ? { wrapperRemoved: tail.wrapperRemoved } : {}) };
  }
  if (HAS_HASH.test(tex)) return null;
  if (!rest) return mode === 'DisplayMath' ? { math, number: '', renderTex: tex, display: true } : null;
  const hashNumber = markedNumber(rest);
  const number = hashNumber ?? (mode === 'DisplayMath' ? plainNumber(rest) : null);
  if (number === null) return null;
  if (hashNumber && !completeBody(tex)) return null;
  return { math, number, renderTex: tex, display: true, markerSource: 'paragraph-text' };
}

/** Identify an isolated formula for paragraph alignment, without changing its math mode or content. */
export function analyzeStandaloneMathParagraph(inlines) {
  if (!Array.isArray(inlines)) return null;
  let math;
  function inspect(nodes, depth = 0) {
    if (!Array.isArray(nodes) || depth > 64) return false;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') return false;
      if (node.t === 'Math') {
        if (math || !['InlineMath', 'DisplayMath'].includes(node.c?.[0]?.t) || typeof node.c?.[1] !== 'string' || !node.c[1].trim()) return false;
        math = node;
      } else if (node.t === 'Str' && typeof node.c === 'string') {
        // Leading punctuation and any prose/number label are not an isolated formula.
        if (!(math ? /^[\s.,;，。；]*$/u : /^\s*$/u).test(node.c)) return false;
      } else if (['Space', 'SoftBreak', 'LineBreak'].includes(node.t)) continue;
      else if (node.t === 'Span') { if (!inspect(node.c?.[1], depth + 1)) return false; }
      else if (['Strong', 'Emph'].includes(node.t)) { if (!inspect(node.c, depth + 1)) return false; }
      else return false;
    }
    return true;
  }
  return inspect(inlines) && math ? { math } : null;
}
