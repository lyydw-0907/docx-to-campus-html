import { attribute, direct, elements, matches, val } from './word-xml.mjs';

const number = value => Number(value.toFixed(3)).toString();
const positive = value => /^\d+(?:\.\d+)?$/.test(value ?? '') && Number(value) > 0 && Number(value) <= 1_000_000;
const twips = value => /^\d+(?:\.\d+)?$/.test(value ?? '') && Number(value) <= 1_000_000 ? Number(value) / 15 : undefined;
const css = entries => Object.entries(entries).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}:${value}`).join(';');

function margins($, node) {
  const values = {};
  for (const side of ['top', 'right', 'bottom', 'left', 'start', 'end']) {
    const margin = direct($, node, side);
    if (margin && (!attribute(margin, 'type') || attribute(margin, 'type') === 'dxa')) values[{ start: 'left', end: 'right' }[side] || side] = attribute(margin, 'w');
  }
  return values;
}

function borders($, node) {
  const values = {};
  for (const side of ['top', 'right', 'bottom', 'left', 'start', 'end', 'insideH', 'insideV']) {
    const border = direct($, node, side);
    if (!border) continue;
    const style = val(border);
    const key = { start: 'left', end: 'right' }[side] || side;
    if (style === 'nil' || style === 'none') values[key] = '0';
    else if (style === 'single' && positive(attribute(border, 'sz')) && Number(attribute(border, 'sz')) <= 12) values[key] = `${number(Number(attribute(border, 'sz')) / 6)}px solid #111`;
    else values[key] = undefined; // Unsupported visible borders must not look borderless to classification.
  }
  return values;
}

export function readTableProperties($, node) {
  if (!node) return {};
  const width = direct($, node, 'tblW');
  const alignment = val(direct($, node, 'jc'));
  return {
    ...(width ? { width: { value: attribute(width, 'w'), type: attribute(width, 'type') } } : {}),
    ...(alignment ? { alignment } : {}),
    margins: margins($, direct($, node, 'tblCellMar')),
    borders: borders($, direct($, node, 'tblBorders')),
  };
}

export function mergeTableProperties(...layers) {
  return layers.reduce((result, layer) => ({ ...result, ...layer, margins: { ...result.margins, ...layer?.margins }, borders: { ...result.borders, ...layer?.borders } }), {});
}

