import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import JSZip from 'jszip';
import { load } from 'cheerio';
import sharp from 'sharp';
import { makeDemoDocx } from '../src/fixtures.mjs';
import { checkedPandocOutput, convertDocxInBrowser, inflateBounded, initializePandoc } from '../src/browser-convert.mjs';
import { inspectBrowserImage } from '../src/browser-images.mjs';

// Browser-specific bitmap decoding is checked in UI tests. These integration
// cases execute the actual WASM reader/writer with the same image metadata.
globalThis.createImageBitmap = async blob => {
  const data = new Uint8Array(await blob.arrayBuffer());
  const metadata = await sharp(data).metadata();
  return { width: metadata.width, height: metadata.height, close() {} };
};

const engine = initializePandoc({ wasmBinary: await readFile(new URL('../node_modules/pandoc-wasm/src/pandoc.wasm', import.meta.url)) });

test('real WASM structured warnings reach the shared core diagnostics channel', async () => {
  const pandoc = await engine;
  const output = await pandoc.convert({ from: 'markdown', to: 'html5', standalone: true }, '# Synthetic warning fixture', {});
  assert.ok(output.warnings.length > 0, 'the actual HTML writer reports its missing-title warning');
  const checked = checkedPandocOutput(output);
  assert.equal(checked.stdout, output.stdout);
  for (const warning of output.warnings) {
    assert.ok(checked.stderr.includes(warning.pretty || JSON.stringify(warning)));
  }
  assert.match(checked.stderr, /title/i);
});

test('browser WASM converts actual OMML, preserves numbering, and exports original media with stable hashes', async () => {
  await engine;
  const result = await convertDocxInBrowser(await makeDemoDocx());
  const $ = load(result.fragment);
  assert.equal($('math').length, 2);
  assert.equal($('mfrac').length, 1);
  assert.equal(result.manifest.formulas[1].number, '(1)');
  const numbered = $('td').filter((_, element) => $(element).text() === '(1)').closest('table');
  assert.match(numbered.attr('style'), /border:0/);
  assert.match(numbered.find('math').closest('td').attr('style'), /text-align:center/);
  assert.equal(result.assets.length, 1);
  const asset = result.assets[0];
  assert.equal(asset.kind, 'image');
  assert.equal(asset.filename, `image-${createHash('sha256').update(asset.data).digest('hex').slice(0, 16)}.png`);
  assert.equal($('img').attr('width'), '160');
  assert.equal($('img').attr('height'), '60');
  assert.ok($('img').attr('src').startsWith('data:image/png;base64,'));
  assert.equal(result.manifest.options.fontMode, 'word');
  assert.equal(result.manifest.options.formulaFormat, 'mathml');
});

test('browser WASM retains source paragraph and bold resets while splitting school fields', async () => {
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  const xml = await zip.file('word/document.xml').async('string');
  const text = (value, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t>${value}</w:t></w:r>`;
  const purpose = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${text('研究目的')}</w:p><w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr>${text('正文开始')}${text('粗体', '<w:b/><w:sz w:val="30"/>')}${text('正常字', '<w:b w:val="0"/>')}</w:p>`;
  const content = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${text('研究内容')}</w:p>`;
  const body = xml.replace('<w:body>', `<w:body>${purpose}`).replace('<w:tbl>', `${content}<w:tbl>`);
  zip.file('word/document.xml', body);
  const result = await convertDocxInBrowser(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const section = result.sections.find(item => item.fieldId === 'research-purpose' || item.id === 'research-purpose');
  assert.ok(section, 'the source heading maps to the school research-purpose field');
  const $ = load(section.fragment);
  assert.match(section.fragment, /text-indent:2em/);
  assert.ok($('strong,b').filter((_, element) => $(element).text() === '粗体').length);
  assert.equal($('strong,b').filter((_, element) => $(element).text().includes('正常字')).length, 0);
  assert.match(section.fragment, /font-size:20px/);
  assert.equal(result.sections.filter(item => item.kind === 'field').length, 2);
});

test('browser inflater enforces actual sizes instead of trusting ZIP directory declarations', () => {
  const original = Buffer.from(Array.from({ length: 80_000 }, (_, index) => index % 241));
  const compressed = deflateRawSync(original);
  assert.deepEqual(inflateBounded(compressed, original.length), original);
  assert.throws(() => inflateBounded(deflateRawSync(Buffer.alloc(2_000_000)), 512), /实际解压尺寸超过/);
  assert.throws(() => inflateBounded(Buffer.from([0xff, 0xff]), 512));
});

test('browser conversion rejects unsupported formulas and external Word resources explicitly', async () => {
  await assert.rejects(convertDocxInBrowser(await makeDemoDocx(), { formulaFormat: 'png' }), /只支持 MathML/);
  const zip = await JSZip.loadAsync(await makeDemoDocx());
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="danger" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/private.png" TargetMode="External"/></Relationships>');
  await assert.rejects(convertDocxInBrowser(await zip.generateAsync({ type: 'uint8array' })), /外部图片或外部资源/);
});

test('browser image inspection rejects excessive pixels before decoding and reads EXIF-oriented JPEGs', async () => {
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: 'white' } }).png().toBuffer();
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(3_000_000, 16);
  assert.throws(() => inspectBrowserImage(oversized), /4000 万/);
  const jpeg = await sharp(png).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.deepEqual(inspectBrowserImage(jpeg), { format: 'jpeg', width: 32, height: 20, orientation: 6 });
  const webp = await sharp(png).webp().toBuffer();
  assert.deepEqual(inspectBrowserImage(webp), { format: 'webp', width: 32, height: 20 });
  assert.throws(() => inspectBrowserImage(Buffer.from('<svg/>')), /只支持/);
});
