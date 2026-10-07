/** Selection and mapped-copy state, independent of browser rendering. */
export function sectionDisplayTitle(section) {
  return section?.id === 'progress-check' ? '项目进展检查' : section?.title ?? '';
}

export function createSectionView() {
  let current;
  let mapped;
  const mappedSections = new Map();
  const originals = new Map();
  const contentById = new Map();
  let selectedId = 'whole';
  let revision = 0;
  const sections = () => current?.sections ?? [];
  const hasContent = fragment => /<(?:img|math|table|hr)\b/i.test(fragment)
    || fragment.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|#160);/g, ' ').trim().length > 0;
  function setResult(result) {
    current = result;
    mapped = undefined;
    mappedSections.clear(); originals.clear(); contentById.clear();
    if (current) {
      for (const section of sections()) originals.set(section.id, section);
      originals.set('whole', {
        id: 'whole', title: '整篇文档', kind: 'whole', fragment: current.fragment, preview: current.preview,
        assetFilenames: current.assets.map(asset => asset.filename),
        formulaCount: current.manifest.formulas?.length ?? 0,
        imageCount: current.assets.filter(asset => asset.kind !== 'formula').length,
      });
      for (const [id, original] of originals) contentById.set(id, hasContent(original.fragment));
    }
    selectedId = sections().find(section => section.kind === 'field')?.id ?? 'whole';
    revision++;
  }
  function items() {
    if (!current) return [];
    return [...sections(), { id: 'whole', title: '整篇文档', kind: 'whole' }];
  }
  function select(id) {
    if (!items().some(item => item.id === id)) throw new Error('该栏目不存在，请重新转换。');
    if (selectedId !== id) { selectedId = id; revision++; }
  }
  function setMapped(result) {
    if (!current || !result || typeof result.fragment !== 'string') throw new Error('图片映射结果无效。');
    const originalSections = sections();
    const updated = result.sections ?? [];
    if (originalSections.length !== updated.length || originalSections.some((section, index) =>
      section.id !== updated[index]?.id || section.kind !== updated[index]?.kind
      || section.title !== updated[index]?.title
      || JSON.stringify(section.assetFilenames) !== JSON.stringify(updated[index]?.assetFilenames))) {
      throw new Error('图片映射后的栏目与原转换不一致，请重新操作。');
    }
    mapped = result;
    mappedSections.clear();
  }
  function setMappedSection(section) {
    if (!current || !section || typeof section.fragment !== 'string') throw new Error('图片映射结果无效。');
    const original = originals.get(section.id);
    if (!original
      || original.title !== section.title || original.kind !== section.kind
      || !Array.isArray(section.assetFilenames)
      || JSON.stringify(original.assetFilenames) !== JSON.stringify(section.assetFilenames)) {
      throw new Error('图片映射后的栏目与原转换不一致，请重新操作。');
    }
    mappedSections.set(section.id, section);
  }
  function resetMapped() {
    if (mapped || mappedSections.size) revision++;
    mapped = undefined; mappedSections.clear();
  }
  function snapshot() {
    if (!current) return undefined;
    const whole = selectedId === 'whole';
    const original = originals.get(selectedId);
    const mappedSection = mappedSections.get(selectedId)
      ?? (whole ? mapped : mapped?.sections?.find(section => section.id === selectedId));
    const displayed = mappedSection ?? original;
    const hasImages = original.assetFilenames.length > 0;
    const needsMapping = hasImages && !mappedSection && current.manifest.options?.imageMode !== 'mapped';
    const eligible = original.kind === 'field' || original.kind === 'unassigned' || whole;
    const content = contentById.get(selectedId);
    // Keep the local image document even when copied HTML uses school upload URLs.
    return { ...original, fragment: displayed.fragment, preview: original.preview,
      needsMapping, mapped: Boolean(mappedSection), eligible: eligible && content,
      copyable: eligible && content && !needsMapping, empty: !content };
  }
  const token = () => ({ current, selectedId, revision });
  const matches = stamp => Boolean(stamp && current === stamp.current && selectedId === stamp.selectedId && revision === stamp.revision);
  return { setResult, items, select, setMapped, setMappedSection, resetMapped, snapshot, token, matches };
}
