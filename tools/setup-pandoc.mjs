import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

const version = '3.6.4';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'tools', 'pandoc');
const platforms = {
  'win32-x64': `pandoc-${version}-windows-x86_64.zip`,
  'linux-x64': `pandoc-${version}-linux-amd64.tar.gz`,
};
const filename = platforms[`${process.platform}-${process.arch}`];
if (!filename) throw new Error('Automatic setup supports Windows x64 and Linux x64. Install Pandoc 3.6.4 yourself and set PANDOC_PATH on other platforms.');
const executable = path.join(destination, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
const correctVersion = output => String(output || '').split(/\r?\n/, 1)[0].trim().replace(/^pandoc\.exe\b/, 'pandoc') === `pandoc ${version}`;
const existing = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
if (existing.status === 0 && correctVersion(existing.stdout)) {
  const cached = await readFile(path.join(destination, filename)).catch(() => undefined);
  if (cached) {
    const digest = createHash('sha256').update(cached).digest('hex');
    if (process.env.PANDOC_ARCHIVE_SHA256 && digest !== process.env.PANDOC_ARCHIVE_SHA256.toLowerCase()) throw new Error('Pandoc archive SHA-256 does not match PANDOC_ARCHIVE_SHA256.');
    await writeFile(path.join(destination, 'download.json'), JSON.stringify({ version, url: `https://github.com/jgm/pandoc/releases/download/${version}/${filename}`, sha256: digest, checkedAgainstProvidedHash: Boolean(process.env.PANDOC_ARCHIVE_SHA256) }, null, 2));
  }
  console.log(`Pandoc ${version} is ready: ${executable}`);
  process.exit(0);
}
await mkdir(destination, { recursive: true });
const url = `https://github.com/jgm/pandoc/releases/download/${version}/${filename}`;
const archivePath = path.join(destination, filename);
let archive;
try { archive = await readFile(archivePath); }
catch {
  console.log(`Downloading pinned official release: ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Pandoc download failed: HTTP ${response.status}. Download the same official release manually and set PANDOC_PATH.`);
  archive = Buffer.from(await response.arrayBuffer());
  await writeFile(archivePath, archive);
}
if (archive.length > 100 * 1024 * 1024) throw new Error('Unexpectedly large Pandoc archive.');
const digest = createHash('sha256').update(archive).digest('hex');
if (process.env.PANDOC_ARCHIVE_SHA256 && digest !== process.env.PANDOC_ARCHIVE_SHA256.toLowerCase()) {
  throw new Error('Pandoc archive SHA-256 does not match PANDOC_ARCHIVE_SHA256.');
}
if (filename.endsWith('.zip')) {
  const zip = await JSZip.loadAsync(archive);
  const entry = Object.values(zip.files).find(item => !item.dir && /(^|\/)pandoc\.exe$/.test(item.name));
  if (!entry) throw new Error('Official archive has no pandoc.exe.');
  await writeFile(executable, await entry.async('nodebuffer'));
} else {
  await writeFile(archivePath, archive);
  // The pinned official archive contains a single pandoc-VERSION/bin/pandoc entry.
  const member = `pandoc-${version}/bin/pandoc`;
  const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', destination, member], { encoding: 'utf8', windowsHide: true });
  if (extracted.status !== 0) throw new Error(`tar failed: ${extracted.stderr}`);
  await writeFile(executable, await readFile(path.join(destination, member)));
  await chmod(executable, 0o755);
}
await stat(executable);
const check = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
if (check.status !== 0 || !correctVersion(check.stdout)) throw new Error('The downloaded engine did not report the expected version.');
await writeFile(path.join(destination, 'download.json'), JSON.stringify({ version, url, sha256: digest, checkedAgainstProvidedHash: Boolean(process.env.PANDOC_ARCHIVE_SHA256) }, null, 2));
console.log(`Pandoc ${version} is ready. Archive SHA-256: ${digest}`);
