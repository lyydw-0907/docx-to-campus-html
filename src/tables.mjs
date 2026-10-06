const BORDER_PROPERTY = /^border(?:$|-)/;
const KEEP_BORDER_LAYOUT = new Set(['border-collapse', 'border-spacing']);

function stylesOf(value) {
  const styles = new Map();
  for (const declaration of String(value ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase();
    const content = declaration.slice(colon + 1).trim();
    if (key && content) styles.set(key, content);
  }
  return styles;
}

function putStyles($, element, changes, { clearBorders = false, appendOverrides = false } = {}) {
  const styles = stylesOf($(element).attr('style'));
  if (clearBorders) {
    for (const name of styles.keys()) {
      if (BORDER_PROPERTY.test(name) && !KEEP_BORDER_LAYOUT.has(name)) styles.delete(name);
    }
  }
  for (const [name, value] of Object.entries(changes)) {
    // Reset longhands after any source shorthand so the intended override wins.
    if (appendOverrides) styles.delete(name);
    styles.set(name, value);
  }
  $(element).attr('style', [...styles].map(([name, value]) => `${name}:${value}`).join(';'));
}

function owned($, table, selector) {
  return $(table).find(selector).toArray().filter((element) => $(element).closest('table')[0] === table);
}

function rowSpanOf($, cell, rowIndex, boundaryIndex) {
  const value = Number($(cell).attr('rowspan') ?? 1);
  if (value === 0) return boundaryIndex - rowIndex + 1;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

const FIGURE_CAPTION = /^(?:图\s*\d|(?:figure|fig\.)\s*\d)/i;

/** Only image/caption content makes a table a figure layout, not merely an image somewhere inside it. */
function figureLayoutTables($) {
  const figures = new Set();
  for (const table of $('table').toArray().reverse()) {
    if (!$(table).find('img').length) continue;
    if (owned($, table, 'caption').some(caption => { const text = $(caption).text().trim(); return text && !FIGURE_CAPTION.test(text); })) continue;
    const cells = owned($, table, 'td,th');
    if (!cells.length) continue;
    let valid = true;
    for (const cell of cells) {
      const content = $(cell).clone();
      const nested = $(cell).find('table').toArray().filter(inner => $(inner).parents('table').first()[0] === table);
      if (nested.some(inner => !figures.has(inner))) { valid = false; break; }
      content.find('table,img,annotation').remove();
      // Each paragraph/caption is checked separately so a data row, label or
      // surrounding prose cannot hide behind a figure caption in another cell.
      const blocks = content.find('p,figcaption').toArray();
      for (const block of blocks) {
        const text = $(block).text().trim();
        if (text && !FIGURE_CAPTION.test(text)) { valid = false; break; }
        $(block).remove();
      }
      if (!valid) break;
      const remaining = content.text().trim();
      if (remaining && !FIGURE_CAPTION.test(remaining)) { valid = false; break; }
    }
    if (valid) figures.add(table);
  }
  return figures;
}

/** Format already-sanitized ordinary HTML tables in place; MathML matrices and exclusions are untouched. */
export function formatThreeLineTables($, { excludedTables = new Set(), horizontalRuleTables = new Set() } = {}) {
  const figureTables = figureLayoutTables($);
  for (const table of $('table').toArray()) {
    if (excludedTables.has(table)) continue;
    const rows = owned($, table, 'tr');
    const cellsAndGroups = owned($, table, 'colgroup,col,thead,tbody,tfoot,tr,th,td');
    const horizontalRules = horizontalRuleTables.has(table) ? [table, ...cellsAndGroups].map(element => [element, Object.fromEntries([...stylesOf($(element).attr('style'))].filter(([name]) => name === 'border-top' || name === 'border-bottom'))]) : [];
    for (const element of cellsAndGroups) putStyles($, element, { border: '0' }, { clearBorders: true });
    putStyles($, table, { border: '0', 'border-collapse': 'collapse' }, { clearBorders: true });
    if (figureTables.has(table)) {
      putStyles($, table, { 'margin-left': 'auto', 'margin-right': 'auto', 'text-indent': '0px' }, { appendOverrides: true });
      for (const element of owned($, table, 'td,th,p,div,caption,figcaption')) {
        putStyles($, element, { 'text-align': 'center', 'text-indent': '0px', 'margin-left': '0px', 'margin-right': '0px' }, { appendOverrides: true });
      }
      continue;
    }
    if (horizontalRules.length) {
      for (const [element, rules] of horizontalRules) putStyles($, element, rules);
      continue;
    }
    // Empty tables have no content height; two coincident rules would add an arbitrary line.
    if (!rows.length) continue;
    putStyles($, table, { 'border-top': '1.5px solid #111', 'border-bottom': '1.5px solid #111' });
    const headerRows = rows.filter((row) => $(row).closest('thead').length && $(row).closest('thead').closest('table')[0] === table);
    const explicitHeader = headerRows.length > 0;
    const boundaryIndex = explicitHeader ? rows.indexOf(headerRows.at(-1)) : 0;
    // Single rows and header-only tables use the table bottom rule as their lower boundary.
    if (boundaryIndex === rows.length - 1) continue;
    const eligibleRows = explicitHeader ? headerRows : [rows[0]];
    for (const row of eligibleRows) {
      const rowIndex = rows.indexOf(row);
      for (const cell of $(row).children('th,td').toArray()) {
        const spanEnd = rowIndex + rowSpanOf($, cell, rowIndex, boundaryIndex) - 1;
        if (spanEnd === boundaryIndex || explicitHeader && spanEnd > boundaryIndex) {
          putStyles($, cell, { 'border-bottom': '1px solid #111' });
        }
      }
    }
  }
}
