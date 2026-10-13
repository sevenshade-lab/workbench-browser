#!/usr/bin/env node
// 给 agent 用的小命令，和「工作台浏览器」面板后台说话。
//
//   node wb.mjs status          浏览器开没开、开着哪些页
//   node wb.mjs open <网址>      在当前标签页打开网址
//
// 加 --json 输出原始 JSON。命令失败时退出码是 1，并说明原因。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.WORKBENCH_BROWSER_DATA
  || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'workbench-browser', 'panel', 'data');
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const asJson = process.argv.includes('--json');
const [command, ...rest] = args;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function ask(query) {
  let endpoint;
  try {
    endpoint = JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8'));
  } catch {
    fail('「工作台浏览器」插件没在运行：请在 Antigravity 的 Customizations → Installed 里确认它已启用。');
  }
  const params = new URLSearchParams({ key: endpoint.key, ...query });
  let result;
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/agent?${params}`, { signal: AbortSignal.timeout(60000) });
    result = await response.json();
  } catch {
    fail('「工作台浏览器」插件后台没有响应。');
  }
  if (!result.ok) fail(result.error || '失败');
  return result;
}

switch (command) {
  case 'status': {
    const status = await ask({ op: 'status' });
    if (asJson) {
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    console.log(status.running ? `浏览器开着（${status.product}），面板${status.panels ? '开着' : '没开'}` : '浏览器没开（调用浏览器工具或打开面板时会自动启动）');
    for (const tab of status.tabs) console.log(`${tab.id === status.active ? '→' : ' '} ${tab.title || '（无标题）'}  ${tab.url}`);
    break;
  }
  case 'open': {
    if (!rest[0]) fail('用法：node wb.mjs open <网址>');
    await ask({ op: 'open', url: rest[0] });
    console.log('已打开');
    break;
  }
  default:
    fail('用法：node wb.mjs status | open <网址>   （加 --json 输出原始数据）');
}
