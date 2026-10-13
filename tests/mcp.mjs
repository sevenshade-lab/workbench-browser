// Test of the agent path: without opening the panel, operate the browser only through the MCP entry that
// comes with the plugin (it forwards to the chrome-devtools-mcp bundled with Antigravity), and check that
// it really attaches to the browser managed by the panel backend and that an idle browser can be woken.
// Usage: node tests/mcp.mjs
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
  res.end(`<!doctype html><meta charset="utf-8"><title>Agent test page</title>
<h1>Agent test page</h1><button id="b" onclick="document.getElementById('out').textContent = 'button was clicked'">Click me</button>
<label>Name <input id="name"></label><p id="out">waiting</p>`);
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
    results.push(`  pass  ${name}`);
  } catch (error) {
    failed = true;
    results.push(`  FAIL  ${name}\n        ${String(error.message).split('\n').slice(0, 12).join('\n        ')}`);
  }
}

let mcp;
let mcpErrors = '';
let nextId = 1;
const waiting = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`${method} got no reply within 60 seconds\n${mcpErrors.slice(-600)}`)), 60000);
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
  await step('the panel backend starts', async () => {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(dataDir, 'endpoint.json'))) {
      if (Date.now() > deadline) throw new Error('endpoint.json never appeared');
      await sleep(50);
    }
  });

  await step('the MCP entry completes the handshake, and the tool list has tools for reading and operating pages', async () => {
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
        // non-protocol output the server prints now and then
      }
    });
    const hello = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workbench-browser-test', version: '0' } });
    assert.ok(hello.result?.serverInfo, JSON.stringify(hello));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await request('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name);
    for (const needed of ['list_pages', 'navigate_page', 'take_snapshot', 'click', 'fill', 'take_screenshot']) {
      assert.ok(names.includes(needed), `missing tool ${needed}; available: ${names.join(', ')}`);
    }
    assert.ok(!names.includes('emulate') && !names.includes('resize_page'), 'the tools that change the viewport should be turned off');
    results.push(`        ${names.length} tools: ${names.join(', ')}`);
  });

  let pageId;
  await step('the browser was not running: the first tool call wakes it, and it attaches to the very one the backend manages', async () => {
    const before = await (await fetch(`http://127.0.0.1:${PORT}/api/agent?op=status&key=${JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8')).key}`)).json();
    assert.equal(before.running, false);
    const pages = await call('list_pages');
    assert.equal(pages.isError, false, pages.text);
    assert.ok(pages.text.includes('about:blank'), `list_pages should include the blank page opened by the backend:\n${pages.text}`);
    pageId = Number(/^(\d+):/m.exec(pages.text)?.[1]);
    assert.ok(Number.isInteger(pageId), `could not parse the page id:\n${pages.text}`);
    const opened = await call('navigate_page', { pageId, type: 'url', url: pageUrl });
    assert.equal(opened.isError, false, opened.text);
    const after = await (await fetch(`http://127.0.0.1:${PORT}/api/agent?op=status&key=${JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8')).key}`)).json();
    assert.equal(after.running, true);
    assert.equal(after.tabs.length, 1);
  });

  let buttonUid;
  let inputUid;
  await step('read the page structure (accessibility tree) and get element ids', async () => {
    const snapshot = await call('take_snapshot', { pageId });
    assert.equal(snapshot.isError, false, snapshot.text);
    assert.match(snapshot.text, /Agent test page/);
    buttonUid = /uid=(\S+)\s+button "Click me"/.exec(snapshot.text)?.[1];
    inputUid = /uid=(\S+)\s+textbox "Name"/.exec(snapshot.text)?.[1];
    assert.ok(buttonUid && inputUid, `the button or the input was not found:\n${snapshot.text}`);
  });

  await step('click and fill by id, then read back to verify', async () => {
    const clicked = await call('click', { pageId, uid: buttonUid });
    assert.equal(clicked.isError, false, clicked.text);
    const filled = await call('fill', { pageId, uid: inputUid, value: 'non-ASCII 测试' }); // not plain ASCII on purpose
    assert.equal(filled.isError, false, filled.text);
    const snapshot = await call('take_snapshot', { pageId });
    assert.match(snapshot.text, /button was clicked/);
    assert.match(snapshot.text, /non-ASCII 测试/);
  });

  await step('the backend sees what the agent did too (same page)', async () => {
    const key = JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8')).key;
    const status = await (await fetch(`http://127.0.0.1:${PORT}/api/agent?op=status&key=${key}`)).json();
    assert.equal(status.tabs[0].title, 'Agent test page');
    assert.equal(status.tabs[0].url, pageUrl);
  });

  await step('when the plugin backend is absent, the tool says so honestly instead of pretending to succeed (once in Chinese, once in English)', async () => {
    for (const [lang, expected] of [['zh', /没在运行/], ['en', /is not running/]]) {
      const lonely = spawn(process.execPath, [join(root, 'mcp', 'launch.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, WORKBENCH_BROWSER_DATA: join(dataDir, 'nowhere'), WORKBENCH_LANG: lang },
      });
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no reply')), 30000);
        createInterface({ input: lonely.stdout }).on('line', (line) => {
          try {
            const message = JSON.parse(line);
            if (message.id === 7) {
              clearTimeout(timer);
              resolve(message);
            }
          } catch {
            // ignore
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
    // left for the system to clean up
  }
  console.log(results.join('\n'));
  if (failed) console.log('\n---- backend log ----\n' + sidecarLog.slice(-1500) + '\n---- MCP error output ----\n' + mcpErrors.slice(-1500));
  console.log(failed ? '\nSome steps failed' : '\nAll passed');
  process.exit(failed ? 1 : 0);
}
