import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { createWordBoldResolver } from '../src/word-bold.mjs';

const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const style = (id, type, props = '', base = '', extra = '') => `<w:style w:type="${type}" w:styleId="${id}" ${extra}><w:name w:val="${id}"/>${base ? `<w:basedOn w:val="${base}"/>` : ''}<w:rPr>${props}</w:rPr></w:style>`;
const make = (body, defaults = '') => load(`<w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr>${defaults}</w:rPr></w:rPrDefault></w:docDefaults>${style('Normal', 'paragraph', '', '', 'w:default="1"')}${body}</w:styles>`, { xmlMode: true });
const direct = xml => load(`<w:rPr xmlns:w="${ns}">${xml}</w:rPr>`, { xmlMode: true }).root().children()[0];

test('Word bold inheritance uses the nearest value per style category, then combines categories', () => {
  const resolver = createWordBoldResolver(make(style('Base', 'paragraph', '<w:b/>') + style('Child', 'paragraph', '<w:b/>', 'Base')
    + style('NormalChild', 'paragraph', '<w:b w:val="0"/>', 'Base') + style('Inherited', 'paragraph', '', 'Base') + style('Strong', 'character', '<w:b/>')));
  assert.equal(resolver.resolve('Child').bold, true, 'A repeated bold in the same chain is not a second toggle');
  assert.equal(resolver.resolve('NormalChild').bold, false, 'Explicit false hides the parent bold');
  assert.equal(resolver.resolve('Inherited').bold, true);
  assert.equal(resolver.resolve('Base', 'Strong').bold, false, 'Paragraph and character categories toggle each other');
  assert.equal(resolver.resolve('Normal', 'Strong').bold, true);
});

test('direct source run bold overrides inherited style values and supports OnOff lexical forms', () => {
  const resolver = createWordBoldResolver(make(style('Bold', 'paragraph', '<w:b/>')));
  for (const value of ['0', 'false', 'off']) assert.equal(resolver.resolve('Bold', undefined, direct(`<w:b w:val="${value}"/>`)).bold, false);
  for (const value of ['1', 'true', 'on']) assert.equal(resolver.resolve('Normal', undefined, direct(`<w:b w:val="${value}"/>`)).bold, true);
  assert.equal(resolver.resolve('Normal', undefined, direct('<w:b/>')).bold, true);
  assert.equal(resolver.resolve('Bold', undefined, direct('<w:b w:val="0"/><w:bCs/>')).bold, false);
});

test('default character styles never affect runs that have no selected valid rStyle', () => {
  const resolver = createWordBoldResolver(make(style('DefaultCharacter', 'character', '<w:b/>', '', 'w:default="1"')));
  assert.equal(resolver.resolve('Normal').bold, false);
  assert.equal(resolver.resolve('Normal', 'missing').bold, false);
  assert.equal(resolver.resolve('Normal', 'DefaultCharacter').bold, true);
});

test('Word document-default bold treats explicit false category values relative to the default', () => {
  const resolver = createWordBoldResolver(make(style('NotBold', 'paragraph', '<w:b w:val="false"/>')
    + style('CharNotBold', 'character', '<w:b w:val="false"/>') + style('Bold', 'paragraph', '<w:b/>'), '<w:b/>'));
  assert.equal(resolver.resolve('Normal').bold, true);
  assert.equal(resolver.resolve('NotBold').bold, false);
  assert.equal(resolver.resolve('NotBold', 'CharNotBold').bold, true);
  assert.equal(resolver.resolve('Bold').bold, true);
  assert.equal(resolver.resolve('NotBold', 'CharNotBold', direct('<w:b w:val="off"/>')).bold, false);
});

test('Chinese and Latin use b while effective cs or rtl selects independent bCs', () => {
  const resolver = createWordBoldResolver(make(style('Complex', 'paragraph', '<w:cs/><w:bCs/>')));
  const settings = direct('<w:b w:val="false"/><w:bCs/>');
  assert.equal(resolver.resolve('Normal', undefined, settings).bold, false);
  assert.equal(resolver.resolve('Normal', undefined, direct('<w:b w:val="false"/><w:bCs/><w:cs/>')).bold, true);
  assert.equal(resolver.resolve('Normal', undefined, direct('<w:b w:val="false"/><w:bCs/><w:rtl/>')).bold, true);
  assert.equal(resolver.resolve('Complex', undefined, direct('<w:cs w:val="0"/>')).bold, false);
  assert.equal(resolver.resolve('Complex', undefined, direct('<w:cs w:val="0"/><w:rtl/>')).bold, true);
});

test('unconditional table bold participates once and direct formatting still wins', () => {
  const resolver = createWordBoldResolver(make(style('Table', 'table', '<w:b/>') + style('Bold', 'paragraph', '<w:b/>')));
  assert.equal(resolver.resolve('Normal', undefined, undefined, 'Table').bold, true);
  assert.equal(resolver.resolve('Bold', undefined, undefined, 'Table').bold, false);
  assert.equal(resolver.resolve('Bold', undefined, direct('<w:b/>'), 'Table').bold, true);
});

test('namespace aliases, invalid values and cyclic inheritance keep confirmed values without inventing bold', () => {
  const warnings = [];
  const xml = make(style('Base', 'paragraph', '<w:b/>') + style('Invalid', 'paragraph', '<w:b w:val="maybe"/>', 'Base')
    + style('CycleA', 'paragraph', '', 'CycleB') + style('CycleB', 'paragraph', '', 'CycleA')).xml().replaceAll('w:', 'q:').replace('xmlns:w=', 'xmlns:q=');
  const resolver = createWordBoldResolver(load(xml, { xmlMode: true }), warning => warnings.push(warning));
  assert.equal(resolver.resolve('Invalid').bold, true);
  assert.equal(resolver.resolve('CycleA').bold, false);
  assert.ok(warnings.some(warning => /无效/.test(warning)));
  assert.ok(warnings.some(warning => /循环/.test(warning)));
});
