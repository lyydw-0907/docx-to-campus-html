const inconsistent = () => new Error('栏目图片与转换清单不一致，请重新转换。');

/** Resolve image scope from conversion metadata, never from request asset lists. */
export function resolveImageScope(result, sectionId) {
  if (!result || !Array.isArray(result.assets)) throw inconsistent();
  const byFilename = new Map();
  for (const asset of result.assets) {
    if (!asset || typeof asset.filename !== 'string' || !asset.filename ||
      /[\/\\\u0000-\u001f\u007f]/.test(asset.filename) || ['.', '..'].includes(asset.filename) ||
      byFilename.has(asset.filename)) throw inconsistent();
    byFilename.set(asset.filename, asset);
  }
  if (sectionId === undefined || sectionId === 'whole') {
    return { id: 'whole', section: undefined, assets: [...byFilename.values()], assetFilenames: [...byFilename.keys()] };
  }
  if (typeof sectionId !== 'string' || !sectionId) throw new Error('复制栏目标识无效，请重新选择学校栏目。');
  if (result.sections !== undefined && !Array.isArray(result.sections)) throw inconsistent();
  const sections = (result.sections || []).filter(section => section?.id === sectionId && ['field', 'unassigned'].includes(section.kind));
  if (!sections.length) throw new Error('该栏目不存在，请重新选择。');
  if (sections.length !== 1) throw inconsistent();
  const section = sections[0];
  if (!Array.isArray(section.assetFilenames)) throw inconsistent();
  const names = new Set();
  const assets = section.assetFilenames.map(name => {
    if (typeof name !== 'string' || !byFilename.has(name) || names.has(name)) throw inconsistent();
    names.add(name);
    return byFilename.get(name);
  });
  return { id: section.id, section, assets, assetFilenames: [...section.assetFilenames] };
}
