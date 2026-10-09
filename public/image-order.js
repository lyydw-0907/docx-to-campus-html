function safeUrlKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 ||
    /[\u0000-\u001f\u007f\\]/.test(value) || !/^https?:\/\//i.test(value.trim())) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch { return undefined; }
}

/** Validate complete manual or selected image URLs without requesting them. */
export function validateImageUrls(urls) {
  if (!Array.isArray(urls)) return { valid: false, message: '图片地址列表无效。' };
  if (!urls.length) return { valid: false, message: '当前没有可调整的图片。' };
  if (Array.from(urls).some(url => typeof url === 'string' && !url.trim())) {
    return { valid: false, message: '请为每张原图选择对应的学校图片。' };
  }
  const seen = new Set();
  for (const url of urls) {
    const key = safeUrlKey(url);
    if (!key) return { valid: false, message: '图片地址需要无账号密码的完整 HTTP(S) 地址。' };
    if (seen.has(key)) return { valid: false, message: '多张原图使用了同一图片地址，请调整对应关系。' };
    seen.add(key);
  }
  return { valid: true, message: '图片对应关系完整，可以确认。' };
}

/** Editable image correspondence; URLs are validated as text, never requested. */
export function createImageOrder(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('图片对应关系数据无效。');
  const { assets, images, existingUrls = {} } = options;
  const invalidAssets = !Array.isArray(assets) || Array.from(assets).some(asset => !asset ||
    typeof asset.filename !== 'string' || !asset.filename.trim() || /[\u0000-\u001f\u007f]/.test(asset.filename));
  if (invalidAssets || new Set(assets.map(asset => asset.filename)).size !== assets.length) {
    throw new Error('原图列表无效。');
  }
  if (!Array.isArray(images)) throw new Error('学校图片列表无效。');
  if (images.length !== assets.length) throw new Error('学校图片数量与原图数量不同。');
  if (!existingUrls || typeof existingUrls !== 'object' || Array.isArray(existingUrls) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(existingUrls))) {
    throw new Error('已填图片地址无效。');
  }

  const choices = new Map();
  const sourceUrls = new Map();
  for (const image of images) {
    const key = safeUrlKey(image?.url);
    if (!image || !Number.isSafeInteger(image.index) || image.index < 1 || !key ||
      choices.has(String(image.index)) || sourceUrls.has(key)) throw new Error('学校图片列表无效。');
    const value = String(image.index);
    choices.set(value, image.url.trim());
    sourceUrls.set(key, value);
  }

  const assetNames = new Set(assets.map(asset => asset.filename));
  for (const [filename, url] of Object.entries(existingUrls)) {
    if (!assetNames.has(filename) || typeof url !== 'string') throw new Error('已填图片地址无效。');
  }
  const state = assets.map(({ filename }) => {
    // Keep invalid existing values intact so validate() can explain the problem.
    const initial = Object.hasOwn(existingUrls, filename) ? existingUrls[filename] : '';
    const existingUrl = /[\u0000-\u001f\u007f\\]/.test(initial) ? initial : initial.trim();
    const selection = sourceUrls.get(safeUrlKey(existingUrl)) || (existingUrl ? 'keep' : '');
    return { filename, selection, existingUrl, keepUrl: selection === 'keep' ? existingUrl : '' };
  });
  const occupied = new Set(state.map(row => row.selection).filter(value => choices.has(value)));
  const remaining = new Set([...choices.keys()].filter(value => !occupied.has(value)));
  let fallbackReservations = 0;
  state.forEach((row, position) => {
    if (row.selection !== 'keep') return;
    // A retained manual link replaces this row's default school image. Reserve
    // that source slot so later empty rows keep their original correspondence.
    const preferred = String(images[position].index);
    if (remaining.has(preferred)) remaining.delete(preferred);
    else fallbackReservations++;
  });
  // Reserve other free slots only after every retained row has had a chance to
  // keep its original slot. Existing numeric assignments always take priority.
  for (let index = 0; index < fallbackReservations; index++) {
    const fallback = remaining.values().next().value;
    if (fallback !== undefined) remaining.delete(fallback);
  }
  const available = [...remaining];
  for (const row of state) {
    if (!row.selection) row.selection = available.shift() || '';
  }

  function selectedUrl(row) {
    return row.selection === 'keep' ? row.keepUrl : choices.get(row.selection) || '';
  }
  function rows() {
    return state.map(row => ({ ...row, url: selectedUrl(row) }));
  }
  function select(filename, value) {
    const row = state.find(candidate => candidate.filename === filename);
    if (!row) throw new Error('未找到该原图。');
    if (typeof value !== 'string' || (value !== '' && !choices.has(value) &&
      !(value === 'keep' && row.keepUrl))) throw new Error('图片选择无效。');
    if (value === row.selection) return {};
    const previous = row.selection;
    const displaced = choices.has(value) ? state.find(candidate => candidate !== row && candidate.selection === value) : undefined;
    row.selection = value;
    if (!displaced) return {};
    if (choices.has(previous)) {
      displaced.selection = previous;
      return { swappedFilename: displaced.filename };
    }
    displaced.selection = '';
    return { clearedFilename: displaced.filename };
  }
  // A shared original may be confirmed or manually edited in another field.
  // Retain that address while leaving every other tentative selection intact.
  // Like constructor existingUrls, invalid manual values stay visible so the
  // normal validation can explain them rather than silently accepting them.
  function retainMappings(mappings) {
    if (!Array.isArray(mappings) || Array.from(mappings).some(mapping => !mapping ||
      !assetNames.has(mapping.filename) || typeof mapping.url !== 'string') ||
      new Set(mappings.map(mapping => mapping.filename)).size !== mappings.length) {
      throw new Error('已填图片地址无效。');
    }
    for (const { filename, url } of mappings) {
      const row = state.find(candidate => candidate.filename === filename);
      row.existingUrl = /[\u0000-\u001f\u007f\\]/.test(url) ? url : url.trim();
      row.keepUrl = row.existingUrl;
      row.selection = row.keepUrl ? 'keep' : '';
    }
  }
  function validate() {
    const selectedRows = rows();
    const changedCount = selectedRows.filter(row => row.url !== row.existingUrl).length;
    const checked = validateImageUrls(selectedRows.map(row => row.url));
    if (!checked.valid) return { ...checked, mappings: [], changedCount };
    return {
      ...checked,
      mappings: selectedRows.map(({ filename, url }) => ({ filename, url })),
      changedCount
    };
  }
  function exportState() {
    return state.map(({ filename, selection, existingUrl, keepUrl }) => ({ filename, selection, existingUrl, keepUrl }));
  }
  function validateState(snapshot) {
    const keys = ['filename', 'selection', 'existingUrl', 'keepUrl'];
    if (!Array.isArray(snapshot) || snapshot.length !== state.length) throw new Error('已保存的图片选择无效。');
    const names = new Set();
    const occupied = new Set();
    const restored = snapshot.map(saved => {
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(saved)) ||
        Object.keys(saved).length !== keys.length || keys.some(key => !Object.hasOwn(saved, key)) ||
        typeof saved.filename !== 'string' || !assetNames.has(saved.filename) || names.has(saved.filename) ||
        typeof saved.selection !== 'string' || typeof saved.existingUrl !== 'string' || saved.existingUrl.length > 4096 ||
        typeof saved.keepUrl !== 'string' || saved.keepUrl.length > 4096 ||
        saved.keepUrl && saved.keepUrl !== saved.existingUrl ||
        saved.selection !== '' && !choices.has(saved.selection) && !(saved.selection === 'keep' && saved.keepUrl)) {
        throw new Error('已保存的图片选择无效。');
      }
      names.add(saved.filename);
      if (choices.has(saved.selection)) {
        if (occupied.has(saved.selection)) throw new Error('已保存的图片选择重复。');
        occupied.add(saved.selection);
      }
      return { filename: saved.filename, selection: saved.selection, existingUrl: saved.existingUrl, keepUrl: saved.keepUrl };
    });
    const byFilename = new Map(restored.map(row => [row.filename, row]));
    return assets.map(asset => byFilename.get(asset.filename));
  }
  function restoreState(snapshot) {
    const restored = validateState(snapshot);
    state.splice(0, state.length, ...restored);
  }
  return { rows, select, retainMappings, validate, exportState, validateState, restoreState };
}
