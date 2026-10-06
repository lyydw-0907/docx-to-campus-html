import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { convertDocx } from './convert.mjs';

const HELP = `Usage: node src/cli.mjs input.docx [options]

  --out DIRECTORY       Output directory (default: output/<input name>)
  --images MODE         embedded | files | mapped (default: embedded)
  --font-mode MODE      word | uniform (default: uniform)
  --font-size PX        Word-size fallback or uniform font size (default: 16)
  --scale NUMBER        PNG pixel-density multiplier, 1–4 (default: 3)
  --formula-format TYPE png | svg | mathml (default: png)
  --asset-urls JSON     JSON file: { "asset-filename.png": "https://..." }
  --pandoc PATH         Pandoc executable (or use PANDOC_PATH)
  --help                Show this message

Output: fragment.html, preview.html, manifest.json, assets/
MathML sample equations passed the HZAU draft save-and-reopen test.
Each converted document still needs its own save-and-reopen check.
`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const inputPath = path.resolve(args.shift());
  if (path.extname(inputPath).toLowerCase() !== '.docx') throw new Error('输入文件必须为 .docx。');
  const options = { fontMode: 'uniform' };
  let out = path.resolve('output', path.basename(inputPath, path.extname(inputPath)));
  const recognized = new Set(['--out', '--images', '--font-mode', '--font-size', '--scale', '--formula-format', '--asset-urls', '--pandoc']);
  while (args.length) {
    const argument = args.shift();
    const equals = argument.indexOf('=');
    const key = equals < 0 ? argument : argument.slice(0, equals);
    if (!recognized.has(key)) throw new Error(`未知参数：${key}。使用 --help 查看用法。`);
    const value = equals < 0 ? args.shift() : argument.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要参数值。`);
    if (key === '--out') out = path.resolve(value);
    if (key === '--images') options.imageMode = value;
    if (key === '--font-mode') {
      if (!['word', 'uniform'].includes(value)) throw new Error('字号模式应为 word 或 uniform。');
      options.fontMode = value;
    }
    if (key === '--font-size') options.fontSize = Number(value);
    if (key === '--scale') options.scale = Number(value);
    if (key === '--formula-format') options.formulaFormat = value;
    if (key === '--asset-urls') options.assetUrls = JSON.parse(await readFile(path.resolve(value), 'utf8'));
    if (key === '--pandoc') options.pandocPath = path.resolve(value);
  }
  const result = await convertDocx(await readFile(inputPath), options);
  await mkdir(path.join(out, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(path.join(out, 'fragment.html'), result.fragment, 'utf8'),
    writeFile(path.join(out, 'preview.html'), result.preview, 'utf8'),
    writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8'),
    ...result.assets.map((asset) => writeFile(path.join(out, 'assets', asset.filename), asset.data)),
  ]);
  process.stdout.write(`已导出 ${out}\n原生公式 ${result.manifest.formulas.length} 个，图片资产 ${result.assets.length} 个。\n学校保存兼容性：未验证。\n`);
  for (const warning of result.manifest.warnings) process.stderr.write(`提示：${warning}\n`);
}

main().catch((error) => {
  process.stderr.write(`转换失败：${error.message}\n`);
  process.exitCode = 1;
});
