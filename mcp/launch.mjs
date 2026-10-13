#!/usr/bin/env node
// agent 的浏览器工具：把 Antigravity 自带的 chrome-devtools-mcp 接到面板里那个浏览器上，
// 所以 agent 读的、点的、填的，就是侧边栏里人正看着的那几页。
//
// 这个脚本自己不实现任何工具，只做转发；外加一件事：agent 每次调工具之前，
// 先确认浏览器开着（空闲久了会自动关掉省内存），没开就叫醒。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dataDir = process.env.WORKBENCH_BROWSER_DATA
  || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'workbench-browser', 'panel', 'data');
const profileDir = join(dataDir, 'browser-profile');

function findServer() {
  const relative = ['resources', 'app.asar.unpacked', 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js'];
  const candidates = [
    process.env.CHROME_DEVTOOLS_MCP,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', ...relative),
    join('/Applications/Antigravity.app/Contents', ...relative.map((part) => (part === 'resources' ? 'Resources' : part))),
  ];
  return candidates.find((path) => path && existsSync(path)) || null;
}

async function wake() {
  let endpoint;
  try {
    endpoint = JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8'));
  } catch {
    throw new Error('「工作台浏览器」插件没在运行：请在 Antigravity 的 Customizations → Installed 里确认它已启用。');
  }
  let result;
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/agent?op=ensure&key=${endpoint.key}`, { signal: AbortSignal.timeout(40000) });
    result = await response.json();
  } catch {
    throw new Error('「工作台浏览器」插件后台没有响应：请在 Antigravity 的 Customizations → Installed 里把它关掉再打开。');
  }
  if (!result.ok) throw new Error(`内置浏览器没能启动：${result.error}`);
}

const server = findServer();
if (!server) {
  console.error('没找到 Antigravity 自带的 chrome-devtools-mcp。可以用环境变量 CHROME_DEVTOOLS_MCP 指给它入口脚本的完整路径。');
  process.exit(1);
}

const child = spawn(process.execPath, [
  server,
  '--autoConnect',
  `--userDataDir=${profileDir}`,
  '--no-usage-statistics',
  '--no-performance-crux',
  // 改视口大小、模拟设备会和面板抢；性能分析用不上。两类都不给，工具列表也短些。
  '--no-category-emulation',
  '--no-category-performance',
  // 网络请求里的 Cookie、令牌之类不交给 agent。
  '--redactNetworkHeaders',
], {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
  // 它是随 Antigravity 装的，升不升级跟着 Antigravity 走，不用自己去网上查新版本。
  env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
child.stdin.on('error', () => {});

// MCP 的 stdio 传输是一行一个 JSON。逐行转发，保证顺序；只有 tools/call 需要先叫醒浏览器。
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  queue = queue.then(async () => {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      // 不是 JSON 就原样转过去，让真正的服务端去报错
    }
    if (message && message.method === 'tools/call') {
      try {
        await wake();
      } catch (error) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: error.message }], isError: true },
        }) + '\n');
        return;
      }
    }
    child.stdin.write(line + '\n');
  });
});
lines.on('close', () => {
  queue.then(() => child.stdin.end());
});
