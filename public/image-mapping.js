import { createImageOrder, validateImageUrls } from '/image-order.js';

/** Paste-to-map workflow. Imported HTML and school images are never rendered. */
export function createImageMapping({ getCurrent, assetInputs, byId, json, download, status, showMappedSource, resetMappedSource, requestJob,
  getCopyContext, isCopyContextCurrent, getCopyState, copySelectedSource }) {
  let revision = 0;
  let pendingOrder;
  let mappingRequest;
  const message = (text, error = false) => {
    byId('mapping-message').textContent = text;
    byId('mapping-message').classList.toggle('error', error);
  };
  const filledCount = () => [...assetInputs.values()].filter(input => input.value.trim()).length;
  const addressesValid = () => assetInputs.size > 0 && validateImageUrls([...assetInputs.values()].map(input => input.value)).valid;
  function refresh() {
    const total = assetInputs.size;
    const filled = filledCount();
    byId('mapping-count').textContent = `已填写 ${filled} / ${total} 张图片`;
    const unconfirmed = pendingOrder && !pendingOrder.confirmed;
    byId('download-mapped').disabled = !addressesValid() || Boolean(unconfirmed);
    const selected = getCopyState();
    const busy = mappingRequest?.current === getCurrent() && Boolean(getCurrent());
    const button = byId('copy-mapped');
    const field = ['field', 'unassigned'].includes(selected?.kind) ? `“${selected.title}”` : '';
    const whole = selected?.kind === 'whole';
    const target = whole ? '整篇 HTML' : `${field}正文`;
    button.disabled = !selected?.eligible || selected.needsMapping && (!addressesValid() || Boolean(unconfirmed) || busy);
    button.textContent = selected?.needsMapping
      ? busy ? '正在替换图片地址…' : `替换图片并复制${target}`
      : `复制${target}`;
    let note;
    if (!selected?.eligible) note = selected?.empty ? '当前栏目没有正文，请检查 Word。' : '请选择学校栏目后复制对应正文。';
    else if (!selected.assetFilenames.length) note = whole ? '整篇文档没有图片，可直接复制整篇 HTML。' : `当前${field || '正文'}没有图片，可直接复制；其他栏目的图片不会影响此操作。`;
    else if (!selected.needsMapping) note = `${whole ? '整篇' : '本栏目'}图片地址已替换，可直接复制${whole ? '整篇 HTML' : '正文'}。预览继续使用本地图片。`;
    else if (busy) note = '正在处理图片地址，请稍候。';
    else if (unconfirmed) note = `请先确认上方的图片对应关系，再复制${whole ? '整篇 HTML' : '本栏目'}。`;
    else if (!addressesValid()) note = `请先填写完整且互不重复的学校图片地址，再复制${whole ? '整篇 HTML' : '本栏目'}。`;
    else note = whole ? '替换整篇文档中的图片地址并复制完整 HTML，预览继续使用本地图片。' : `替换并复制${field || '当前正文'}，预览继续使用本地图片。`;
    if (selected?.kind === 'unassigned' && selected.eligible) note += ' 粘贴位置请自行选择。';
    byId('mapping-copy-note').textContent = note;
    button.title = note;
  }
  function invalidate() {
    revision++;
    pendingOrder = undefined;
    byId('image-order-confirmation').hidden = true;
    byId('image-order-list').replaceChildren();
    byId('image-order-message').textContent = '';
    byId('confirm-image-order').disabled = true;
    byId('import-image-urls').disabled = false;
    message('');
    resetMappedSource();
    refresh();
  }
  function reset() {
    invalidate();
    byId('school-image-source').value = '';
    byId('school-page-url').value = '';
    byId('manual-mapping').open = false;
    const nativeMath = getCurrent()?.manifest.options?.formulaFormat === 'mathml';
    byId('mapping-help').textContent = `下载上传用图片，在学校按图号上传，再把编辑器的整段源码粘贴到这里。工具会识别图片地址，省去逐张复制链接。${nativeMath ? '这里只处理普通图片，原生公式无需上传。' : ''}`;
    byId('mapping-format-note').textContent = nativeMath
      ? '原生公式无需上传图片。当前文档仍需检查学校保存后图片是否正常显示。'
      : 'PNG 模式还需上传公式图片。学校会清除图片基线样式，行内公式图片的对齐仍需检查。';
  }
  function fillEmpty(matches) {
    let filled = 0;
    let preserved = 0;
    for (const { filename, url } of matches) {
      const input = assetInputs.get(filename);
      if (!input) continue;
      if (input.value.trim() && input.value.trim() !== url) { preserved++; continue; }
      if (!input.value.trim()) { input.value = url; filled++; }
    }
    refresh();
    return { filled, preserved };
  }
  function updateOrder(state, note = '') {
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
    refresh();
  }
  function presentOrder(report, current, version, confirmed = false) {
    const list = byId('image-order-list');
    list.replaceChildren();
    const state = {
      report, current, revision: version, confirmed,
      draft: createImageOrder({ assets: current.assets, images: report.imageChoices, existingUrls: Object.fromEntries([...assetInputs].map(([name, input]) => [name, input.value.trim()])) }),
      controls: new Map(),
    };
    pendingOrder = state;
    for (const [index, entry] of state.draft.rows().entries()) {
      const row = document.createElement('div'); row.className = 'image-order-row';
      const image = document.createElement('img');
      image.src = `/api/assets/${current.jobId}/${encodeURIComponent(entry.filename)}`;
      image.alt = `第 ${index + 1} 张原图`;
      const description = document.createElement('div'); description.className = 'image-order-description';
      const label = document.createElement('strong'); label.textContent = `原图 ${index + 1}`;
      const chooser = document.createElement('label'); chooser.textContent = '对应学校图片';
      const select = document.createElement('select'); select.setAttribute('aria-label', `原图 ${index + 1} 对应的学校图片`);
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
        if (pendingOrder !== state || state.current !== getCurrent() || state.revision !== revision) return;
        try {
          const changed = state.draft.select(entry.filename, select.value);
          revision++; state.revision = revision; state.confirmed = false;
          resetMappedSource();
          message('对应关系已调整，尚未写入正文。请在下方确认图片对应关系。');
          const displaced = changed.swappedFilename || changed.clearedFilename;
          const other = displaced ? current.assets.findIndex(asset => asset.filename === displaced) + 1 : 0;
          const note = changed.swappedFilename ? `已交换原图 ${index + 1} 与原图 ${other} 的对应关系。`
            : changed.clearedFilename ? `原图 ${other} 的选择已清空，请重新选择它对应的图片。` : '';
          updateOrder(state, note);
        } catch (error) { byId('image-order-message').textContent = error.message; }
      });
      chooser.append(select);
      description.append(label, chooser, url, view, change); row.append(image, description); list.append(row);
    }
    if (!state.draft.validate().valid) state.confirmed = false;
    byId('image-order-confirmation').hidden = false;
    updateOrder(state);
  }
  byId('school-image-source').addEventListener('input', invalidate);
  byId('school-page-url').addEventListener('input', invalidate);
  byId('asset-list').addEventListener('input', () => {
    invalidate();
    const checked = validateImageUrls([...assetInputs.values()].map(input => input.value));
    if (filledCount() === assetInputs.size && !checked.valid) message(checked.message, true);
  });
  byId('clear-image-urls').addEventListener('click', () => {
    for (const input of assetInputs.values()) input.value = '';
    invalidate();
    message('已清空图片地址，可以重新粘贴或识别学校源码。');
  });
  byId('download-upload-images').addEventListener('click', async () => {
    const current = getCurrent();
    if (!current?.assets.length) return;
    const button = byId('download-upload-images'); button.disabled = true;
    try {
      const response = await requestJob('upload-images');
      if (!response.ok) throw new Error((await response.json()).error);
      const archive = await response.blob();
      if (getCurrent() !== current) return;
      download(archive, '上传用图片.zip');
      if (getCurrent() === current) status('上传用图片已下载。按图号上传后，复制学校编辑器整段源码，粘贴到“学校图片源码”。');
    } catch (error) { if (getCurrent() === current) status(error.message, true); }
    finally { button.disabled = false; }
  });
  byId('import-image-urls').addEventListener('click', async () => {
    const current = getCurrent();
    if (!current) return;
    invalidate();
    const html = byId('school-image-source').value;
    if (!html.trim()) return message('先粘贴学校编辑器中包含已上传图片的源码。', true);
    const version = revision;
    const button = byId('import-image-urls'); button.disabled = true;
    message('正在识别图片地址…');
    try {
      const report = await json(await requestJob('import-images', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, pageUrl: byId('school-page-url').value.trim() })
      }));
      if (getCurrent() !== current || revision !== version) return;
      const { filled, preserved } = fillEmpty(report.matches);
      const remaining = current.assets.length - filledCount();
      const notes = report.warnings.slice(0, 3).join('；');
      let text = `识别到 ${report.detectedCount} 张图片，按文件名填入 ${filled} 个地址。`;
      if (preserved) text += `保留了 ${preserved} 个你已填写的不同地址，可展开逐张检查。`;
      if (report.canAdjustOrder) {
        const confirmed = !report.orderReady && !remaining && !preserved;
        text += confirmed ? '全部地址已按文件名识别；仍可在下方调整对应关系。' : '请在下方选择每张原图对应的学校图片，并确认对应关系。';
        presentOrder(report, current, version, confirmed);
      } else if (!remaining) text += '全部地址已填写，可以直接复制到学校编辑器；请核对图片对应关系。';
      else text += `还有 ${remaining} 张未填写，可补充源码或展开逐张修改。`;
      if (notes) text += ` ${notes}`;
      message(text, remaining > 0 && !report.orderReady);
    } catch (error) { if (getCurrent() === current && revision === version) message(error.message, true); }
    finally { if (revision === version) button.disabled = false; }
  });
  byId('confirm-image-order').addEventListener('click', () => {
    const pending = pendingOrder;
    if (!pending || pending.confirmed || pending.current !== getCurrent() || pending.revision !== revision) return;
    if (pending.draft.rows().some(entry => pending.controls.get(entry.filename).select.value !== entry.selection)) {
      byId('image-order-message').textContent = '选择已变化，请重新选择并核对对应关系。';
      return;
    }
    const checked = pending.draft.validate();
    if (!checked.valid) { updateOrder(pending); return; }
    for (const { filename, url } of checked.mappings) assetInputs.get(filename).value = url;
    revision++;
    resetMappedSource();
    // Keep the existing thumbnail and select nodes; confirming changes only state.
    pending.revision = revision;
    pending.confirmed = true;
    pending.draft = createImageOrder({ assets: pending.current.assets, images: pending.report.imageChoices,
      existingUrls: Object.fromEntries([...assetInputs].map(([name, input]) => [name, input.value.trim()])) });
    updateOrder(pending);
    message(`已按确认的对应关系填写 ${checked.mappings.length} 张图片地址。可以直接复制到学校编辑器；仍可修改下拉框并再次确认。`);
  });
  byId('copy-mapped').addEventListener('click', async () => {
    const current = getCurrent();
    const selected = getCopyState();
    if (!current || !selected?.eligible) return;
    // Text-only fields and cached mapped fields use the same immediate copy action.
    if (selected.copyable) return copySelectedSource();
    if (!selected.needsMapping || !addressesValid() || pendingOrder && !pendingOrder.confirmed || mappingRequest?.current === current) return;
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
