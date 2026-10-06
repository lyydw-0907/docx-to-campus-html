export const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const localName = name => name?.split(':').at(-1);
export function namespace(node, qualifiedName, attribute = false) {
  const prefix = qualifiedName?.includes(':') ? qualifiedName.split(':')[0] : '';
  if (!prefix && attribute) return;
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
    const declared = ancestor.attribs?.[prefix ? `xmlns:${prefix}` : 'xmlns'];
    if (declared) return declared;
  }
}
export const matches = (node, name, ns = WORD_NS) => localName(node?.name) === name && namespace(node, node.name) === ns;
export const elements = ($, name, ns = WORD_NS) => $('*').toArray().filter(node => matches(node, name, ns));
export const direct = ($, node, name, ns = WORD_NS) => $(node).children().toArray().find(child => matches(child, name, ns));
export const attribute = (node, name) => Object.entries(node?.attribs || {}).find(([key]) => localName(key) === name && namespace(node, key, true) === WORD_NS)?.[1];
export const val = node => attribute(node, 'val');
export const closestParagraph = ($, node) => $(node).parents().toArray().find(parent => matches(parent, 'p'));
