import { load as loadSlim } from 'cheerio/slim';
import { parse, parseFragment, serialize, serializeOuter } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

/** Parse inert HTML with the browser's MathML namespace rules, never a DOM. */
export function load(html, options = null, isDocument = true) {
  if (options?.xmlMode || options?._useHtmlParser2 || typeof html !== 'string') return loadSlim(html, options, isDocument);
  const parseOptions = { treeAdapter: adapter, scriptingEnabled: options?.scriptingEnabled ?? false,
    sourceCodeLocationInfo: Boolean(options?.withStartIndices || options?.withEndIndices || options?.sourceCodeLocationInfo) };
  const document = isDocument ? parse(html, parseOptions) : parseFragment(html, parseOptions);
  if (options?.withStartIndices || options?.withEndIndices) {
    const stack = [document];
    while (stack.length) {
      const node = stack.pop();
      if (options.withStartIndices) node.startIndex = node.sourceCodeLocation?.startOffset ?? null;
      if (options.withEndIndices) node.endIndex = node.sourceCodeLocation ? node.sourceCodeLocation.endOffset - 1 : null;
      stack.push(...(node.children || []));
    }
  }
  const $ = loadSlim(document, options, isDocument);
  // Use the same inert parser for markup inserted by Cheerio manipulation.
  const slimParse = $.fn._parse;
  $.fn._parse = function (content, parseSettings, documentMode, context) {
    if (typeof content !== 'string' || parseSettings?.xmlMode) return slimParse.call(this, content, parseSettings, documentMode, context);
    return documentMode ? parse(content, parseOptions) : parseFragment(context || null, content, parseOptions);
  };
  // Slim's default serializer loses foreign-content attribute capitalization.
  const render = nodes => Array.from(nodes).map(node => node.type === 'root'
    ? serialize(node, { treeAdapter: adapter }) : serializeOuter(node, { treeAdapter: adapter })).join('');
  $.fn._render = render;
  $.html = nodes => {
    if (nodes === undefined) return render([$.root()[0]]);
    const selection = typeof nodes === 'string' ? $(nodes).toArray() : nodes.type ? [nodes] : Array.from(nodes);
    return render(selection);
  };
  return $;
}
