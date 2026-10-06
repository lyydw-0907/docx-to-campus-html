import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import sharp from 'sharp';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

// Error-hiding and interactive packages do not belong in an exported image.
const excludedPackages = new Set(['noerrors', 'noundefined', 'html', 'action', 'unicode']);
const packages = AllPackages.filter((name) => !excludedPackages.has(name));
const MAX_TEX_LENGTH = 20_000;
const MAX_RASTER_PIXELS = 24_000_000;
const SVG_UNITS_PER_EM = 1000;

export class FormulaRenderError extends Error {
  constructor(message, options = {}) {
    super(`Formula could not be rendered: ${message}`, options);
    this.name = 'FormulaRenderError';
  }
}

function fail(message) {
  throw new FormulaRenderError(message);
}

function validateOptions(tex, { display, fontSize, scale, format }) {
  if (typeof tex !== 'string' || !tex.trim()) fail('the expression must be a nonempty TeX string.');
  if (tex.length > MAX_TEX_LENGTH) fail(`the expression exceeds ${MAX_TEX_LENGTH} characters.`);
  if (typeof display !== 'boolean') fail('display must be a boolean.');
  if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 200) {
    fail('fontSize must be a positive number no greater than 200 CSS pixels.');
  }
  if (!Number.isFinite(scale) || scale < 1 || scale > 16) {
    fail('scale must be a number between 1 and 16.');
  }
  if (!['png', 'svg'].includes(format)) fail('format must be png or svg.');
}

function checkOutput(node) {
  if (adaptor.kind(node) === '#text') return;
  const kind = adaptor.kind(node);
  if (adaptor.getAttribute(node, 'data-mml-node') === 'merror' ||
      adaptor.getAttribute(node, 'data-mjx-error')) {
    fail(adaptor.getAttribute(node, 'data-mjx-error') || 'MathJax reported a mathematical input error.');
  }
  if (kind === 'text') {
    // Missing MathJax glyphs fall back to SVG <text>, whose appearance depends
    // on installed fonts. Refuse that fallback rather than exporting a guess.
    fail('a character has no embedded MathJax glyph; font-dependent SVG text is unsupported.');
  }
  if (['image', 'foreignObject', 'script', 'a'].includes(kind) ||
      adaptor.getAttribute(node, 'href') || adaptor.getAttribute(node, 'xlink:href')) {
    fail('the expression requires interactive content or an external image reference.');
  }
  for (const child of adaptor.childNodes(node)) checkOutput(child);
}

function numberAttribute(value) {
  // Preserve geometry precision without producing long floating-point tails.
  return String(Number(value.toFixed(8)));
}

/**
 * Render one delimiter-free TeX expression as a self-contained image.
 * width, height and depth are CSS pixels. depth is the distance from the
 * text baseline to the image bottom; use vertical-align: -depth px inline.
 * scale controls PNG pixel density, never the formula's CSS font size.
 */
export async function renderFormula(tex, {
  display = false,
  fontSize = 16,
  scale = 3,
  format = 'png',
} = {}) {
  validateOptions(tex, { display, fontSize, scale, format });
  try {
    // A new parser for each expression prevents macro and equation-number
    // state from leaking between documents or independent render calls.
    const input = new TeX({
      packages,
      tags: 'none',
      maxBuffer: MAX_TEX_LENGTH,
      formatError: (_jax, error) => { throw error; },
    });
    const output = new SVG({
      fontCache: 'none',
      mtextInheritFont: false,
      merrorInheritFont: false,
    });
    const document = mathjax.document('', {
      InputJax: input,
      OutputJax: output,
      compileError: (_document, _math, error) => { throw error; },
      typesetError: (_document, _math, error) => { throw error; },
    });
    const container = document.convert(tex, {
      display,
      em: fontSize,
      ex: fontSize * output.font.params.x_height,
      containerWidth: 80 * fontSize,
      scale: 1,
    });
    checkOutput(container);
    const svg = adaptor.tags(container, 'svg')[0];
    if (!svg) fail('MathJax produced no SVG.');
    const box = (adaptor.getAttribute(svg, 'viewBox') || '').trim().split(/\s+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) {
      fail('container-dependent or empty formula geometry is unsupported.');
    }
    const [, y, boxWidth, boxHeight] = box;
    const pixelsPerUnit = fontSize / SVG_UNITS_PER_EM;
    const width = boxWidth * pixelsPerUnit;
    const height = boxHeight * pixelsPerUnit;
    const signedDepth = (y + boxHeight) * pixelsPerUnit;
    if (signedDepth < -0.001) {
      fail('a formula raised wholly above the baseline cannot use the image baseline profile.');
    }
    const depth = Math.max(0, signedDepth);

    // A file viewed outside the document must not depend on ex units, the
    // surrounding text color, or a MathJax stylesheet in the host editor.
    adaptor.setAttribute(svg, 'width', numberAttribute(width));
    adaptor.setAttribute(svg, 'height', numberAttribute(height));
    adaptor.setAttribute(svg, 'style', `vertical-align: -${numberAttribute(depth)}px;`);
    adaptor.setAttribute(svg, 'color', '#000000');
    const group = adaptor.tags(svg, 'g')[0];
    if (group) {
      adaptor.setAttribute(group, 'fill', '#000000');
      adaptor.setAttribute(group, 'stroke', '#000000');
    }
    // MathJax's array frames/lines and dashed enclosures normally obtain these
    // rules from the page stylesheet. Keep the rules inside the image itself.
    const style = adaptor.node('style', {}, [adaptor.text(
      '[data-frame],[data-line]{stroke-width:70px;fill:none}' +
      '.mjx-dashed{stroke-dasharray:140}' +
      '.mjx-dotted{stroke-linecap:round;stroke-dasharray:0,140}',
    )], 'http://www.w3.org/2000/svg');
    adaptor.append(svg, style);

    const metadata = { width, height, depth, tex, display };
    if (format === 'svg') {
      return {
        ...metadata,
        data: Buffer.from(adaptor.outerHTML(svg)),
        mime: 'image/svg+xml',
        extension: 'svg',
      };
    }

    const pixelWidth = Math.max(1, Math.ceil(width * scale));
    const pixelHeight = Math.max(1, Math.ceil(height * scale));
    if (pixelWidth * pixelHeight > MAX_RASTER_PIXELS) {
      fail(`the formula exceeds the ${MAX_RASTER_PIXELS} pixel PNG limit.`);
    }
    // Rasterize the complete original box. Do not trim: cropping would change
    // the image's baseline. Integer rounding is undone when the host applies
    // the returned floating-point CSS width and height.
    adaptor.setAttribute(svg, 'width', pixelWidth);
    adaptor.setAttribute(svg, 'height', pixelHeight);
    adaptor.setAttribute(svg, 'preserveAspectRatio', 'none');
    const data = await sharp(Buffer.from(adaptor.outerHTML(svg)), {
      density: 72,
      limitInputPixels: MAX_RASTER_PIXELS,
    }).png().toBuffer();
    return { ...metadata, data, mime: 'image/png', extension: 'png' };
  } catch (error) {
    if (error instanceof FormulaRenderError) throw error;
    throw new FormulaRenderError(error.message || String(error), { cause: error });
  }
}
