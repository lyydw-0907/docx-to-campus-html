import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, stat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { makeDemoDocx, makeProgressDemoDocx } from '../src/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output', 'browser');
await mkdir(output, { recursive: true });
const replaceOnce = (text, from, to, name) => {
  if (!text.includes(from)) throw new Error(`浏览器适配位置已变化：${name}`);
  return text.replace(from, to);
};

const browserUi = {
  name: 'campus-browser-ui',
  setup(builder) {
    builder.onResolve({ filter: /^\/(?:image-mapping|job-recovery|section-view|image-order|site-visits|progress-actions)\.js$/ }, args => ({ path: path.join(root, 'public', args.path.slice(1)) }));
    builder.onResolve({ filter: /^cheerio$/ }, () => ({ path: path.join(root, 'browser', 'html.js') }));
    builder.onLoad({ filter: /[\\/]public[\\/](?:app|image-mapping)\.js$/ }, async args => {
      let text = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      if (args.path.endsWith('app.js')) {
        text = `import {localRequest, assetUrl} from '../browser/client.js';\n${text}`;
        text = text.replace(/\bfetch\(/g, 'localRequest(');
        text = replaceOnce(text, 'getCurrent: () => current,\n', 'getCurrent: () => current,\n  fetchRequest: localRequest,\n', 'recovery transport');
        text = replaceOnce(text,
          "const source = image.getAttribute('src');\n      if (source?.startsWith('/api/assets/')) image.src = source.replace(/^\\/api\\/assets\\/[a-f\\d-]{36}\\//, `/api/assets/${result.jobId}/`);",
          "if (image.dataset.assetFilename) image.src = assetUrl(result.jobId, image.dataset.assetFilename);", 'recovered asset URLs');
        text = replaceOnce(text, 'image.src = `/api/assets/${result.jobId}/${encodeURIComponent(asset.filename)}`;', 'image.dataset.assetFilename = asset.filename; image.src = assetUrl(result.jobId, asset.filename);', 'asset URLs');
      } else {
        text = `import {assetUrl} from '../browser/client.js';\n${text}`;
        text = replaceOnce(text, 'image.src = `/api/assets/${current.jobId}/${encodeURIComponent(entry.filename)}`;', 'image.dataset.assetFilename = entry.filename; image.src = assetUrl(current.jobId, entry.filename);', 'order asset URLs');
      }
      return { contents: text.replaceAll('\r\n', '\n'), loader: 'js', resolveDir: path.dirname(args.path) };
    });
  },
};

const common = { bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], conditions: ['browser'], minify: true, legalComments: 'eof',
  inject: [path.join(root, 'browser', 'buffer.js')], plugins: [browserUi], logLevel: 'warning', metafile: true };
const built = await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'public', 'app.js')], outfile: path.join(output, 'app.js') }),
  build({ ...common, entryPoints: [path.join(root, 'browser', 'worker.js')], outfile: path.join(output, 'worker.js') }),
]);
const inputs = built.flatMap(item => Object.keys(item.metafile.inputs));
if (inputs.some(name => /(?:sharp|undici|node:)/.test(name))) throw new Error('浏览器包意外包含本机服务依赖。');
await mkdir(path.join(root, 'output', 'browser-checks'), { recursive: true });
await writeFile(path.join(root, 'output', 'browser-checks', 'build-meta.json'), JSON.stringify(built.map(item => item.metafile), null, 2));
await rm(path.join(output, 'build-meta.json'), { force: true });

let html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
const visitEndpoint = process.env.VISIT_COUNTER_ENDPOINT || '';
if (visitEndpoint && visitEndpoint !== '/api/visits') throw new Error('访问统计接口仅支持同源 /api/visits。');
html = replaceOnce(html, '<meta name="campus-visit-counter" content="">', `<meta name="campus-visit-counter" content="${visitEndpoint}">`, 'visit counter configuration');
html = html.replaceAll('href="/style.css"', 'href="./style.css"').replaceAll('href="/"', 'href="./"')
  .replaceAll('src="/app.js"', 'src="./app.js"').replaceAll('href="/api/demo-docx"', 'href="./demo.docx"')
  .replaceAll('href="/api/demo-docx?documentType=progress"', 'href="./progress-demo.docx"');
html = html.replace('<title>Word 转申报 HTML</title>', '<title>华农大创 Word 转 HTML · 浏览器版</title>')
  .replace('<head>', '<head><link rel="icon" href="data:,">')
  .replace('本机处理 · 无需学校账号', '浏览器内处理 · Word 不上传')
  .replace('华中农业大学大创申报辅助工具 / 原型 0.1', '华中农业大学大创申报辅助工具 / 浏览器测试版')
  .replace('公式可保留数学结构或生成高清图片，并保留已有编号。', '公式使用原生 MathML，并保留已有编号。')
  .replace('<option value="png">高清图片（PNG）</option>', '')
  .replace('<select id="formula-format">', '<select id="formula-format" aria-label="公式输出" disabled>')
  .replace('<label>图片清晰度', '<label hidden>图片清晰度')
  .replace('<button id="convert"', '<button id="cancel-conversion" hidden>取消转换</button><button id="convert"')
  .replace('</footer>', ' · <a href="./THIRD_PARTY_NOTICES.md">组件许可</a> · <a href="./browser-source.zip" download>下载源代码</a></footer>')
  .replace('原生公式的合成样例已通过学校暂存回读；其他公式和正式提交效果未验证。此工具不会登录学校系统或提交申报材料。',
    '浏览器版仅支持 MathML，Word 和学校图片源码在当前浏览器内处理。本地版的学校实测记录保留；此浏览器版的新输出仍需核对。本工具不会登录或提交学校申报。');
