import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, closeSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const address = 'http://127.0.0.1:4318/';
function ready() {
  return new Promise((resolve, reject) => {
    const request = http.get(address, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; if (text.length > 128 * 1024) response.destroy(new Error('4318 端口被其他程序占用。')); });
      response.on('error', reject);
      response.on('end', () => text.includes('<title>华农大创 Word 转 HTML · 浏览器版</title>') ? resolve(true) : reject(new Error('4318 端口被其他程序占用。')));
    });
    request.setTimeout(1500, () => request.destroy(new Error('浏览器版预览服务响应超时。')));
    request.on('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
}
try {
  if (!existsSync(path.join(root, 'output', 'browser', 'index.html'))) throw new Error('请先运行 npm run build:browser 生成浏览器版。');
  if (!await ready()) {
    const logs = path.join(root, 'output', 'browser-server');
    mkdirSync(logs, { recursive: true });
    const stdout = openSync(path.join(logs, 'stdout.log'), 'a');
    const stderr = openSync(path.join(logs, 'stderr.log'), 'a');
    const child = spawn(process.execPath, [path.join(root, 'tools', 'serve-browser.mjs')], { cwd: root, detached: true,
      windowsHide: true, env: { ...process.env, BROWSER_PORT: '4318' }, stdio: ['ignore', stdout, stderr] });
    closeSync(stdout); closeSync(stderr);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    let started = false;
    for (let attempt = 0; attempt < 60; attempt++) { await delay(250); if (await ready()) { started = true; break; } }
    if (!started) throw new Error('预览服务启动失败，请查看 output/browser-server/stderr.log。');
  }
  console.log(`浏览器版已就绪：${address}\n关闭启动窗口不会停止服务。`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
