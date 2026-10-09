import { conversionIdentity } from './job-recovery.js';

const MiB = 1024 * 1024;
const LIMITS = { source: 20 * MiB, metadata: 16 * MiB, archive: 38 * MiB };
const FORMAT = 'campus-work-progress';
const KEYS = ['format', 'version', 'sourceName', 'sourceSha256', 'conversionSha256', 'params', 'selectedSectionId', 'mapping'];
const PARAMS = ['documentType', 'fontMode', 'fontSize', 'scale', 'formulaFormat'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) value = crcTable[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const structureError = () => new Error('进度文件结构不受支持或已损坏；请导入本工具下载的原始进度 ZIP。');

// Check only JSON data here. Scope, row and clickable URL semantics are checked
// by imageMapping.validateState against the newly converted trusted document.
function validateJsonData(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 100_000 || depth > 32) throw new Error('进度数据过于复杂，无法保存或恢复。');
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !plainObject(item)) throw new Error('进度数据无效。');
    if (ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw new Error('进度数据无效。');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else {
      for (const key of Object.keys(item)) {
        if (FORBIDDEN_KEYS.has(key)) throw new Error('进度数据含危险对象键，无法恢复。');
        visit(item[key], depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

function checkedParams(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('进度文件的转换设置无效。');
  const params = new URLSearchParams(value);
  if ([...params].length !== PARAMS.length || PARAMS.some(key => params.getAll(key).length !== 1)
    || [...params.keys()].some(key => !PARAMS.includes(key))
    || !['application', 'progress'].includes(params.get('documentType'))
    || !['word', 'uniform'].includes(params.get('fontMode'))
    || !['14', '16', '18', '20'].includes(params.get('fontSize'))
    || !['2', '3', '4'].includes(params.get('scale'))
    || !['mathml', 'png'].includes(params.get('formulaFormat'))) throw new Error('进度文件的转换设置无效。');
  return params;
}

function validateMetadata(progress) {
  validateJsonData(progress);
  if (!plainObject(progress) || Object.keys(progress).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(progress, key))
    || Object.keys(progress).some(key => !KEYS.includes(key))) throw new Error('进度文件数据无效。');
  if (progress.format !== FORMAT) throw new Error('进度文件格式无效，请使用本工具下载的文件。');
  if (progress.version !== 1) throw new Error('当前工具不支持此进度文件版本，请更新工具后重试。');
  if (typeof progress.sourceName !== 'string' || !progress.sourceName.trim() || progress.sourceName.length > 256
    || /[\\/\u0000-\u001f\u007f]/.test(progress.sourceName) || !/\.docx$/i.test(progress.sourceName)) {
    throw new Error('进度文件中的原 Word 文件名无效。');
  }
  if (![progress.sourceSha256, progress.conversionSha256].every(hash => typeof hash === 'string' && /^[a-f\d]{64}$/.test(hash))) {
    throw new Error('进度文件的校验数据无效。');
  }
  checkedParams(progress.params);
  if (typeof progress.selectedSectionId !== 'string' || !progress.selectedSectionId || progress.selectedSectionId.length > 256
    || /[\u0000-\u001f\u007f]/.test(progress.selectedSectionId)) throw new Error('进度文件的复制栏目标识无效。');
  if (!plainObject(progress.mapping) || progress.mapping.version !== 1) throw new Error('进度文件的图片工作状态无效。');
}

async function bytes(input, limit, description) {
  let size;
  if (input instanceof Blob) size = input.size;
  else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) size = input.byteLength;
  else throw new Error(`${description}数据无效。`);
  if (!size) throw new Error(`${description}不能为空。`);
  if (size > limit) throw new Error(`${description}超过 ${limit / MiB} MB 限制。`);
  if (input instanceof Blob) {
    const data = new Uint8Array(await input.arrayBuffer());
    if (data.length !== size || data.length > limit) throw new Error(`${description}大小无效。`);
    return data;
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
}

async function sha256(input) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持进度校验，请使用 HTTPS 或本地工具。');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function identityBytes(result) {
  try { return encoder.encode(conversionIdentity(result)); }
  catch { throw new Error('转换结果无效，无法保存或恢复工作进度。'); }
}

/** A conversion fingerprint never includes a temporary job ID or preview URL. */
export async function fingerprintConversion(result) {
  return sha256(identityBytes(result));
}

// ZIP STORE is sufficient: the inner Word is already compressed. This fixed
// writer does not create folders, compressed entries, descriptors or ZIP64.
function encodeArchive(source, metadata) {
  const files = [{ name: 'source.docx', data: source }, { name: 'progress.json', data: metadata }]
    .map(file => ({ ...file, nameBytes: encoder.encode(file.name), crc: crc32(file.data) }));
  const centralSize = files.reduce((total, file) => total + 46 + file.nameBytes.length, 0);
  const centralOffset = files.reduce((total, file) => total + 30 + file.nameBytes.length + file.data.length, 0);
  const output = new Uint8Array(centralOffset + centralSize + 22);
  if (output.length > LIMITS.archive) throw new Error('进度文件超过 38 MB 限制。');
  const view = new DataView(output.buffer);
  let local = 0; let central = centralOffset;
  for (const file of files) {
    view.setUint32(local, 0x04034b50, true); view.setUint16(local + 4, 20, true);
    view.setUint16(local + 6, 0x0800, true); view.setUint16(local + 12, 0x0021, true);
    view.setUint32(local + 14, file.crc, true); view.setUint32(local + 18, file.data.length, true);
    view.setUint32(local + 22, file.data.length, true); view.setUint16(local + 26, file.nameBytes.length, true);
    output.set(file.nameBytes, local + 30); output.set(file.data, local + 30 + file.nameBytes.length);
    view.setUint32(central, 0x02014b50, true); view.setUint16(central + 4, 20, true); view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, 0x0800, true); view.setUint16(central + 14, 0x0021, true);
    view.setUint32(central + 16, file.crc, true); view.setUint32(central + 20, file.data.length, true);
    view.setUint32(central + 24, file.data.length, true); view.setUint16(central + 28, file.nameBytes.length, true);
    view.setUint32(central + 42, local, true); output.set(file.nameBytes, central + 46);
    local += 30 + file.nameBytes.length + file.data.length;
    central += 46 + file.nameBytes.length;
  }
  view.setUint32(central, 0x06054b50, true); view.setUint16(central + 8, 2, true); view.setUint16(central + 10, 2, true);
  view.setUint32(central + 12, centralSize, true); view.setUint32(central + 16, centralOffset, true);
  return output;
}

function decodeArchive(input) {
  if (input.length < 22) throw structureError();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const end = input.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
    || view.getUint16(end + 8, true) !== 2 || view.getUint16(end + 10, true) !== 2 || view.getUint16(end + 20, true)) throw structureError();
  const centralSize = view.getUint32(end + 12, true); const centralOffset = view.getUint32(end + 16, true);
  if (centralOffset + centralSize !== end || centralOffset < 60) throw structureError();
  const files = new Map(); const ranges = [];
  let cursor = centralOffset;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < 2; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw structureError();
    const flags = view.getUint16(cursor + 8, true); const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true); const compressed = view.getUint32(cursor + 20, true);
    const expanded = view.getUint32(cursor + 24, true); const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true); const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true); const next = cursor + 46 + nameLength;
    if (![0, 0x0800].includes(flags) || method !== 0 || compressed !== expanded || extraLength || commentLength
      || view.getUint16(cursor + 34, true) || next > end || !nameLength) throw structureError();
    let name;
    try { name = decoder.decode(input.subarray(cursor + 46, next)); } catch { throw structureError(); }
    if (!['source.docx', 'progress.json'].includes(name) || files.has(name)) throw structureError();
    const limit = name === 'source.docx' ? LIMITS.source : LIMITS.metadata;
    if (!expanded || expanded > limit) throw new Error(`进度文件中${name === 'source.docx' ? '原 Word' : '工作状态'}超过 ${limit / MiB} MB 限制或为空。`);
    if (local + 30 > centralOffset || view.getUint32(local, true) !== 0x04034b50
      || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method
      || view.getUint32(local + 14, true) !== crc || view.getUint32(local + 18, true) !== compressed
      || view.getUint32(local + 22, true) !== expanded || view.getUint16(local + 26, true) !== nameLength
      || view.getUint16(local + 28, true)) throw structureError();
    const dataOffset = local + 30 + nameLength; const dataEnd = dataOffset + expanded;
    if (dataEnd > centralOffset || input.subarray(local + 30, dataOffset).some((byte, offset) => byte !== input[cursor + 46 + offset])) throw structureError();
    const data = input.subarray(dataOffset, dataEnd);
    if (crc32(data) !== crc) throw new Error('进度文件 CRC 校验失败，文件已损坏。');
    files.set(name, data); ranges.push({ start: local, end: dataEnd }); cursor = next;
  }
  ranges.sort((left, right) => left.start - right.start);
  if (cursor !== end || files.size !== 2 || ranges[0].start !== 0 || ranges[0].end !== ranges[1].start || ranges[1].end !== centralOffset) throw structureError();
  return files;
}

