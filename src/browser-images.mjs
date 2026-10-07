import { Buffer } from 'buffer';

const MAX_PIXELS = 40_000_000;
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function boundedDimensions(format, width, height, orientation) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new Error('图片像素数量超过 4000 万限制，或尺寸无效。');
  }
  return { format, width, height, ...(orientation ? { orientation } : {}) };
}

function exifOrientation(data) {
  if (data.length < 14 || data.subarray(0, 6).toString('binary') !== 'Exif\0\0') return undefined;
  const tiff = data.subarray(6);
  const endian = tiff.subarray(0, 2).toString();
  if (endian !== 'II' && endian !== 'MM') return undefined;
  const short = offset => endian === 'II' ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const long = offset => endian === 'II' ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  if (short(2) !== 42) return undefined;
  const directory = long(4);
  if (directory + 2 > tiff.length) return undefined;
  const count = short(directory);
  if (directory + 2 + count * 12 > tiff.length) return undefined;
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12;
    if (short(entry) === 0x0112 && short(entry + 2) === 3 && long(entry + 4) === 1) {
      const orientation = short(entry + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : undefined;
    }
  }
  return undefined;
}

/** Inspect encoded dimensions before a browser decoder can allocate a large bitmap. */
export function inspectBrowserImage(bytes) {
  const data = Buffer.from(bytes);
  if (data.length >= 24 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && data.subarray(12, 16).toString() === 'IHDR') {
    return boundedDimensions('png', data.readUInt32BE(16), data.readUInt32BE(20));
  }
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString())) {
    return boundedDimensions('gif', data.readUInt16LE(6), data.readUInt16LE(8));
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let width, height, orientation;
    let cursor = 2;
    while (cursor + 4 <= data.length) {
      if (data[cursor++] !== 0xff) throw new Error('JPEG 文件结构损坏。');
      while (data[cursor] === 0xff) cursor++;
      const marker = data[cursor++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = data.readUInt16BE(cursor);
      if (size < 2 || cursor + size > data.length) throw new Error('JPEG 数据长度无效。');
      if (marker === 0xe1) orientation = exifOrientation(data.subarray(cursor + 2, cursor + size)) ?? orientation;
      if (JPEG_FRAMES.has(marker)) {
        if (size < 8) throw new Error('JPEG 尺寸数据无效。');
        height = data.readUInt16BE(cursor + 3);
        width = data.readUInt16BE(cursor + 5);
      }
      cursor += size;
    }
    return boundedDimensions('jpeg', width, height, orientation);
  }
  if (data.length >= 20 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') {
    let cursor = 12;
    while (cursor + 8 <= data.length) {
      const chunk = data.subarray(cursor, cursor + 4).toString();
      const length = data.readUInt32LE(cursor + 4);
      const start = cursor + 8;
      if (start + length > data.length) throw new Error('WebP 数据长度无效。');
      if (chunk === 'VP8X' && length >= 10) {
        return boundedDimensions('webp', data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1);
      }
      if (chunk === 'VP8L' && length >= 5 && data[start] === 0x2f) {
        const bits = data.readUInt32LE(start + 1);
        return boundedDimensions('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === 'VP8 ' && length >= 10 && data.subarray(start + 3, start + 6).toString('hex') === '9d012a') {
        return boundedDimensions('webp', data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff);
      }
      cursor = start + length + (length & 1);
    }
  }
  throw new Error('只支持 Word 中嵌入的 PNG、JPEG、GIF 或 WebP 图片。');
}

/** Verify the embedded image is genuinely decodable; no URL or network resource is read. */
export async function browserImageMetadata(bytes) {
  const metadata = inspectBrowserImage(bytes);
  if (typeof globalThis.createImageBitmap !== 'function') throw new Error('当前浏览器不支持图片解码，请使用新版 Edge、Chrome 或 Firefox。');
  const mime = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`;
  const bitmap = await globalThis.createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
  try {
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    const raw = bitmap.width === metadata.width && bitmap.height === metadata.height;
    const oriented = rotated && bitmap.width === metadata.height && bitmap.height === metadata.width;
    if (!raw && !oriented) throw new Error('图片实际尺寸与编码头不一致。');
  } finally {
    bitmap.close();
  }
  return metadata;
}