await writeFile(path.join(output, 'index.html'), html);
await cp(path.join(root, 'public', 'style.css'), path.join(output, 'style.css'));
await writeFile(path.join(output, 'demo.docx'), await makeDemoDocx());
await writeFile(path.join(output, 'progress-demo.docx'), await makeProgressDemoDocx());
const wasm = await readFile(path.join(root, 'node_modules', 'pandoc-wasm', 'src', 'pandoc.wasm'));
await rm(path.join(output, 'pandoc.wasm'), { force: true });
await writeFile(path.join(output, 'pandoc.wasm.gz'), gzipSync(wasm, { level: 9 }));
await writeFile(path.join(output, 'LICENSE'), await readFile(path.join(root, 'LICENSE')));
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'));
await mkdir(path.join(output, 'licenses'), { recursive: true });
for (const name of await readdir(path.join(root, 'tools', 'licenses'))) await cp(path.join(root, 'tools', 'licenses', name), path.join(output, 'licenses', name));
const dependencies = new Set();
for (const input of inputs) {
  const marker = input.lastIndexOf('node_modules/');
  if (marker < 0) continue;
  const parts = input.slice(marker + 'node_modules/'.length).split('/');
  dependencies.add(path.resolve(root, input.slice(0, marker + 'node_modules/'.length), ...parts.slice(0, parts[0].startsWith('@') ? 2 : 1)));
}
const components = [];
for (const directory of [...dependencies].sort()) {
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const slug = `${pkg.name.replaceAll('/', '-')}-${pkg.version}`;
  const licenses = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.\-_]|$)/i.test(name));
  if (!licenses.length && pkg.name === 'boolbase' && pkg.version === '1.0.0') {
    // The published 1.0.0 tarball declares ISC but omits the upstream text.
    await cp(path.join(root, 'tools', 'licenses', 'boolbase-ISC.txt'), path.join(output, 'licenses', `${slug}-LICENSE`));
  } else if (!licenses.length) throw new Error(`浏览器依赖缺少版权文本：${pkg.name}`);
  for (const filename of licenses) {
    if ((await stat(path.join(directory, filename))).isFile()) await cp(path.join(directory, filename), path.join(output, 'licenses', `${slug}-${filename}`));
  }
  components.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.repository?.url || pkg.repository || pkg.homepage });
}
await writeFile(path.join(output, 'licenses', 'components.json'), JSON.stringify(components, null, 2));
await writeFile(path.join(output, '使用说明.txt'), '浏览器静态版，仅支持 MathML。\n将本目录通过 HTTPS 静态托管，或运行 npm run preview:browser。直接双击 index.html 不能启动 Worker。\n文档在浏览器内处理；所有引擎与依赖已自包含。普通图片仍需在学校上传后映射真实地址。\n第一次需下载转换引擎；后续当前会话复用。官方 Pandoc WASM 采用 GPL-2.0-or-later，来源：https://github.com/jgm/pandoc 和 https://github.com/pandoc/pandoc-wasm 。\n本包可独立上传至托管平台，部署不需要更新 GitHub。访问次数需使用 Cloudflare 包并配置生产数据库与站点 origin。\n');
// Ship the editable project sources alongside the static bundle. Limit this to
// source directories and named config files; never copy workspace output/input.
const sourceZip = new JSZip();
async function addSources(directory, relative) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'pandoc' || entry.name === 'node_modules') continue;
    const name = `${relative}/${entry.name}`;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await addSources(filename, name);
    else if (entry.isFile()) sourceZip.file(name, await readFile(filename));
  }
}
for (const directory of ['src', 'browser', 'public', 'tools', 'functions', 'migrations', 'cloudflare']) await addSources(path.join(root, directory), directory);
for (const filename of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/cloudflare-visits.md']) sourceZip.file(filename, await readFile(path.join(root, filename)));
sourceZip.file('UPSTREAM-SOURCES.txt', 'Official unmodified engine: Pandoc 3.9, GPL-2.0-or-later.\nSource: https://github.com/jgm/pandoc/tree/3.9\nWASM build scripts: https://github.com/jgm/pandoc/tree/3.9/wasm\nWrapper: https://github.com/pandoc/pandoc-wasm/tree/v1.1.0\nDependency versions and source repositories: licenses/components.json and package-lock.json in this distribution.\nRebuild this app: npm ci; npm run build:browser.\n');
await writeFile(path.join(output, 'browser-source.zip'), await sourceZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
const names = ['index.html', 'app.js', 'worker.js', 'style.css', 'demo.docx', 'progress-demo.docx', 'pandoc.wasm.gz', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'browser-source.zip', '使用说明.txt'];
const zip = new JSZip();
for (const name of names) zip.file(name, await readFile(path.join(output, name)));
for (const name of await readdir(path.join(output, 'licenses'))) zip.file(`licenses/${name}`, await readFile(path.join(output, 'licenses', name)));
await writeFile(path.join(root, 'output', 'campus-mathml-browser.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`浏览器版已生成：${output}\n引擎 ${(wasm.length / 1024 / 1024).toFixed(1)} MB；压缩传输 ${((await stat(path.join(output, 'pandoc.wasm.gz'))).size / 1024 / 1024).toFixed(1)} MB。\n运行 npm run preview:browser 可本地检查。`);
