import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { renderFormula } from './math.mjs';
import { convertDocxWithRuntime } from './convert-core.mjs';
export { normalizeListParagraphStyles, sanitizeHtml } from './convert-core.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_OUTPUT = 32 * 1024 * 1024;

export async function resolvePandocPath(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.PANDOC_PATH) return process.env.PANDOC_PATH;
  const local = path.join(PROJECT_ROOT, 'tools', 'pandoc', process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
  try { await access(local); return local; } catch { return 'pandoc'; }
}

function runPandoc(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let size = 0;
    let errorSize = 0;
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Pandoc 转换超过 60 秒，请缩小文档后重试。')); }, 60_000);
    child.stdout.on('data', (data) => {
      size += data.length;
      if (size > MAX_OUTPUT) { child.kill(); finish(new Error('转换结果超过 32 MB 限制。')); }
      else chunks.push(data);
    });
    child.stderr.on('data', (data) => { if (errorSize < 1024 * 1024) { errors.push(data); errorSize += data.length; } });
    child.on('error', (error) => finish(new Error(error.code === 'ENOENT' ? '未找到 Pandoc。请运行 npm run setup:pandoc，或配置 PANDOC_PATH。' : `Pandoc 启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`Pandoc 转换失败（${code}）：${Buffer.concat(errors).toString('utf8').slice(0, 1200)}`));
      else finish(null, { stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}


const nativeRuntime = {
  inflate: (data, maximum) => inflateRawSync(data, { maxOutputLength: maximum }),
  digest: data => createHash('sha256').update(data).digest('hex').slice(0, 16),
  imageMetadata: data => sharp(data, { limitInputPixels: 40_000_000 }).metadata(),
  renderFormula,
  async createSession(options) {
    const temp = await mkdtemp(path.join(tmpdir(), 'docx-campus-'));
    const mediaRoot = path.join(temp, 'media');
    const inputFile = path.join(temp, 'input.docx');
    try {
      const pandoc = await resolvePandocPath(options.pandocPath);
      return {
        async readDocx(input) {
          await writeFile(inputFile, input);
          return runPandoc(pandoc, ['--from=docx+styles', '--to=json', `--extract-media=${mediaRoot}`, inputFile]);
        },
        writeAst: (input, { mathml = false } = {}) => runPandoc(pandoc, ['--from=json', '--to=html5', ...(mathml ? ['--mathml'] : []), '--wrap=none'], input),
        async readImage(target) {
          const actual = await realpath(path.resolve(target)).catch(() => { throw new Error('文档图片未能提取。请检查图片是否已嵌入 Word。'); });
          const root = await realpath(mediaRoot);
          const relative = path.relative(root, actual);
          if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('图片路径超出本次转换的隔离目录。');
          return { data: await readFile(actual), name: path.basename(actual) };
        },
        dispose: () => rm(temp, { recursive: true, force: true })
      };
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
};

/** Native conversion keeps the existing API; browser conversion shares the same formatting core. */
export function convertDocx(input, options = {}) {
  return convertDocxWithRuntime(input, options, nativeRuntime);
}
