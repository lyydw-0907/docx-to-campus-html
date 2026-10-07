import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, 'output', 'cloudflare');
// Only replace this build's generated directory, never source or user inputs.
if (path.relative(root, output) !== path.join('output', 'cloudflare')) throw new Error('Invalid Cloudflare output directory');
const staticZip = await JSZip.loadAsync(await readFile(path.join(root, 'output', 'campus-mathml-browser.zip')), { checkCRC32: true });
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const zip = new JSZip();
for (const file of Object.values(staticZip.files)) {
  if (file.dir) continue;
  const target = path.resolve(output, file.name);
  const relative = path.relative(output, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || file.name.includes('\\')) throw new Error('Invalid static package entry');
  let bytes = await file.async('nodebuffer');
  if (file.name === 'index.html') {
    const html = bytes.toString('utf8');
    if (!/<meta name="campus-visit-counter" content="(?:|\/api\/visits)">/.test(html)) throw new Error('Missing visit counter configuration');
    bytes = Buffer.from(html.replace(/<meta name="campus-visit-counter" content="(?:|\/api\/visits)">/, '<meta name="campus-visit-counter" content="/api/visits">'));
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  zip.file(file.name, bytes);
}
await build({ entryPoints: [path.join(root, 'cloudflare', 'worker.js')], outfile: path.join(output, '_worker.js'),
  bundle: true, platform: 'browser', format: 'esm', target: ['es2022'], minify: true, legalComments: 'eof', logLevel: 'warning' });
const routes = JSON.stringify({ version: 1, include: ['/api/visits'], exclude: [] }, null, 2);
await writeFile(path.join(output, '_routes.json'), routes);
zip.file('_worker.js', await readFile(path.join(output, '_worker.js')));
zip.file('_routes.json', routes);
await writeFile(path.join(root, 'output', 'campus-cloudflare.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
await cp(path.join(root, 'migrations', '0001_site_visits.sql'), path.join(root, 'output', 'cloudflare-setup.sql'));
await cp(path.join(root, 'docs', 'cloudflare-visits.md'), path.join(root, 'output', 'cloudflare-setup.md'));
console.log(`Cloudflare 部署包已生成：${output}\n累计访问量需设置 VISITS_DB 和生产站点 VISIT_COUNTER_ORIGIN 后启用。\n本命令没有登录、创建云数据库或部署网站。`);