/** Source DOM identities stay local to the disposable DOCX; no document text is used as a key. */
export function collectWordTables($, styles, warn) {
  const tables = new Map(), paragraphCells = new Map();
  const nearest = (node, name) => $(node).parents().toArray().find(parent => matches(parent, name));
  for (const table of elements($, 'tbl')) {
    const properties = direct($, table, 'tblPr');
    const styleId = val(direct($, properties, 'tblStyle'));
    const format = mergeTableProperties(styles.resolve(styleId || styles.defaultTable, 'table').table, readTableProperties($, properties));
    const grid = $(direct($, table, 'tblGrid')).children().toArray().filter(node => matches(node, 'gridCol')).map(node => attribute(node, 'w'));
    const validGrid = grid.length > 0 && grid.every(positive);
    const total = validGrid ? grid.reduce((sum, value) => sum + Number(value), 0) : 0;
    let width;
    if (format.width?.type === 'dxa' && positive(format.width.value)) width = `${number(Number(format.width.value) / 15)}px`;
    else if (format.width?.type === 'pct' && positive(format.width.value) && Number(format.width.value) <= 5000) width = `${number(Number(format.width.value) / 50)}%`;
    else if ((!format.width || ['auto', 'nil'].includes(format.width.type) || format.width.type === 'dxa' && !Number(format.width.value)) && validGrid) width = `${number(total / 15)}px`;
    if (!width) width = 'auto';
    if (format.width?.value && !positive(format.width.value)) warn('Word 表格有无效宽度，未据此设置固定宽度。');
    const alignment = format.alignment === 'center' ? ['auto', 'auto'] : format.alignment === 'right' ? ['auto', '0px'] : ['0px', 'auto'];
    const record = {
      css: css({ width, 'max-width': '100%', 'margin-left': alignment[0], 'margin-right': alignment[1] }),
      columns: validGrid ? grid.map(value => Number(value) / total) : undefined,
      margins: format.margins, borders: format.borders, cells: [], rows: [],
    };
    const rows = $(table).find('*').toArray().filter(node => matches(node, 'tr') && nearest(node, 'tbl') === table);
    for (const row of rows) {
      const height = direct($, direct($, row, 'trPr'), 'trHeight');
      const rowFormat = { css: positive(attribute(height, 'val')) ? `height:${number(Number(attribute(height, 'val')) / 15)}px` : '', cells: [], gridBefore: Number(val(direct($, direct($, row, 'trPr'), 'gridBefore')) || 0) };
      record.rows.push(rowFormat);
      const cells = $(row).find('*').toArray().filter(node => matches(node, 'tc') && nearest(node, 'tr') === row && nearest(node, 'tbl') === table);
      for (const cell of cells) {
        const tcPr = direct($, cell, 'tcPr');
        const cellFormat = {
          margins: { ...format.margins, ...margins($, direct($, tcPr, 'tcMar')) },
          borders: borders($, direct($, tcPr, 'tcBorders')),
          verticalAlign: { top: 'top', center: 'middle', bottom: 'bottom' }[val(direct($, tcPr, 'vAlign'))] || 'top',
          row: rowFormat,
          colspan: positive(val(direct($, tcPr, 'gridSpan'))) ? Number(val(direct($, tcPr, 'gridSpan'))) : 1,
          merge: direct($, tcPr, 'vMerge') ? val(direct($, tcPr, 'vMerge')) || 'continue' : undefined,
          rowspan: 1,
        };
        record.cells.push(cellFormat);
        rowFormat.cells.push(cellFormat);
        for (const paragraph of $(cell).find('*').toArray().filter(node => matches(node, 'p') && nearest(node, 'tc') === cell && nearest(node, 'tbl') === table)) paragraphCells.set(paragraph, cellFormat);
      }
    }
    for (const [index, row] of record.rows.entries()) {
      let column = row.gridBefore;
      for (const cell of row.cells) {
        cell.column = column;
        column += cell.colspan;
        if (cell.merge !== 'restart') continue;
        for (const later of record.rows.slice(index + 1)) {
          let position = later.gridBefore;
          const continuation = later.cells.find(candidate => { const current = position; position += candidate.colspan; return current === cell.column; });
          if (continuation?.merge !== 'continue' || continuation.colspan !== cell.colspan) break;
          cell.rowspan++;
        }
      }
    }
    const allBorders = [record.borders, ...record.cells.map(cell => cell.borders)];
    const horizontal = allBorders.some(border => ['top', 'bottom', 'insideH'].some(side => border[side] && border[side] !== '0'));
    const noVertical = allBorders.every(border => ['left', 'right', 'start', 'end', 'insideV'].every(side => !Object.hasOwn(border, side) || border[side] === '0'));
    // Missing sides inherit the resolved table style, not an invented grid.
    // Conditional table styles cannot be classified from unconditional properties.
    record.horizontalRules = horizontal && noVertical && !format.conditional;
    tables.set(table, record);
  }
  return { tables, paragraphCells };
}

function cellCss(format, defaultMargins) {
  const margin = { ...defaultMargins, ...format?.margins };
  const values = [margin.top, margin.end ?? margin.right, margin.bottom, margin.start ?? margin.left].map((value, index) => twips(value) ?? (index % 2 ? 7.2 : 0));
  return css({ padding: values.map(value => `${number(value)}px`).join(' '), 'vertical-align': format?.verticalAlign || 'top', 'font-weight': 'normal', ...Object.fromEntries(['top', 'bottom'].filter(side => format?.borders?.[side]).map(side => [`border-${side}`, format.borders[side]])) });
}

