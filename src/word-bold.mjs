import { elements, direct, attribute, val } from './word-xml.mjs';

/** Resolve Word run weight before the DOCX reader loses character-style emphasis. */
export function createWordBoldResolver($, warn = () => {}) {
  const names = ['b', 'bCs', 'cs', 'rtl'];
  function properties(node) {
    const result = {};
    for (const name of names) {
      const property = direct($, node, name);
      if (!property) continue;
      const value = val(property);
      if (value === undefined || ['1', 'true', 'on'].includes(value)) result[name] = true;
      else if (['0', 'false', 'off'].includes(value)) result[name] = false;
      else warn('Word 中有无效的字重或复杂脚本开关，只恢复已确认的格式。');
    }
    return result;
  }
  const records = new Map(elements($, 'style').map(node => [attribute(node, 'styleId'), {
    type: attribute(node, 'type'), basedOn: val(direct($, node, 'basedOn')),
    default: ['1', 'true', 'on'].includes(attribute(node, 'default')),
    properties: properties(direct($, node, 'rPr')),
  }]));
  const defaults = elements($, 'docDefaults')[0];
  const initial = properties(direct($, direct($, defaults, 'rPrDefault'), 'rPr'));
  const defaultParagraph = [...records].find(([, record]) => record.type === 'paragraph' && record.default)?.[0];
  const cache = new Map();
  function inherited(id, type, trail = []) {
    if (!id) return {};
    const key = `${type}:${id}`;
    if (trail.includes(id) || trail.length >= 64) {
      warn('Word 字重样式继承存在循环或超过 64 层，只恢复可确认的格式。');
      return {};
    }
    if (cache.has(key)) return cache.get(key);
    const record = records.get(id);
    if (!record || record.type !== type) {
      warn('Word 字重样式缺失或类型不符，只恢复可确认的格式。');
      return {};
    }
    // ECMA-376 5th ed. 17.7.3: nearest explicit value within each category.
    const resolved = { ...inherited(record.basedOn, type, [...trail, id]), ...record.properties };
    cache.set(key, resolved);
    return resolved;
  }
  function resolve(paragraphStyleId, runStyleId, runProperties, tableStyleId) {
    const paragraphId = records.get(paragraphStyleId)?.type === 'paragraph' ? paragraphStyleId : defaultParagraph;
    const layers = [inherited(tableStyleId, 'table'), inherited(paragraphId, 'paragraph'), inherited(runStyleId, 'character')];
    const own = properties(runProperties);
    const result = { b: false, bCs: false, cs: false, rtl: false };
    for (const name of ['b', 'bCs']) {
      const baseline = initial[name] ?? false;
      result[name] = baseline;
      // Word's docDefaults=true behavior is documented in MS-OI29500's 17.7.3 note.
      for (const layer of layers) if ((layer[name] ?? baseline) !== baseline) result[name] = !result[name];
      if (own[name] !== undefined) result[name] = own[name];
    }
    for (const name of ['cs', 'rtl']) result[name] = [initial, ...layers, own].reduce((value, layer) => layer[name] ?? value, false);
    // Word MS-OE376: cs or rtl chooses complex-script weight; CJK uses b normally.
    result.bold = result.cs || result.rtl ? result.bCs : result.b;
    return result;
  }
  return { resolve };
}