/** Capture data only; never serialize cached converted HTML or temporary jobs. */
export async function createWorkProgress({ input, name, params, result, mapping, selectedSectionId }) {
  // Capture mutable caller state before reading a Blob or awaiting digests.
  validateJsonData(mapping);
  let mappingCopy;
  try { mappingCopy = JSON.parse(JSON.stringify(mapping)); } catch { throw new Error('进度数据无效。'); }
  const savedParams = params instanceof URLSearchParams ? params.toString() : params;
  const converted = identityBytes(result);
  const source = await bytes(input, LIMITS.source, '原 Word');
  const [sourceSha256, conversionSha256] = await Promise.all([sha256(source), sha256(converted)]);
  const progress = { format: FORMAT, version: 1, sourceName: name, sourceSha256, conversionSha256,
    params: savedParams, selectedSectionId, mapping: mappingCopy };
  validateMetadata(progress);
  const metadata = encoder.encode(JSON.stringify(progress));
  if (metadata.length > LIMITS.metadata) throw new Error('进度工作状态超过 16 MB 限制，请减少粘贴的学校源码后保存。');
  return encodeArchive(source, metadata);
}

/** Decode a bounded, fixed-entry archive. No saved HTML is rendered or fetched. */
export async function readWorkProgress(input) {
  const files = decodeArchive(await bytes(input, LIMITS.archive, '进度文件'));
  let progress;
  try { progress = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get('progress.json'))); }
  catch { throw new Error('进度工作状态无效或已损坏。'); }
  validateMetadata(progress);
  const source = files.get('source.docx').slice();
  if (await sha256(source) !== progress.sourceSha256) throw new Error('进度文件中的原 Word 校验不一致，已停止恢复。');
  return { source, progress };
}

/** Apply only to a fresh trusted conversion, before any workspace is changed. */
export async function validateRestoredProgress(progress, result) {
  validateMetadata(progress);
  const params = checkedParams(progress.params); const options = result?.manifest?.options;
  if (!options || options.imageMode !== 'embedded' || PARAMS.some(key => options[key] !== (['fontSize', 'scale'].includes(key) ? Number(params.get(key)) : params.get(key)))) {
    throw new Error('恢复后的转换设置与进度文件不一致，已停止恢复。');
  }
  if (progress.selectedSectionId !== 'whole' && !result.sections?.some(section => section.id === progress.selectedSectionId && ['field', 'unassigned'].includes(section.kind))) {
    throw new Error('进度文件中的复制栏目不存在，已停止恢复。');
  }
  if (await fingerprintConversion(result) !== progress.conversionSha256) throw new Error('恢复后的正文、公式或图片与进度文件不一致，已停止恢复。');
}
