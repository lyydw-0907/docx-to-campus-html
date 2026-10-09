import { createImageMapping } from '/image-mapping.js';
import { createJobRecovery } from '/job-recovery.js';
import { createSectionView, sectionDisplayTitle } from '/section-view.js';
import { startSiteVisits } from '/site-visits.js';

startSiteVisits();

const byId = id => document.getElementById(id);
let current;
let previewUrl;
let previewHtml;
let selectedFile;
const assetInputs = new Map();
const sectionView = createSectionView();
const jobRecovery = createJobRecovery({
  getCurrent: () => current,
  onRecovering: () => status('本地记录已失效，正在用原 Word 恢复。已粘贴的学校源码和图片地址会保留…'),
  onRecovered: result => {
    for (const image of document.querySelectorAll('#asset-list img, #image-order-list img')) {
      const source = image.getAttribute('src');
      if (source?.startsWith('/api/assets/')) image.src = source.replace(/^\/api\/assets\/[a-f\d-]{36}\//, `/api/assets/${result.jobId}/`);
    }
    status('本地转换记录已恢复，继续处理已粘贴的源码和图片地址。');
  },
});
const requestJob = (route, init, query) => jobRecovery.request(route, init, query);
const imageMapping = createImageMapping({ getCurrent: () => current, assetInputs, byId, json, download, status, showMappedSource, resetMappedSource, requestJob,
  getCopyContext: () => sectionView.token(), isCopyContextCurrent: token => sectionView.matches(token),
  getCopyState: () => {
    const selected = sectionView.snapshot();
    return selected && { ...selected, displayTitle: sectionDisplayTitle(selected) };
  }, copySelectedSource });

const demoRequestUrl = () => `/api/demo-docx?${new URLSearchParams({ documentType: byId('document-type').value })}`;
function updateDocumentTypeHelp() {
  const progress = byId('document-type').value === 'progress';
  byId('document-type-help').textContent = progress
    ? '进展检查分为“项目进展检查”和“项目后期具体工作计划”两栏。请在 Word 中用这两个名称作同一级的外层标题，内部小标题低一级；其他同级标题会保留为待分配内容。可先试用示例查看格式。'
    : '选择学校表单后转换，按 Word 的栏目标题分栏预览和复制。';
  byId('demo').textContent = progress ? '试用进展检查示例' : '试用示例';
}
byId('document-type').addEventListener('change', () => {
  updateDocumentTypeHelp();
  const resultForm = current?.manifest.options?.documentType === 'progress' ? '项目进展检查' : '申报书';
  status(current ? `学校表单设置用于下次转换。当前结果仍为“${resultForm}”，图片对应关系保留；请重新转换 Word 以应用新设置。` : '学校表单已切换，可选择 Word 文件或试用对应示例。');
});
updateDocumentTypeHelp();

function showMappedSource(exported) {
  if (exported.section) sectionView.setMappedSection(exported.section);
  else sectionView.setMapped(exported);
  renderSelectedSection();
}
function resetMappedSource() {
  sectionView.resetMapped();
  if (current) renderSelectedSection();
}
function renderSelectedSection() {
  const selected = sectionView.snapshot();
  if (!selected) return;
  byId('source').value = selected.fragment;
  showPreview(selected.preview);
  byId('counts').textContent = `${selected.formulaCount} 个公式 · ${selected.imageCount} 张图片`;
  byId('copy').disabled = !selected.copyable;
  byId('copy').textContent = selected.kind === 'whole' ? '复制整篇 HTML' : ['field', 'unassigned'].includes(selected.kind) ? `复制“${sectionDisplayTitle(selected)}”正文` : '复制片段';
  for (const id of ['section-select', 'mapping-section-select']) byId(id).value = selected.id;
  const nativeMath = current.manifest.options?.formulaFormat === 'mathml';
  let note;
  if (selected.empty) note = '此栏目没有正文内容，请检查 Word。';
  else if (selected.kind === 'unassigned') note = (selected.needsMapping
    ? '此片段含图片，只需完成本片段的图片地址对应，再替换并复制。'
    : `${selected.mapped && selected.assetFilenames.length ? '图片地址已替换。' : ''}可单独复制“${selected.title}”正文，保留原标题和格式。`)
    + '对应的学校栏目尚未确定，粘贴位置请自行选择。';
  else if (selected.kind === 'whole' && current.sections?.length) note = (selected.needsMapping
    ? '请先在下方确认全部图片地址，再替换并复制整篇 HTML。'
    : `${selected.mapped && selected.assetFilenames.length ? '图片地址已替换。' : ''}可复制整篇 HTML。`)
    + '整篇保留封面、所有栏目及待分配内容。学校分栏目填写时，可切换到对应栏目分别复制。';
  else note = selected.needsMapping
    ? `${nativeMath ? '原生公式无需上传。' : ''}只需在下方完成本栏目的 ${selected.assetFilenames.length} 张图片地址对应，即可复制；其他栏目的图片可稍后处理。`
    : `${selected.mapped && selected.assetFilenames.length ? '图片地址已替换。' : nativeMath ? '原生公式无需上传图片。' : ''}可复制此正文到学校${selected.kind === 'field' ? `“${selected.title}”` : ''}编辑框的源码模式；粘贴后仍需检查保存效果。`;
  byId('source-note').textContent = note;
  byId('copy').title = note;
  byId('section-note').textContent = selected.kind === 'field'
    ? `对应学校“${selected.title}”栏目。学校已有的蓝色栏目标题已从此片段移除，正文里的小标题和编号保留。`
    : note;
  byId('section-note').className = selected.empty ? 'error' : '';
}

function status(message, error = false) { byId('status').textContent = message; byId('status').className = error ? 'error' : ''; }
async function json(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成。');
  return data;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
function clearPreview() {
  const frame = byId('preview');
  frame.removeAttribute('srcdoc');
  frame.removeAttribute('src');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  previewHtml = undefined;
}
function showPreview(html) {
  if (previewHtml === html && previewUrl) return;
  const previousUrl = previewUrl;
  // A Blob document renders reliably in Edge with the iframe's full sandbox.
  // The same opaque sandbox can leave srcdoc content without a layout tree.
  previewUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  previewHtml = html;
  byId('preview').src = previewUrl;
  if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 1000);
}
function showResult(result) {
  current = result;
  sectionView.setResult(result);
  byId('section-controls').hidden = !result.sections?.length;
  byId('mapping-section-control').hidden = !result.sections?.length;
  for (const id of ['section-select', 'mapping-section-select']) {
    const select = byId(id); select.replaceChildren();
    for (const item of sectionView.items()) {
      const option = document.createElement('option'); option.value = item.id;
      option.textContent = sectionDisplayTitle(item) + (item.kind === 'unassigned' ? '（待分配内容）' : '');
      option.title = item.title;
      select.append(option);
    }
    select.value = sectionView.snapshot().id;
  }
  byId('workspace').hidden = false;
  byId('mapping').hidden = !result.assets.length;
  const hasEmbeddedImages = result.assets.length > 0 && result.manifest.options?.imageMode !== 'mapped';
  const nativeMath = result.manifest.options?.formulaFormat === 'mathml';
  byId('download').textContent = hasEmbeddedImages ? '下载图片与本地预览' : result.sections?.length ? '下载各栏目 HTML 与预览' : '下载 HTML 与预览';
  byId('export-note').textContent = result.sections?.length ? '包含各栏目正文、整篇核对版和转换清单' : hasEmbeddedImages ? '提取图片并上传，替换地址后使用' : '包含可复制的源码、预览和转换清单';
  byId('warnings').replaceChildren();
  for (const warning of result.manifest.warnings || []) { const li = document.createElement('li'); li.textContent = warning; byId('warnings').append(li); }
  assetInputs.clear(); byId('asset-list').replaceChildren();
  for (const [index, asset] of result.assets.entries()) {
    const row = document.createElement('div'); row.className = 'asset-row';
    const image = document.createElement('img'); image.src = `/api/assets/${result.jobId}/${encodeURIComponent(asset.filename)}`; image.alt = `图 ${index + 1}：${asset.kind === 'formula' ? '公式图片' : '普通图片'}`;
    const name = document.createElement('code'); name.textContent = asset.uploadFilename || asset.filename;
    const input = document.createElement('input'); input.type = 'url'; input.placeholder = '学校插图工具返回的绝对 HTTP(S) 地址'; input.setAttribute('aria-label', `${asset.filename} 的学校图片地址`);
    assetInputs.set(asset.filename, input); row.append(image, name, input); byId('asset-list').append(row);
  }
  imageMapping.reset();
  renderSelectedSection();
  status(result.sections?.length
    ? `转换完成。已识别 ${result.sections.filter(section => section.kind === 'field').length} 个学校栏目，请选择栏目后分别复制正文。${result.sections.some(section => section.kind === 'unassigned') ? '还有待分配内容，已单独保留。' : ''}`
    : hasEmbeddedImages
    ? `转换完成。${nativeMath ? '原生公式无需图片上传。' : ''}在下方下载上传用图片，上传后一次粘贴学校源码即可识别地址。当前文档仍需保存回读检查。`
    : '转换完成。可复制 HTML 到学校编辑器的源码模式；当前文档尚未完成学校保存回读检查。');
}
async function convert(input) {
  jobRecovery.clear();
  current = undefined;
  sectionView.setResult(undefined);
  byId('workspace').hidden = true;
  byId('section-controls').hidden = true;
  byId('mapping').hidden = true;
  byId('source').value = '';
  byId('copy').disabled = true;
  clearPreview();
  assetInputs.clear();
  imageMapping.reset();
  byId('convert').disabled = true; byId('demo').disabled = true;
  byId('document-type').disabled = true;
  status('正在转换正文和公式…');
  try {
    const sizeChoice = byId('font-size').value;
    const params = new URLSearchParams({ documentType: byId('document-type').value, fontMode: sizeChoice === 'word' ? 'word' : 'uniform', fontSize: sizeChoice === 'word' ? '14' : sizeChoice, scale: byId('scale').value, formulaFormat: byId('formula-format').value });
    const result = await json(await fetch(`/api/convert?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: input }));
    showResult(result);
    jobRecovery.remember(result, input, params);
  } catch (error) { status(error.message, true); }
  finally { byId('convert').disabled = false; byId('demo').disabled = false; byId('document-type').disabled = false; }
}
function selectFiles(files) {
  if (!files.length) return;
  const file = files[0];
  const error = files.length !== 1 ? '一次请选择或拖入一个 Word 文件。'
    : !file.name.toLowerCase().endsWith('.docx') ? '请选择 .docx 文件；旧版 .doc 请先在 Word 中另存为 .docx。'
    : file.size > 20 * 1024 * 1024 ? '文件超过 20 MB，请缩小图片后重试。' : '';
  // The shared File state works even when a browser cannot mirror dropped files in the input.
  if (error) byId('file').value = '';
  else if (byId('file').files !== files) {
    try { byId('file').files = files; }
    catch { byId('file').value = ''; }
  }
  selectedFile = error ? undefined : file;
  byId('file-name').textContent = selectedFile ? `已选择：${selectedFile.name}` : '支持 .docx，最大 20 MB；也可拖入文件';
  status(error || `已选择 ${file.name}，点击“转换文件”开始。`, Boolean(error));
}
byId('file').addEventListener('change', () => selectFiles(byId('file').files));
const fileDrop = byId('file-drop');
fileDrop.addEventListener('dragover', event => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  fileDrop.classList.add('dragging');
});
fileDrop.addEventListener('dragleave', event => {
  if (!fileDrop.contains(event.relatedTarget)) fileDrop.classList.remove('dragging');
});
fileDrop.addEventListener('drop', event => {
  event.preventDefault();
  fileDrop.classList.remove('dragging');
  selectFiles(event.dataTransfer.files);
});
// Prevent misplaced file drops from navigating away from conversion results.
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
});
byId('formula-format').addEventListener('change', () => { byId('scale').disabled = byId('formula-format').value === 'mathml'; });
byId('convert').addEventListener('click', () => {
  if (!selectedFile) return status('请选择 .docx 文件，或将文件拖入“Word 文件”区域。', true);
  convert(selectedFile);
});
byId('demo').addEventListener('click', async () => {
  if (byId('convert').disabled) return;
  byId('convert').disabled = true; byId('demo').disabled = true;
  byId('document-type').disabled = true;
  try { const response = await fetch(demoRequestUrl()); if (!response.ok) throw new Error('示例读取失败。'); await convert(await response.blob()); }
  catch (error) { status(error.message, true); }
  finally { byId('convert').disabled = false; byId('demo').disabled = false; byId('document-type').disabled = false; }
});
async function copySelectedSource() {
  if (!current || !sectionView.snapshot()?.copyable) return;
  const token = sectionView.token(); const selected = sectionView.snapshot();
  try {
    await navigator.clipboard.writeText(selected.fragment);
    if (sectionView.matches(token)) status(selected.kind === 'whole'
      ? `已复制整篇 HTML。${current.sections?.length ? '包含封面和所有栏目；学校分栏目填写时，可选择对应栏目分别复制。' : '可粘贴到目标编辑器的源码模式，并检查保存后的效果。'}`
      : selected.kind === 'unassigned'
      ? `已复制“${selected.title}”正文。粘贴位置请自行选择，并检查保存后的效果。`
      : `已复制${selected.kind === 'field' ? `“${selected.title}”` : ''}正文。请粘贴到对应编辑框的源码模式，并检查保存后的效果。`);
  } catch {
    if (!sectionView.matches(token)) return;
    byId('source').focus(); byId('source').select(); status(`浏览器未允许自动复制，已选中${selected.kind === 'whole' ? '整篇 HTML' : selected.kind === 'unassigned' ? `“${selected.title}”源码` : '当前栏目源码'}，请按 Ctrl+C。`);
  }
}
byId('copy').addEventListener('click', copySelectedSource);
for (const id of ['section-select', 'mapping-section-select']) byId(id).addEventListener('change', () => {
  sectionView.select(byId(id).value); renderSelectedSection(); imageMapping.refresh();
});
async function exportZip(mode) {
  if (!current || mode === 'mapped' && byId('download-mapped').disabled) return;
  const result = current;
  const mappingRevision = imageMapping.getRevision();
  const urls = Object.fromEntries([...assetInputs].map(([name, input]) => [name, input.value.trim()]));
  try {
    const response = await requestJob('export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, urls }) });
    if (current !== result || mode === 'mapped' && imageMapping.getRevision() !== mappingRevision) return;
    if (!response.ok) throw new Error((await response.json()).error);
    const archive = await response.blob();
    if (current !== result || mode === 'mapped' && imageMapping.getRevision() !== mappingRevision) return;
    if (mode === 'mapped' && Object.entries(urls).some(([name, url]) => assetInputs.get(name)?.value.trim() !== url)) throw new Error('图片地址已修改，请重新下载映射后的 HTML。');
    download(archive, mode === 'mapped' ? 'campus-mapped-html.zip' : result.assets.length ? 'campus-local-preview.zip' : result.manifest.options?.formulaFormat === 'mathml' ? 'campus-mathml-html.zip' : 'campus-html.zip');
    status(mode === 'mapped'
      ? `已导出替换图片地址的 HTML，${current.manifest.options?.formulaFormat === 'mathml' ? '原生公式和' : ''}图片宽高保留。当前文档仍需学校保存回读检查。`
      : current.assets.length ? '已导出图片与本地预览。上传后在下方粘贴一次学校源码识别地址，再下载替换后的 HTML。' : current.sections?.length ? '已导出各栏目 HTML 与预览。将 sections 文件夹中对应栏目的正文分别粘贴到学校编辑框，并检查保存后的效果。' : '已导出 HTML 与预览。可将 fragment.html 复制到学校源码模式；当前文档仍需保存回读检查。');
  } catch (error) { if (current === result && (mode !== 'mapped' || imageMapping.getRevision() === mappingRevision)) status(error.message, true); }
}
byId('download').addEventListener('click', () => exportZip('embedded'));
byId('download-mapped').addEventListener('click', () => exportZip('mapped'));
byId('probe').addEventListener('click', async () => {
  try { const data = await json(await fetch('/api/probe')); byId('before').value = data.fragment; status('测试片段已生成。请在可删除的测试草稿中保存、离开，再重新打开后复制源码。'); }
  catch (error) { status(error.message, true); }
});
byId('compare').addEventListener('click', async () => {
  const box = byId('comparison'); box.replaceChildren();
  try {
    const report = await json(await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ before: byId('before').value, after: byId('after').value }) }));
    const summary = document.createElement('p'); summary.textContent = `正文文本${report.textPreserved ? '一致' : '发生变化'}；图片 ${report.imageCountBefore} → ${report.imageCountAfter}；图片地址保留 ${report.unchangedImageSources}；尺寸属性 ${report.imagesWithDimensionsBefore} → ${report.imagesWithDimensionsAfter}。`; box.append(summary);
    if (report.mathCountBefore || report.mathCountAfter) {
      const mathSummary = document.createElement('p');
      mathSummary.textContent = `原生公式 ${report.mathCountBefore} → ${report.mathCountAfter}；数学结构、字符及原始注释${report.mathPreserved ? '一致' : '发生变化'}。`;
      if (!report.mathPreserved) mathSummary.className = 'error';
      box.append(mathSummary);
      for (const change of report.mathChanges || []) {
        const p = document.createElement('p');
        const reasons = [!change.structurePreserved && '数学结构或属性', !change.tokensPreserved && '数学字符', !change.annotationPreserved && '原始 TeX 注释'].filter(Boolean);
        p.textContent = `第 ${change.index} 个公式：${reasons.join('、')}变化。请检查保存后的公式，尤其是减号是否成为问号。`;
        box.append(p);
        for (const tokenChange of (change.tokenChanges || []).slice(0, 5)) {
          const detail = document.createElement('p');
          const describe = token => token ? `“${token.text}” (${(token.codePoints || []).join(' ')})` : '缺失';
          detail.textContent = `数学字符：${describe(tokenChange.before)} → ${describe(tokenChange.after)}。`;
          box.append(detail);
        }
      }
    }
    const changes = report.rows.filter(row => row.status !== 'unchanged');
    if (changes.length) {
      const table = document.createElement('table');
      const header = document.createElement('tr'); for (const value of ['变化项', '保存前', '回读后']) { const cell = document.createElement('th'); cell.textContent = value; header.append(cell); } table.append(header);
      for (const row of changes) { const tr = document.createElement('tr'); for (const value of [`${row.kind}: ${row.feature}`, row.before, row.after]) { const td = document.createElement('td'); td.textContent = value; td.className = 'changed'; tr.append(td); } table.append(tr); } box.append(table);
    } else { const p = document.createElement('p'); p.textContent = '未检测到标签或样式数量变化。数学字符结果见上方；仍需检查真实页面的显示效果。'; box.append(p); }
    for (const note of report.notes) { const p = document.createElement('p'); p.textContent = note; box.append(p); }
    for (const change of report.imageChanges || []) {
      const p = document.createElement('p');
      const describe = item => item ? `${item.width || '无宽度'} × ${item.height || '无高度'}；样式 ${JSON.stringify(item.style)}` : '无图片';
      p.textContent = `图片 ${change.index || '新增'}：${describe(change.before)} → ${describe(change.after)}。${change.note || ''}`;
      box.append(p);
    }
  } catch (error) { status(error.message, true); }
});
