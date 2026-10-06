import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const address = 'http://127.0.0.1:4317/';

function checkServer() {
  return new Promise((resolve, reject) => {
    const request = http.get(address, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 128 * 1024) response.destroy(new Error('4317 端口被其他程序占用。'));
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode === 200 && text.includes('<title>Word 转申报 HTML</title>')) resolve(true);
        else reject(new Error('4317 端口被其他程序占用，请检查后再启动。'));
      });
    });
    request.setTimeout(1500, () => request.destroy(new Error('4317 端口响应超时，请检查正在运行的程序。')));
    request.on('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
}

try {
  if (!await checkServer()) {
    const logRoot = path.join(root, 'output', 'server');
    mkdirSync(logRoot, { recursive: true });
    const stdout = openSync(path.join(logRoot, 'stdout.log'), 'a');
    const stderr = openSync(path.join(logRoot, 'stderr.log'), 'a');
    const child = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], {
      cwd: root, detached: true, windowsHide: true,
      env: { ...process.env, PORT: '4317' }, stdio: ['ignore', stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    let ready = false;
    // Loading dependencies after a Windows reboot can exceed ten seconds.
    for (let attempt = 0; attempt < 120; attempt++) {
      await delay(250);
      if (await checkServer()) { ready = true; break; }
    }
    if (!ready) throw new Error(`服务未能启动，请查看 ${path.join(logRoot, 'stderr.log')}`);
  }
  console.log(`本地工具已就绪：${address}\n请在浏览器打开或刷新此地址。服务在后台运行，关闭此窗口不会停止服务。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
