// 后台的生老病死：Antigravity 重启时旧后台常常没被关掉，占着浏览器的资料目录，
// 新后台的浏览器就起不来（2026-10-12 实际出过）。这里验两道保险：
//   1. 新后台启动时，请登记在册的旧后台让位退出；
//   2. Antigravity 的语言服务不在了，后台自己退出，浏览器跟着退。
// 用法：node tests/lifecycle.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'wb-life-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loader = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js');

const page = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>首页</title><p>首页</p>');
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));

// 扮成 Antigravity 的语言服务：只要这个端口连得上，后台就认为 Antigravity 还在。
const languageServer = net.createServer((socket) => {
  // 后台探一下就把连接掐掉，这边会收到一个连接重置，不算错。
  socket.on('error', () => {});
  socket.end();
});
await new Promise((resolve) => languageServer.listen(0, '127.0.0.1', resolve));

function startSidecar(port) {
  const child = spawn(process.execPath, ['--import=' + pathToFileURL(loader).href, 'main.mjs'], {
    cwd: join(root, 'sidecars', 'panel'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${languageServer.address().port}`,
      ANTIGRAVITY_CSRF_TOKEN: 'life',
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
      ANTIGRAVITY_SIDECAR_UI_TOKEN: 'life-token',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      WORKBENCH_LS_CHECK_MS: '400',
      WORKBENCH_YIELD_GUARD_MS: '1500',
    },
  });
  const state = { child, log: '', exited: false };
  child.stdout.on('data', (chunk) => { state.log += chunk; });
  child.stderr.on('data', (chunk) => { state.log += chunk; });
  child.on('exit', () => { state.exited = true; });
  return state;
}

const endpoint = () => JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8'));
const agent = async (query) => {
  const { port, key } = endpoint();
  return (await fetch(`http://127.0.0.1:${port}/api/agent?key=${key}&${query}`)).json();
};
async function waitFor(what, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value = false;
    try {
      value = await check();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(150);
  }
}
async function browsers() {
  if (process.platform !== 'win32') return -1;
  const list = spawn('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${dataDir.replace(/'/g, "''")}*' -and $_.CommandLine -notmatch '--type=' }).Count`], { windowsHide: true });
  let out = '';
  list.stdout.on('data', (chunk) => { out += chunk; });
  await new Promise((resolve) => list.on('exit', resolve));
  return Number(out.trim());
}

const results = [];
let failed = false;
async function step(name, work) {
  try {
    await work();
    results.push(`  通过  ${name}`);
  } catch (error) {
    failed = true;
    results.push(`  失败  ${name}\n        ${String(error.message).split('\n').slice(0, 10).join('\n        ')}`);
  }
}

let first;
let second;
try {
  await step('第一个后台起来，浏览器开着', async () => {
    first = startSidecar(4793);
    await waitFor('第一个后台的 endpoint.json', () => existsSync(join(dataDir, 'endpoint.json')) && endpoint().port === 4793);
    assert.equal((await agent('op=ensure')).ok, true);
    assert.equal((await agent('op=status')).running, true);
    assert.equal(await browsers(), 1);
  });

  await step('第二个后台起来（好比 Antigravity 重启了）：第一个被请走，它的浏览器跟着退', async () => {
    await sleep(1800); // 过了「刚启动的不动」那个保护期
    second = startSidecar(4794);
    await waitFor('第一个后台退出', () => first.exited, 20000);
    await waitFor('endpoint.json 换成第二个', () => endpoint().port === 4794);
    assert.match(second.log, /上一个后台（进程 \d+）还开着，让它退出/);
    assert.match(first.log, /新的后台起来了，这个让位退出/);
    await waitFor('第一个后台的浏览器退干净', async () => (await browsers()) === 0, 30000);
  });

  await step('第二个后台能把浏览器起起来（资料目录没被占着）', async () => {
    const woke = await agent('op=ensure');
    assert.equal(woke.ok, true, JSON.stringify(woke));
    const status = await agent('op=status');
    assert.equal(status.running, true);
    assert.equal(await browsers(), 1);
  });

  await step('语言服务没了（好比 Antigravity 被关掉）：后台自己退出，浏览器跟着退', async () => {
    languageServer.close();
    await waitFor('第二个后台退出', () => second.exited, 20000);
    assert.match(second.log, /语言服务不在了/);
    await waitFor('浏览器退干净', async () => (await browsers()) === 0, 30000);
  });
} finally {
  first?.child.kill('SIGKILL');
  second?.child.kill('SIGKILL');
  page.close();
  languageServer.close();
  await sleep(1500);
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // 留给系统清
  }
  console.log(results.join('\n'));
  if (failed) console.log('\n---- 第一个后台 ----\n' + (first?.log || '').slice(-1200) + '\n---- 第二个后台 ----\n' + (second?.log || '').slice(-1200));
  console.log(failed ? '\n有失败项' : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
