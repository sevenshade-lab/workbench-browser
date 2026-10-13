// agent 这条路的测试：不开面板，只通过插件带的 MCP 入口（转发到 Antigravity 自带的 chrome-devtools-mcp）
// 去操作浏览器，看它是不是真的接在面板后台管的那个浏览器上、空着的时候能不能被叫醒。
// 用法：node tests/mcp.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'wb-mcp-'));
const PORT = 4792;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>代理测试页</title>
<h1>代理测试页</h1><button id="b" onclick="document.getElementById('out').textContent = '点到了'">点我</button>
<label>书名 <input id="name"></label><p id="out">还没点</p>`);
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

const loader = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js');
const sidecar = spawn(process.execPath, ['--import=' + pathToFileURL(loader).href, 'main.mjs'], {
  cwd: join(root, 'sidecars', 'panel'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: 'mcp-test',
    ANTIGRAVITY_CSRF_TOKEN: 'mcp-test',
    ANTIGRAVITY_SIDECAR_WEB_PORT: String(PORT),
    ANTIGRAVITY_SIDECAR_UI_TOKEN: 'mcp-test-token',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
  },
});
let sidecarLog = '';
sidecar.stdout.on('data', (chunk) => { sidecarLog += chunk; });
sidecar.stderr.on('data', (chunk) => { sidecarLog += chunk; });

const results = [];
let failed = false;
async function step(name, work) {
  try {
    await work();
    results.push(`  通过  ${name}`);
  } catch (error) {
    failed = true;
    results.push(`  失败  ${name}\n        ${String(error.message).split('\n').slice(0, 12).join('\n        ')}`);
  }
}

let mcp;
let mcpErrors = '';
let nextId = 1;
const waiting = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`${method} 60 秒没有回应\n${mcpErrors.slice(-600)}`)), 60000);
  waiting.set(id, (message) => {
    clearTimeout(timer);
    resolve(message);
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args = {}) => {
  const message = await request('tools/call', { name, arguments: args });
  const text = (message.result?.content || []).map((item) => item.text || '').join('\n');
  return { text, isError: !!message.result?.isError, raw: message };
};

try {
  await step('面板后台起来', async () => {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(dataDir, 'endpoint.json'))) {
      if (Date.now() > deadline) throw new Error('没等到 endpoint.json');
      await sleep(50);
    }
  });

  await step('MCP 入口能握手，工具列表里有读页面和操作页面的工具', async () => {
    mcp = spawn(process.execPath, [join(root, 'mcp', 'launch.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WORKBENCH_BROWSER_DATA: dataDir },
    });
    mcp.stderr.on('data', (chunk) => { mcpErrors += chunk; });
    createInterface({ input: mcp.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (waiting.has(message.id)) {
          waiting.get(message.id)(message);
          waiting.delete(message.id);
        }
      } catch {
        // 服务端偶尔打的非协议输出
      }
    });
    const hello = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workbench-browser-test', version: '0' } });
    assert.ok(hello.result?.serverInfo, JSON.stringify(hello));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await request('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name);
    for (const needed of ['list_pages', 'navigate_page', 'take_snapshot', 'click', 'fill', 'take_screenshot']) {
      assert.ok(names.includes(needed), `缺工具 ${needed}；现有：${names.join(', ')}`);
    }
    assert.ok(!names.includes('emulate') && !names.includes('resize_page'), '改视口的工具应该已经关掉');
    results.push(`        工具 ${names.length} 个：${names.join(', ')}`);
  });

  let pageId;
  await step('浏览器本来没开：第一次调工具把它叫醒，并且接上的就是后台管的那个', async () => {
    const before = await (await fetch(`http://127.0.0.1:${PORT}/api/agent?op=status&key=${JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8')).key}`)).json();
    assert.equal(before.running, false);
    const pages = await call('list_pages');
    assert.equal(pages.isError, false, pages.text);
    assert.ok(pages.text.includes('about:blank'), `list_pages 里应该有后台开的空白页：\n${pages.text}`);
    pageId = Number(/^(\d+):/m.exec(pages.text)?.[1]);
    assert.ok(Number.isInteger(pageId), `没解析出页面编号：\n${pages.text}`);
    const opened = await call('navigate_page', { pageId, type: 'url', url: pageUrl });
    assert.equal(opened.isError, false, opened.text);
    const after = await (await fetch(`http://127.0.0.1:${PORT}/api/agent?op=status&key=${JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8')).key}`)).json();
    assert.equal(after.running, true);
    assert.equal(after.tabs.length, 1);
  });

  let buttonUid;
  let inputUid;
  await step('读页面结构（无障碍树），拿到元素编号', async () => {
    const snapshot = await call('take_snapshot', { pageId });
    assert.equal(snapshot.isError, false, snapshot.text);
    assert.match(snapshot.text, /代理测试页/);
    buttonUid = /uid=(\S+)\s+button "点我"/.exec(snapshot.text)?.[1];
    inputUid = /uid=(\S+)\s+textbox "书名"/.exec(snapshot.text)?.[1];
    assert.ok(buttonUid && inputUid, `没找到按钮或输入框：\n${snapshot.text}`);
  });

  await step('按编号点击、填写，再读回来核对', async () => {
    const clicked = await call('click', { pageId, uid: buttonUid });
    assert.equal(clicked.isError, false, clicked.text);
    const filled = await call('fill', { pageId, uid: inputUid, value: '测试书名' });
    assert.equal(filled.isError, false, filled.text);
    const snapshot = await call('take_snapshot', { pageId });
    assert.match(snapshot.text, /点到了/);
    assert.match(snapshot.text, /测试书名/);
  });

  await step('后台也看得到 agent 做的事（同一个页面）', async () => {
    const key = JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8')).key;
    const status = await (await fetch(`http://127.0.0.1:${PORT}/api/agent?op=status&key=${key}`)).json();
    assert.equal(status.tabs[0].title, '代理测试页');
    assert.equal(status.tabs[0].url, pageUrl);
  });

  await step('插件后台不在时，工具如实报「没在运行」，不装作成功（中文、英文各说一遍）', async () => {
    for (const [lang, expected] of [['zh', /没在运行/], ['en', /is not running/]]) {
      const lonely = spawn(process.execPath, [join(root, 'mcp', 'launch.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, WORKBENCH_BROWSER_DATA: join(dataDir, 'nowhere'), WORKBENCH_LANG: lang },
      });
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('没回应')), 30000);
        createInterface({ input: lonely.stdout }).on('line', (line) => {
          try {
            const message = JSON.parse(line);
            if (message.id === 7) {
              clearTimeout(timer);
              resolve(message);
            }
          } catch {
            // 忽略
          }
        });
        lonely.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }) + '\n');
      });
      lonely.kill();
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, expected);
    }
  });
} finally {
  mcp?.kill();
  sidecar.kill('SIGKILL');
  page.close();
  await sleep(1500);
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // 留给系统清
  }
  console.log(results.join('\n'));
  if (failed) console.log('\n---- 后台日志 ----\n' + sidecarLog.slice(-1500) + '\n---- MCP 错误输出 ----\n' + mcpErrors.slice(-1500));
  console.log(failed ? '\n有失败项' : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