const addStyles = (attributes, declarations) => {
  const old = attributes[2].find(([key]) => key === 'style')?.[1];
  attributes[2] = attributes[2].filter(([key]) => !['style', 'custom-style'].includes(key));
  if (old || declarations) attributes[2].push(['style', [old, declarations].filter(Boolean).join(';')]);
};

/** Table style markers identify even empty/nested tables; paragraph markers identify merged cells. */
export function restoreWordTables(ast, prepared, marker, warn) {
  let restored = 0;
  function labels(value, found = new Set()) {
    if (Array.isArray(value)) { value.forEach(child => labels(child, found)); return found; }
    if (!value || typeof value !== 'object' || ['Table', 'Note'].includes(value.t)) return found;
    const label = value.t === 'Div' ? marker(value.c[0], prepared.paragraphFormats) : value.t === 'Header' ? marker(value.c[1], prepared.paragraphFormats) : undefined;
    if (label) found.add(label);
    Object.values(value).forEach(child => labels(child, found));
    return found;
  }
  function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (value.t === 'Table') {
      const label = marker(value.c[0], prepared.tableFormats);
      const format = prepared.tableFormats.get(label);
      if (format) {
        restored++;
        value.c[0][1] = value.c[0][1].filter(name => !prepared.tableFormats.has(name));
        addStyles(value.c[0], format.css);
        if (format.horizontalRules) {
          value.c[0][2].push(['data-campus-word-horizontal', 'true']);
          addStyles(value.c[0], css(Object.fromEntries(['top', 'bottom'].filter(side => format.borders[side]).map(side => [`border-${side}`, format.borders[side]]))));
        }
        if (format.columns?.length === value.c[2].length) {
          value.c[2].forEach((column, index) => { column[1] = { t: 'ColWidth', c: format.columns[index] }; });
          value.c[0][2].push(['data-campus-word-columns', format.columns.map(value => number(value * 100)).join(',')]);
        }
        const rows = [...value.c[3][1], ...value.c[4].flatMap(body => [...body[2], ...body[3]]), ...value.c[5][1]];
        // Empty cell paragraphs can be omitted by Pandoc. Use positions only
        // inside this identified table when the complete merged grid agrees.
        const visibleCells = row => row.cells.filter(cell => cell.merge !== 'continue');
        const sameGrid = rows.length === format.rows.length && rows.every((row, index) => {
          const sources = visibleCells(format.rows[index]);
          return !format.rows[index].gridBefore && sources.length === row[1].length && row[1].every((cell, i) => sources[i].colspan === cell[3] && sources[i].rowspan === cell[2]);
        });
        for (const [rowIndex, row] of rows.entries()) {
          const rowFormats = new Set();
          for (const [cellIndex, cell] of row[1].entries()) {
            const candidates = new Set([...labels(cell[4])].map(label => prepared.paragraphFormats.get(label)?.cellFormat).filter(candidate => format.cells.includes(candidate)));
            const source = candidates.size === 1 ? [...candidates][0] : candidates.size === 0 && sameGrid ? visibleCells(format.rows[rowIndex])[cellIndex] : undefined;
            if (source) rowFormats.add(source.row);
            if (candidates.size > 1) warn('部分合并单元格的格式无法唯一对应，只使用该表的默认留白。');
            addStyles(cell[0], cellCss(source, format.margins));
            if (format.horizontalRules && format.borders.insideH && !Object.hasOwn(source?.borders || {}, 'bottom') && rowIndex + cell[2] < rows.length) addStyles(cell[0], `border-bottom:${format.borders.insideH}`);
          }
          if (rowFormats.size === 1) addStyles(row[0], [...rowFormats][0].css);
          else if (rowFormats.size === 0 && sameGrid) addStyles(row[0], format.rows[rowIndex].css);
        }
      }
    }
    Object.values(value).forEach(visit);
  }
  visit(ast.blocks);
  if (restored !== prepared.tableFormats.size) warn('部分 Word 表格缺少可确认的格式身份，未将其格式套用到其他表。');
  return restored;
}
