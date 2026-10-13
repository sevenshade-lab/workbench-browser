// The life cycle of the backend: when Antigravity restarts, the old backend is often not stopped and keeps
// the browser profile locked, so the browser of the new backend cannot start (this really happened on
// 2026-10-12). Two guards are checked here:
//   1. a starting backend asks the registered old backend to step down and exit;
//   2. when Antigravity's language server is gone, the backend exits by itself and the browser exits with it.
// Usage: node tests/lifecycle.mjs
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
  res.end('<!doctype html><meta charset="utf-8"><title>Home</title><p>Home</p>');
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));

// Pretends to be Antigravity's language server: as long as this port accepts connections, the backend
// believes Antigravity is still running.
const languageServer = net.createServer((socket) => {
  // The backend probes and drops the connection right away, so a connection reset arrives here; that is not an error.
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
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
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
    results.push(`  pass  ${name}`);
  } catch (error) {
    failed = true;
    results.push(`  FAIL  ${name}\n        ${String(error.message).split('\n').slice(0, 10).join('\n        ')}`);
  }
}

let first;
let second;
try {
  await step('the first backend starts and its browser is running', async () => {
    first = startSidecar(4793);
    await waitFor('endpoint.json of the first backend', () => existsSync(join(dataDir, 'endpoint.json')) && endpoint().port === 4793);
    assert.equal((await agent('op=ensure')).ok, true);
    assert.equal((await agent('op=status')).running, true);
    assert.equal(await browsers(), 1);
  });

  await step('the second backend starts (as if Antigravity had restarted): the first is asked to leave and its browser exits with it', async () => {
    await sleep(1800); // past the guard period during which a just-started backend is left alone
    second = startSidecar(4794);
    await waitFor('the first backend to exit', () => first.exited, 20000);
    await waitFor('endpoint.json to switch to the second backend', () => endpoint().port === 4794);
    assert.match(second.log, /the previous backend \(pid \d+\) is still running; asking it to exit/);
    assert.match(first.log, /a newer backend has started; this one steps down and exits/);
    await waitFor('the browser of the first backend to exit completely', async () => (await browsers()) === 0, 30000);
  });

  await step('the second backend can start the browser (the profile is not locked)', async () => {
    const woke = await agent('op=ensure');
    assert.equal(woke.ok, true, JSON.stringify(woke));
    const status = await agent('op=status');
    assert.equal(status.running, true);
    assert.equal(await browsers(), 1);
  });

  await step('the language server goes away (as if Antigravity had been closed): the backend exits by itself and the browser exits with it', async () => {
    languageServer.close();
    await waitFor('the second backend to exit', () => second.exited, 20000);
    assert.match(second.log, /language server is gone/);
    await waitFor('the browser to exit completely', async () => (await browsers()) === 0, 30000);
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
    // left for the system to clean up
  }
  console.log(results.join('\n'));
  if (failed) console.log('\n---- first backend ----\n' + (first?.log || '').slice(-1200) + '\n---- second backend ----\n' + (second?.log || '').slice(-1200));
  console.log(failed ? '\nSome steps failed' : '\nAll passed');
  process.exit(failed ? 1 : 0);
}
