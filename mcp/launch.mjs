#!/usr/bin/env node
// The agent's browser tools: connects the chrome-devtools-mcp bundled with Antigravity to the browser behind
// the panel, so what the agent reads, clicks and fills in is the very pages the user is looking at in the
// side panel.
//
// This script implements no tools itself; it only forwards. One more thing: before each tool call from the
// agent it makes sure the browser is running (it closes by itself after a long idle time to save memory)
// and wakes it if not.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { say } from '../sidecars/panel/lib/lang.mjs';

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
    throw new Error(say(
      '「工作台浏览器」插件没在运行：请在 Antigravity 的 Customizations → Installed 里确认它已启用。',
      'The workbench-browser plugin is not running. Check that it is enabled under Customizations → Installed in Antigravity.',
    ));
  }
  let result;
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/agent?op=ensure&key=${endpoint.key}`, { signal: AbortSignal.timeout(40000) });
    result = await response.json();
  } catch {
    throw new Error(say(
      '「工作台浏览器」插件后台没有响应：请在 Antigravity 的 Customizations → Installed 里把它关掉再打开。',
      'The workbench-browser plugin backend is not responding. Turn the plugin off and on again under Customizations → Installed in Antigravity.',
    ));
  }
  if (!result.ok) throw new Error(say(`内置浏览器没能启动：${result.error}`, `The built-in browser could not start: ${result.error}`));
}

const server = findServer();
if (!server) {
  console.error(say(
    '没找到 Antigravity 自带的 chrome-devtools-mcp。可以用环境变量 CHROME_DEVTOOLS_MCP 指给它入口脚本的完整路径。',
    'The chrome-devtools-mcp bundled with Antigravity was not found. Set the CHROME_DEVTOOLS_MCP environment variable to the full path of its entry script.',
  ));
  process.exit(1);
}

const child = spawn(process.execPath, [
  server,
  '--autoConnect',
  `--userDataDir=${profileDir}`,
  '--no-usage-statistics',
  '--no-performance-crux',
  // Resizing the viewport and emulating devices would fight with the panel, and performance profiling is not
  // needed. Neither category is offered, which also keeps the tool list shorter.
  '--no-category-emulation',
  '--no-category-performance',
  // Cookies, tokens and the like in network requests are not handed to the agent.
  '--redactNetworkHeaders',
], {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
  // It is installed with Antigravity and is upgraded with Antigravity; no need to check online for new versions.
  env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
child.stdin.on('error', () => {});

// The MCP stdio transport is one JSON per line. Forward line by line to keep the order; only tools/call
// needs the browser to be woken first.
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  queue = queue.then(async () => {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      // not JSON: pass it on as is and let the real server report the error
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
