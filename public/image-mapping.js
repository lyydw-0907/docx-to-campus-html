import { createImageOrder, validateImageUrls } from '/image-order.js';

/** Paste-to-map workflow. Imported HTML and school images are never rendered. */
export function createImageMapping({ getCurrent, assetInputs, byId, json, download, status, showMappedSource, resetMappedSource, requestJob,
  getCopyContext, isCopyContextCurrent, getCopyState, copySelectedSource }) {
  let revision = 0;
  const orders = new Map();
  const sources = new Map();
  let displayedScope;
  let displayedCurrent;
  let mappingRequest;
  let importRequest;
  const message = (text, error = false) => {
    byId('mapping-message').textContent = text;
    byId('mapping-message').classList.toggle('error', error);
  };
  const scopedAssets = selected => {
    const current = getCurrent();
    if (!current || !selected) return [];
    const names = new Set(selected.assetFilenames);
    return current.assets.filter(asset => names.has(asset.filename));
  };
  const filledCount = assets => assets.filter(asset => assetInputs.get(asset.filename)?.value.trim()).length;
  const addressesValid = assets => assets.length > 0 && validateImageUrls(assets.map(asset => assetInputs.get(asset.filename)?.value)).valid;
  const existingUrls = assets => Object.fromEntries(assets.map(asset => [asset.filename, assetInputs.get(asset.filename)?.value.trim() || '']));
  const orderIsCurrent = state => state.current === getCurrent() && orders.get(state.scopeId) === state;
  const hasUnconfirmed = assets => {
    const names = new Set(assets.map(asset => asset.filename));
    return [...orders.values()].some(state => orderIsCurrent(state) && [...state.pendingFilenames].some(filename => names.has(filename)));
  };
  function retainSharedMappings(mappings, except) {
    for (const state of orders.values()) {
      if (state === except || !orderIsCurrent(state)) continue;
      const names = new Set(state.assets.map(asset => asset.filename));
      const shared = mappings.filter(mapping => names.has(mapping.filename));
      if (!shared.length) continue;
      state.draft.retainMappings(shared);
      for (const { filename, url } of shared) {
        if (validateImageUrls([url]).valid) state.pendingFilenames.delete(filename);
        else state.pendingFilenames.add(filename);
      }
      state.confirmed = state.pendingFilenames.size === 0;
    }
  }
  function hideOrder() {
    byId('image-order-confirmation').hidden = true;
    byId('image-order-list').replaceChildren();
    byId('image-order-message').textContent = '';
    byId('confirm-image-order').disabled = true;
  }
  function renderOrder(state) {
    if (!state) return hideOrder();
    byId('image-order-list').replaceChildren(...state.nodes);
    byId('image-order-confirmation').hidden = false;
    updateOrder(state, '', false);
  }
  function refresh() {
    const selected = getCopyState();
    const current = getCurrent();
    if (displayedCurrent !== current) {
      orders.clear(); sources.clear(); displayedScope = undefined;
      displayedCurrent = current;
    }
    if (displayedScope !== selected?.id) {
      if (displayedScope) sources.set(displayedScope, { html: byId('school-image-source').value, pageUrl: byId('school-page-url').value });
      displayedScope = selected?.id;
      const source = sources.get(displayedScope);
      byId('school-image-source').value = source?.html || '';
      byId('school-page-url').value = source?.pageUrl || '';
      message('');
      renderOrder(orders.get(displayedScope));
    }
    const assets = scopedAssets(selected);
    const allAssets = current?.assets ?? [];
    const whole = selected?.kind === 'whole';
    const filled = filledCount(assets);
    byId('mapping-count').textContent = whole
      ? `整篇已填写 ${filled} / ${assets.length} 张图片`
      : `本栏目已填写 ${filled} / ${assets.length} 张图片（整篇 ${filledCount(allAssets)} / ${allAssets.length}）`;
    byId('download-mapped').disabled = !addressesValid(allAssets) || hasUnconfirmed(allAssets);
    const busy = Boolean(current && mappingRequest && mappingRequest.current === current && isCopyContextCurrent(mappingRequest.copyContext));
    const importing = Boolean(current && importRequest && importRequest.current === current && isCopyContextCurrent(importRequest.copyContext));
    byId('download-upload-images').disabled = !assets.length;
    byId('download-upload-images').textContent = whole ? '下载整篇上传用图片' : '下载本栏目上传用图片';
    byId('import-image-urls').disabled = !assets.length || importing;
    byId('clear-image-urls').disabled = !assets.length;
    byId('clear-image-urls').textContent = whole ? '清空整篇图片地址' : '清空本栏目图片地址';
    for (const [filename, input] of assetInputs) input.parentElement.hidden = !selected?.assetFilenames.includes(filename);
    const nativeMath = current?.manifest.options?.formulaFormat === 'mathml';
    byId('mapping-help').textContent = `${whole ? '下载并上传整篇图片' : '先选择复制栏目，只下载并上传本栏目的图片'}，再把包含这些图片的学校编辑器源码粘贴到这里。图片保留整篇原图号，其他栏目的地址会保留；复制本栏目无需填完其他图片。${nativeMath ? '原生公式无需上传。' : ''}`;
    const unconfirmed = hasUnconfirmed(assets);
    const button = byId('copy-mapped');
    const field = ['field', 'unassigned'].includes(selected?.kind) ? `“${selected.displayTitle ?? selected.title}”` : '';
    const target = whole ? '整篇 HTML' : `${field}正文`;
    button.disabled = !selected?.eligible || selected.needsMapping && (!addressesValid(assets) || unconfirmed || busy);
    button.textContent = selected?.needsMapping
      ? busy ? '正在替换图片地址…' : `替换图片并复制${target}`
      : `复制${target}`;
    let note;
    if (!selected?.eligible) note = selected?.empty ? '当前栏目没有正文，请检查 Word。' : '请选择学校栏目后复制对应正文。';
    else if (!selected.assetFilenames.length) note = whole ? '整篇文档没有图片，可直接复制整篇 HTML。' : `当前${field || '正文'}没有图片，可直接复制；其他栏目的图片不会影响此操作。`;
    else if (!selected.needsMapping) note = `${whole ? '整篇' : '本栏目'}图片地址已替换，可直接复制${whole ? '整篇 HTML' : '正文'}。预览继续使用本地图片。`;
    else if (busy) note = '正在处理图片地址，请稍候。';
    else if (unconfirmed) {
      const activeOrder = orders.get(selected.id);
      if (activeOrder && !activeOrder.confirmed) note = `请先确认上方的图片对应关系，再复制${whole ? '整篇 HTML' : '本栏目'}。`;
      else {
        const names = new Set(assets.map(asset => asset.filename));
        const pendingTitles = [...orders.values()].filter(state => orderIsCurrent(state) && [...state.pendingFilenames].some(filename => names.has(filename)))
          .map(state => `“${state.scopeTitle}”`).join('、');
        note = `请切换到${pendingTitles}确认图片对应关系，再复制${whole ? '整篇 HTML' : '本栏目'}。`;
      }
    }
    else if (!addressesValid(assets)) note = `请先填写${whole ? '整篇' : '本栏目'} ${assets.length} 张图片的完整且互不重复的学校地址，再复制${whole ? '整篇 HTML' : '本栏目'}。${whole ? '' : '其他栏目无需先填写。'}`;
    else note = whole ? '替换整篇文档中的图片地址并复制完整 HTML，预览继续使用本地图片。' : `替换并复制${field || '当前正文'}，预览继续使用本地图片。`;
    if (selected?.kind === 'unassigned' && selected.eligible) note += ' 粘贴位置请自行选择。';
    byId('mapping-copy-note').textContent = note;
    button.title = note;
  }
  function invalidate() {
    revision++;
    orders.delete(getCopyState()?.id);
    hideOrder();
    message('');
    resetMappedSource();
    refresh();
  }
  function reset() {
    orders.clear(); sources.clear(); displayedScope = getCopyState()?.id; displayedCurrent = getCurrent();
    invalidate();
    byId('school-image-source').value = '';
    byId('school-page-url').value = '';
    byId('manual-mapping').open = false;
    const nativeMath = getCurrent()?.manifest.options?.formulaFormat === 'mathml';
    byId('mapping-format-note').textContent = nativeMath
      ? '原生公式无需上传图片。当前文档仍需检查学校保存后图片是否正常显示。'
      : 'PNG 模式还需上传公式图片。学校会清除图片基线样式，行内公式图片的对齐仍需检查。';
  }
  function fillEmpty(matches, assets) {
    let filled = 0;
    let preserved = 0;
    const accepted = [];
    const required = new Set(assets.map(asset => asset.filename));
    for (const { filename, url } of matches) {
      if (!required.has(filename)) continue;
      const input = assetInputs.get(filename);
      if (!input) continue;
      if (input.value.trim() && input.value.trim() !== url) { preserved++; continue; }
      if (!input.value.trim()) { input.value = url; filled++; }
      accepted.push({ filename, url });
    }
    retainSharedMappings(accepted);
    refresh();
    return { filled, preserved };
  }
  function updateOrder(state, note = '', updateReadiness = true) {
    for (const entry of state.draft.rows()) {
      const controls = state.controls.get(entry.filename);
      const keepOption = controls.select.querySelector('option[value="keep"]');
      if (!entry.keepUrl && keepOption) keepOption.remove();
      else if (entry.keepUrl && !keepOption) {
        const option = document.createElement('option'); option.value = 'keep';
        option.textContent = '保留已填写的手工地址';
        controls.select.insertBefore(option, controls.select.options[1] ?? null);
      }
      controls.select.value = entry.selection;
      controls.url.textContent = entry.url || '尚未选择图片';
      const schoolImage = state.report.imageChoices.find(choice => String(choice.index) === entry.selection);
      controls.view.hidden = !schoolImage;
      if (schoolImage) controls.view.href = schoolImage.url;
      else controls.view.removeAttribute('href');
      controls.change.textContent = entry.existingUrl && entry.url && entry.url !== entry.existingUrl
        ? `确认后将替换原有地址：${entry.existingUrl}`
        : entry.selection === 'keep' ? '保留你已填写的手工地址。' : '';
    }
    const checked = state.draft.validate();
    byId('confirm-image-order').disabled = !checked.valid || state.confirmed;
    byId('confirm-image-order').textContent = state.confirmed ? '已确认图片对应关系' : '确认图片对应关系';
    const notice = byId('image-order-message');
    notice.classList.toggle('error', !checked.valid);
    notice.textContent = !checked.valid ? checked.message : state.confirmed
      ? '对应关系已确认，可以复制正文。修改下拉框后需再次确认。'
      : `${note}${checked.changedCount ? `确认后将填写或修改 ${checked.changedCount} 个地址。` : '当前选择会保留已填地址。'}请核对每张原图与学校图片是否对应。`;
    if (updateReadiness) refresh();
  }
  function presentOrder(report, current, selected, confirmed = false) {
    const list = byId('image-order-list');
    list.replaceChildren();
    const state = {
      report, current, scopeId: selected.id, scopeTitle: selected.displayTitle ?? selected.title, assets: scopedAssets(selected), confirmed,
      controls: new Map(), nodes: [],
    };
    state.pendingFilenames = new Set(confirmed ? [] : state.assets.map(asset => asset.filename));
    state.draft = createImageOrder({ assets: state.assets, images: report.imageChoices, existingUrls: existingUrls(state.assets) });
    orders.set(selected.id, state);
    for (const entry of state.draft.rows()) {
      const number = current.assets.findIndex(asset => asset.filename === entry.filename) + 1;
      const row = document.createElement('div'); row.className = 'image-order-row';
      const image = document.createElement('img');
      image.src = `/api/assets/${current.jobId}/${encodeURIComponent(entry.filename)}`;
      image.alt = `第 ${number} 张原图`;
      const description = document.createElement('div'); description.className = 'image-order-description';
      const label = document.createElement('strong'); label.textContent = `原图 ${number}`;
      const chooser = document.createElement('label'); chooser.textContent = '对应学校图片';
      const select = document.createElement('select'); select.setAttribute('aria-label', `原图 ${number} 对应的学校图片`);
      select.dataset.filename = entry.filename;
      const addOption = (value, text) => { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); };
      addOption('', '请选择对应图片');
      if (entry.keepUrl) addOption('keep', '保留已填写的手工地址');
      for (const choice of report.imageChoices) addOption(String(choice.index), `学校源码第 ${choice.index} 张图片`);
      const url = document.createElement('code'); url.className = 'image-order-url';
      const view = document.createElement('a'); view.textContent = '查看所选学校图片'; view.className = 'image-order-view';
      view.target = '_blank'; view.rel = 'noopener noreferrer'; view.referrerPolicy = 'no-referrer';
      const change = document.createElement('p'); change.className = 'image-order-change';
      state.controls.set(entry.filename, { select, url, change, view });
      select.addEventListener('change', () => {
        if (!orderIsCurrent(state) || getCopyState()?.id !== state.scopeId) return;
        try {
          const changed = state.draft.select(entry.filename, select.value);
          revision++; state.confirmed = false;
          state.pendingFilenames.add(entry.filename);
          resetMappedSource();
          message('对应关系已调整，尚未写入正文。请在下方确认图片对应关系。');
          const displaced = changed.swappedFilename || changed.clearedFilename;
          if (displaced) state.pendingFilenames.add(displaced);
          const other = displaced ? current.assets.findIndex(asset => asset.filename === displaced) + 1 : 0;
          const note = changed.swappedFilename ? `已交换原图 ${number} 与原图 ${other} 的对应关系。`
            : changed.clearedFilename ? `原图 ${other} 的选择已清空，请重新选择它对应的图片。` : '';
          updateOrder(state, note);
        } catch (error) { byId('image-order-message').textContent = error.message; }
      });
      chooser.append(select);
      description.append(label, chooser, url, view, change); row.append(image, description); list.append(row); state.nodes.push(row);
    }
    if (!state.draft.validate().valid) {
      state.confirmed = false;
      state.pendingFilenames = new Set(state.assets.map(asset => asset.filename));
    }
    byId('image-order-confirmation').hidden = false;
    updateOrder(state);
  }
  byId('school-image-source').addEventListener('input', invalidate);
  byId('school-page-url').addEventListener('input', invalidate);
  byId('asset-list').addEventListener('input', event => {
    const changed = [...assetInputs].find(([, input]) => input === event.target)?.[0];
    if (changed) retainSharedMappings([{ filename: changed, url: assetInputs.get(changed).value }], orders.get(getCopyState()?.id));
    invalidate();
    const assets = scopedAssets(getCopyState());
    const checked = validateImageUrls(assets.map(asset => assetInputs.get(asset.filename)?.value));
    if (filledCount(assets) === assets.length && !checked.valid) message(checked.message, true);
  });
  byId('clear-image-urls').addEventListener('click', () => {
    const assets = scopedAssets(getCopyState());
    for (const asset of assets) assetInputs.get(asset.filename).value = '';
    retainSharedMappings(assets.map(asset => ({ filename: asset.filename, url: '' })), orders.get(getCopyState()?.id));
    invalidate();
    message('已清空当前复制范围的图片地址，其他栏目地址会保留。可以重新粘贴或识别学校源码。');
  });
  byId('download-upload-images').addEventListener('click', async () => {
    const current = getCurrent();
    const selected = getCopyState();
    if (!current || !scopedAssets(selected).length) return;
    const copyContext = getCopyContext();
    const isCurrent = () => getCurrent() === current && isCopyContextCurrent(copyContext);
    const button = byId('download-upload-images'); button.disabled = true;
    try {
      const response = await requestJob('upload-images', undefined, { sectionId: selected.id });
      if (!response.ok) throw new Error((await response.json()).error);
      const archive = await response.blob();
      if (!isCurrent()) return;
      download(archive, selected.kind === 'whole' ? '整篇上传用图片.zip' : `${selected.displayTitle ?? selected.title}-上传用图片.zip`);
      if (isCurrent()) status('当前复制范围的上传用图片已下载，保留整篇原图号。上传这些图片后，复制学校编辑器源码，粘贴到“学校图片源码”。');
    } catch (error) { if (isCurrent()) status(error.message, true); }
    finally { refresh(); }
  });
  byId('import-image-urls').addEventListener('click', async () => {
    const current = getCurrent();
    const selected = getCopyState();
    const assets = scopedAssets(selected);
    if (!current || !assets.length) return;
    invalidate();
    const html = byId('school-image-source').value;
    if (!html.trim()) return message('先粘贴学校编辑器中包含已上传图片的源码。', true);
    const version = revision;
    const copyContext = getCopyContext();
    const isCurrent = () => getCurrent() === current && revision === version && isCopyContextCurrent(copyContext);
    const operation = { current, version, copyContext };
    importRequest = operation;
    const button = byId('import-image-urls'); button.disabled = true;
    message('正在识别图片地址…');
    try {
      const report = await json(await requestJob('import-images', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, pageUrl: byId('school-page-url').value.trim(), sectionId: selected.id })
      }));
      if (!isCurrent()) return;
      const { filled, preserved } = fillEmpty(report.matches, assets);
      const remaining = assets.length - filledCount(assets);
      const notes = report.warnings.slice(0, 3).join('；');
      let text = `识别到 ${report.detectedCount} 张图片，按文件名填入 ${filled} 个地址。`;
      if (preserved) text += `保留了 ${preserved} 个你已填写的不同地址，可展开逐张检查。`;
      if (report.canAdjustOrder) {
        const confirmed = !report.orderReady && !remaining && !preserved;
        text += confirmed ? '全部地址已按文件名识别；仍可在下方调整对应关系。' : '请在下方选择每张原图对应的学校图片，并确认对应关系。';
        presentOrder(report, current, selected, confirmed);
      } else if (!remaining) text += '全部地址已填写，可以直接复制到学校编辑器；请核对图片对应关系。';
      else text += `还有 ${remaining} 张未填写，可补充源码或展开逐张修改。`;
      if (notes) text += ` ${notes}`;
      message(text, remaining > 0 && !report.orderReady);
    } catch (error) { if (isCurrent()) message(error.message, true); }
    finally {
      if (importRequest === operation) importRequest = undefined;
      refresh();
    }
  });
  byId('confirm-image-order').addEventListener('click', () => {
    const pending = orders.get(getCopyState()?.id);
    if (!pending || pending.confirmed || !orderIsCurrent(pending)) return;
    if (pending.draft.rows().some(entry => pending.controls.get(entry.filename).select.value !== entry.selection)) {
      byId('image-order-message').textContent = '选择已变化，请重新选择并核对对应关系。';
      return;
    }
    const checked = pending.draft.validate();
    if (!checked.valid) { updateOrder(pending); return; }
    for (const { filename, url } of checked.mappings) assetInputs.get(filename).value = url;
    retainSharedMappings(checked.mappings, pending);
    revision++;
    resetMappedSource();
    // Keep the existing thumbnail and select nodes; confirming changes only state.
    pending.confirmed = true;
    pending.pendingFilenames.clear();
    pending.draft = createImageOrder({ assets: pending.assets, images: pending.report.imageChoices,
      existingUrls: existingUrls(pending.assets) });
    updateOrder(pending);
    message(`已按确认的对应关系填写 ${checked.mappings.length} 张图片地址。可以直接复制到学校编辑器；仍可修改下拉框并再次确认。`);
  });
  byId('copy-mapped').addEventListener('click', async () => {
    const current = getCurrent();
    const selected = getCopyState();
    if (!current || !selected?.eligible) return;
    // Text-only fields and cached mapped fields use the same immediate copy action.
    if (selected.copyable) return copySelectedSource();
    const assets = scopedAssets(selected);
    if (!selected.needsMapping || !addressesValid(assets) || hasUnconfirmed(assets)
      || mappingRequest?.current === current && isCopyContextCurrent(mappingRequest.copyContext)) return;
    const version = revision;
    const copyContext = getCopyContext();
    const isCurrent = () => getCurrent() === current && revision === version && isCopyContextCurrent(copyContext);
    const operation = { current, version, copyContext };
    mappingRequest = operation;
    refresh();
    status(`正在替换${selected.kind === 'whole' ? '整篇文档' : ['field', 'unassigned'].includes(selected.kind) ? `“${selected.title}”` : '当前正文'}的图片地址…`);
    const urls = Object.fromEntries([...assetInputs].map(([filename, input]) => [filename, input.value.trim()]));
    try {
      const exported = await json(await requestJob('export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'mapped', format: 'json', sectionId: selected.id, urls })
      }));
      if (!isCurrent()) return;
      showMappedSource(exported);
      if (!isCurrent()) return;
      await copySelectedSource();
    } catch (error) { if (isCurrent()) status(error.message, true); }
    finally {
      if (mappingRequest === operation) mappingRequest = undefined;
      refresh();
    }
  });
  return { reset, invalidate, refresh, getRevision: () => revision };
}
