import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { FormulaRenderError, renderFormula } from '../src/math.mjs';

const expressions = [
  ['fraction', String.raw`\frac{a+b}{c+d}`],
  ['integral', String.raw`\int_0^1 x^2\,\mathrm{d}x`],
  ['scripts', String.raw`x_i^2 + y_{t-1}`],
  ['matrix', String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`],
];

for (const [name, tex] of expressions) {
  test(`renders ${name} as a real transparent PNG and standalone SVG`, async () => {
    const png = await renderFormula(tex);
    assert.equal(png.mime, 'image/png');
    assert.equal(png.extension, 'png');
    assert.ok(Buffer.isBuffer(png.data));
    assert.ok(png.width > 0 && png.height > 0);
    assert.ok(png.depth >= 0 && png.depth < png.height);
    assert.equal(png.tex, tex);
    assert.equal(png.display, false);
    const info = await sharp(png.data).metadata();
    assert.equal(info.width, Math.ceil(png.width * 3));
    assert.equal(info.height, Math.ceil(png.height * 3));
    assert.equal(info.hasAlpha, true);
    const pixels = await sharp(png.data).ensureAlpha().raw().toBuffer();
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0), 'nonempty formula ink');
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value === 0), 'transparent background');

    const svg = await renderFormula(tex, { format: 'svg' });
    assert.equal(svg.width, png.width);
    assert.equal(svg.height, png.height);
    assert.equal(svg.depth, png.depth);
    const xml = svg.data.toString('utf8');
    assert.match(xml, /^<svg\b/);
    assert.match(xml, /<path\b/);
    assert.doesNotMatch(xml, /<(?:text|image|use)\b|(?:xlink:)?href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    assert.doesNotMatch(xml, /(?:width|height)="[^"]*ex"|currentColor|data-mml-node="merror"/);
  });
}

test('font size scales width, height and baseline depth together', async () => {
  const tex = String.raw`\frac{x_i}{y_j}`;
  const small = await renderFormula(tex, { fontSize: 16, format: 'svg' });
  const large = await renderFormula(tex, { fontSize: 32, format: 'svg' });
  assert.ok(small.depth > 0);
  assert.equal(large.width, small.width * 2);
  assert.equal(large.height, small.height * 2);
  assert.equal(large.depth, small.depth * 2);
  const xml = small.data.toString();
  const [, y, , height] = xml.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  assert.ok(Math.abs(small.depth - (y + height) * 16 / 1000) < 1e-10);
});

test('pixel density changes the PNG dimensions without changing CSS geometry', async () => {
  const tex = String.raw`x_i^2`;
  const low = await renderFormula(tex, { scale: 1 });
  const high = await renderFormula(tex, { scale: 4 });
  assert.equal(high.width, low.width);
  assert.equal(high.height, low.height);
  assert.equal(high.depth, low.depth);
  const info = await sharp(high.data).metadata();
  assert.equal(info.width, Math.ceil(low.width * 4));
  assert.equal(info.height, Math.ceil(low.height * 4));
});

test('formula widths follow content, and display mode does not increase the font size', async () => {
  const short = await renderFormula('x', { format: 'svg' });
  const long = await renderFormula('x+x+x+x+x', { format: 'svg' });
  assert.ok(long.width > short.width * 3);
  const displayed = await renderFormula('x', { display: true, format: 'svg' });
  assert.equal(displayed.width, short.width);
  assert.equal(displayed.height, short.height);
  assert.equal(displayed.depth, short.depth);
  const inlineFraction = await renderFormula(String.raw`\frac{1}{2}`, { format: 'svg' });
  const displayFraction = await renderFormula(String.raw`\frac{1}{2}`, { display: true, format: 'svg' });
  assert.ok(displayFraction.height > inlineFraction.height, 'display fraction has standard mathematical display layout');
});

test('refuses malformed expressions, unknown commands and font-dependent glyphs', async () => {
  for (const tex of [String.raw`\frac{1}`, String.raw`\campusUndefinedCommand{x}`, String.raw`\text{中文}`]) {
    await assert.rejects(renderFormula(tex), (error) => {
      assert.ok(error instanceof FormulaRenderError);
      assert.match(error.message, /Formula could not be rendered:/);
      return true;
    });
  }
});

test('macros defined in an expression do not leak into later expressions', async () => {
  await renderFormula(String.raw`\newcommand{\campusTemp}{x}\campusTemp`);
  await assert.rejects(renderFormula(String.raw`\campusTemp`), FormulaRenderError);
  const validAfterError = await renderFormula('x+y');
  assert.ok(validAfterError.data.length > 0);
});

test('rejects invalid renderer options explicitly', async () => {
  for (const [tex, options] of [
    ['', {}], [null, {}], ['x', { fontSize: 0 }], ['x', { fontSize: NaN }],
    ['x', { scale: 0 }], ['x', { scale: Infinity }], ['x', { format: 'jpg' }],
    ['x', { display: 'yes' }],
  ]) {
    await assert.rejects(renderFormula(tex, options), FormulaRenderError);
  }
});
