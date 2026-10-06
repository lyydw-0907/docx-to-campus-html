import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeDemoDocx } from '../src/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const input = path.join(root, 'output', 'demo.docx');
await mkdir(path.dirname(input), { recursive: true });
await writeFile(input, await makeDemoDocx());
const result = spawnSync(process.execPath, [path.join(root, 'src', 'cli.mjs'), input, '--out', path.join(root, 'output', 'demo'), '--images', 'embedded'], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
