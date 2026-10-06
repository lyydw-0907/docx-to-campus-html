const JOB_ROUTES = new Set(['import-images', 'export', 'upload-images']);
const ASSET_FIELDS = ['filename', 'mime', 'kind', 'width', 'height', 'uploadFilename'];

// Preserve array order while comparing object data independently of key order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function identity(result) {
  return JSON.stringify(canonical({
    fragment: result.fragment,
    assets: result.assets.map(asset => Object.fromEntries(ASSET_FIELDS.map(field => [field, asset[field]]))),
    formulas: result.manifest.formulas,
    options: result.manifest.options,
    sections: result.sections?.map(({ id, title, kind, fragment, assetFilenames, formulaCount, imageCount }) =>
      ({ id, title, kind, fragment, assetFilenames, formulaCount, imageCount })),
  }));
}

async function isExpired(response) {
  if (response.status !== 410) return false;
  try { return (await response.clone().json())?.code === 'JOB_EXPIRED'; }
  catch { return false; }
}

/** Retain local conversion inputs in memory and restore lost server jobs once. */
export function createJobRecovery({ getCurrent, fetchRequest = fetch, onRecovering, onRecovered }) {
  let active;
  let generation = 0;

  function remember(result, input, params) {
    active = { result, input, params: new URLSearchParams(params).toString(), identity: identity(result), generation: ++generation };
  }

  function clear() { active = undefined; generation++; }

  function assertActive(session) {
    if (!session || active !== session || session.generation !== generation || getCurrent() !== session.result) {
      throw new Error('当前文档已变化，请重新操作。');
    }
  }

  async function recover(session) {
    assertActive(session);
    if (!session.pending) session.pending = (async () => {
      onRecovering?.(session.result);
      assertActive(session);
      const response = await fetchRequest(`/api/convert?${session.params}`, {
        method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: session.input,
      });
      assertActive(session);
      const restored = await response.json();
      assertActive(session);
      if (!response.ok) throw new Error(restored?.error || '本地转换恢复失败，请保留学校源码后重试。');
      if (!restored || !Array.isArray(restored.assets) || !restored.manifest
        || typeof restored.jobId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(restored.jobId)
        || identity(restored) !== session.identity) {
        throw new Error('恢复后的正文、公式或图片与原转换不一致，已停止操作。粘贴的学校源码和图片地址仍保留。');
      }
      const previousJobId = session.result.jobId;
      session.result.jobId = restored.jobId;
      onRecovered?.(session.result, previousJobId);
    })();
    const pending = session.pending;
    try { await pending; }
    finally { if (session.pending === pending) session.pending = undefined; }
  }

  async function request(route, init) {
    if (!JOB_ROUTES.has(route)) throw new Error('未知的本地转换操作。');
    const session = active;
    assertActive(session);
    const requestedJobId = session.result.jobId;
    const response = await fetchRequest(`/api/${route}/${requestedJobId}`, init);
    assertActive(session);
    if (!await isExpired(response)) return response;
    assertActive(session);
    // Another request may already have restored this job while ours was pending.
    if (session.result.jobId === requestedJobId) await recover(session);
    assertActive(session);
    const retried = await fetchRequest(`/api/${route}/${session.result.jobId}`, init);
    assertActive(session);
    return retried;
  }

  return { remember, clear, request };
}
