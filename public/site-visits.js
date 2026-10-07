const initializations = new WeakMap();
const MAX_RESPONSE_BYTES = 4096;

function isTopLevel() {
  try { return typeof window !== 'undefined' && window.top === window.self; }
  catch { return false; }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}

function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || ['.localhost', '.local', '.internal', '.lan', '.home'].some(suffix => host.endsWith(suffix))) return true;
  if (!host.includes('.') && !host.startsWith('[')) return true;
  if (isPrivateIpv4(host)) return true;
  if (!host.startsWith('[')) return false;
  const ipv6 = host.slice(1, -1);
  if (ipv6 === '::' || ipv6 === '::1' || /^(?:f[cd][\da-f]{2}|fe[89ab][\da-f]|ff[\da-f]{2}):/i.test(ipv6)) return true;
  const mapped = ipv6.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1], 16); const low = Number.parseInt(mapped[2], 16);
  return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

function configuredEndpoint(document, location, topLevel) {
  if (!topLevel || !location?.href) return undefined;
  const content = document.querySelector('meta[name="campus-visit-counter"]')?.content;
  if (typeof content !== 'string') return undefined;
  const path = content.trim();
  if (!path || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\\?#]/.test(path)) return undefined;
  const page = new URL(location.href);
  if (page.protocol !== 'https:' || page.username || page.password || isLocalHostname(page.hostname)) return undefined;
  const endpoint = new URL(path, page);
  if (endpoint.origin !== page.origin || endpoint.search || endpoint.hash) return undefined;
  return endpoint.href;
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (match[5] !== 'Z' && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4, 6)) > 59)) return false;
  const day = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1]
    && Number.isFinite(Date.parse(value));
}

async function readCount(response, signal) {
  if (!response?.ok) throw new Error('Visit counter unavailable');
  const mediaType = response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw new Error('Invalid visit counter response');
  const length = response.headers?.get('content-length');
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new Error('Visit counter response too large');
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0; const chunks = [];
    const cancel = () => {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw new Error('Visit counter aborted');
        const { value, done } = await reader.read();
        if (signal.aborted) throw new Error('Visit counter aborted');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('Visit counter response too large');
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode()); text = chunks.join('');
    } catch (error) {
      cancel();
      throw error;
    } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('Visit counter response too large');
  }
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.total) || result.total < 0 || !validTimestamp(result.since)) {
    throw new Error('Invalid visit counter response');
  }
  return { total: result.total, since: result.since };
}

/** Count one public top-level page view. Disabled or failed statistics remain hidden. */
export function startSiteVisits({
  document = globalThis.document, location = globalThis.location, fetchRequest = globalThis.fetch,
  topLevel = isTopLevel(), timeoutMs = 5000,
} = {}) {
  let element; let endpoint;
  try {
    element = document?.getElementById('site-visits');
    if (!element) return Promise.resolve(null);
    if (initializations.has(element)) return initializations.get(element);
    element.hidden = true; element.textContent = ''; element.title = '';
    endpoint = configuredEndpoint(document, location, topLevel);
    if (!endpoint || typeof fetchRequest !== 'function' || typeof AbortController === 'undefined') return Promise.resolve(null);
  } catch { return Promise.resolve(null); }

  const controller = new AbortController(); let timer;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 5000;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Visit counter timeout')); }, deadline);
  });
  const request = Promise.resolve().then(() => fetchRequest(endpoint, {
    method: 'POST', headers: { Accept: 'application/json' },
    credentials: 'omit', referrer: '', referrerPolicy: 'strict-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    signal: controller.signal,
  })).then(response => readCount(response, controller.signal));
  const initialization = Promise.race([request, timeout]).then(result => {
    element.textContent = `累计访问 ${new Intl.NumberFormat('zh-CN').format(result.total)} 次`;
    element.title = `自 ${result.since} 启用统计起累计；每次打开或刷新计 1 次，不代表独立访客人数。`;
    element.hidden = false;
    return result;
  }).catch(() => {
    controller.abort(); element.hidden = true; element.textContent = ''; element.title = '';
    return null;
  }).finally(() => clearTimeout(timer));
  initializations.set(element, initialization);
  return initialization;
}
