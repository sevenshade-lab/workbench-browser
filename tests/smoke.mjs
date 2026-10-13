// End-to-end smoke test: starts a real panel backend and a real browser, connects pretending to be the panel,
// and checks the results one by one: clicking, typing, IME text, paste, copy, dropdowns, confirm boxes,
// new tabs, back and forward, visited pages.
// It uses a test page served temporarily on this machine and touches no real website.
// Usage: node tests/smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'wb-smoke-'));
const PORT = 4791;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST_PAGE = `<!doctype html><meta charset="utf-8"><title>{}</title>
<style>
  body { margin: 0; font: 16px sans-serif; }
  body > * { position: absolute; left: 20px; box-sizing: border-box; margin: 0; }
  #b { top: 20px; width: 100px; height: 30px; }
  #ta { top: 70px; width: 300px; height: 80px; }
  #ce { top: 170px; width: 300px; height: 80px; border: 1px solid #888; overflow: hidden; }
  #sel { top: 270px; width: 120px; height: 28px; }
  #c { top: 320px; width: 100px; height: 30px; }
  #link { top: 370px; }
  #f { top: 420px; width: 240px; height: 30px; }
</style>
<button id="b">Click me</button>
<textarea id="ta"></textarea>
<div id="ce" contenteditable="true"></div>
<select id="sel"><option>Alpha</option><option>Beta</option><option>Gamma</option></select>
<button id="c">Confirm box</button>
<a id="link" href="/second" target="_blank">Open a new page</a>
<input id="f" type="file">
<script>
  const out = { b: false, c: null, f: '' };
  f.onchange = () => { out.f = f.files.length ? f.files[0].name : ''; sync(); };
  const sync = () => {
    document.title = JSON.stringify({ ...out, ta: ta.value, ce: ce.innerText.trim(), sel: sel.value, key: window.lastKey || '', size: innerWidth + 'x' + innerHeight });
  };
  addEventListener('resize', sync);
  b.onclick = () => { out.b = true; sync(); };
  c.onclick = () => { out.c = confirm('Are you sure?'); sync(); };
  addEventListener('input', sync, true);
  addEventListener('change', sync, true);
  addEventListener('keydown', (event) => { window.lastKey = event.key; sync(); }, true);
  sync();
</script>`;

// A 1x1 transparent PNG, used as the icon of the test site.
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const fakeDesk = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const html = (text) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(text);
  };
  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(ICON);
  }
  if (url.pathname === '/second') return html('<!doctype html><meta charset="utf-8"><title>第二页</title><p>第二页</p>'); // the title is not ASCII on purpose
  return html(TEST_PAGE);
});
await new Promise((resolve) => fakeDesk.listen(0, '127.0.0.1', resolve));
const deskUrl = `http://127.0.0.1:${fakeDesk.address().port}`;

const loader = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js');
const sidecar = spawn(process.execPath, ['--import=' + pathToFileURL(loader).href, 'main.mjs'], {
  cwd: join(root, 'sidecars', 'panel'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: 'smoke',
    ANTIGRAVITY_CSRF_TOKEN: 'smoke',
    ANTIGRAVITY_SIDECAR_WEB_PORT: String(PORT),
    ANTIGRAVITY_SIDECAR_UI_TOKEN: 'smoke-token',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    // The language is not fixed: the steps below check that it follows what the panel reports.
    WORKBENCH_LANG: '',
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
    results.push(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`);
  }
}

// ---------- Pretending to be the panel ----------
let state = { tabs: [] };
const frames = { jpeg: 0, png: 0 };
const inbox = [];
let socket;
const send = (message) => socket.send(JSON.stringify(message));
const activeTab = () => state.tabs.find((tab) => tab.id === state.active);
const pageState = () => {
  try {
    return JSON.parse(activeTab().title);
  } catch {
    return {};
  }
};
async function waitFor(what, check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = check();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}\npage state: ${activeTab()?.title}\ntabs: ${JSON.stringify(state.tabs.map((tab) => tab.url))}`);
    await sleep(40);
  }
}
async function waitForAsync(what, check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(200);
  }
}
const click = async (x, y) => {
  send({ t: 'mouse', type: 'move', x, y, buttons: 0, mods: 0 });
  send({ t: 'mouse', type: 'down', x, y, button: 0, buttons: 1, clickCount: 1, mods: 0 });
  send({ t: 'mouse', type: 'up', x, y, button: 0, buttons: 0, clickCount: 1, mods: 0 });
  await sleep(120);
};
const press = (key, code, keyCode, mods = 0, text) => {
  send({ t: 'key', type: 'down', key, code, keyCode, mods, text });
  send({ t: 'key', type: 'up', key, code, keyCode, mods });
};
// A plain request as the panel makes it: a POST with the panel token.
const panelCall = (path, body = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'smoke-token' },
  body: JSON.stringify(body),
});
const agent = async (query) => {
  const { port, key } = JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}/api/agent?key=${key}&${query}`);
  return response.json();
};

// Run the small command the agent uses and collect what it says.
const runTool = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'tools', 'wb.mjs'), ...args], {
    env: { ...process.env, WORKBENCH_BROWSER_DATA: dataDir, ...env },
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  child.on('exit', (code) => resolve({ code, out }));
});

try {
  // What can be checked without starting the backend: the text in the panel.
  await step('the text in the panel: every key used by the page and the script exists in Chinese and in English; no hard-coded text is left in the page', async () => {
    const web = join(root, 'sidecars', 'panel', 'web');
    const holder = {};
    runInNewContext(readFileSync(join(web, 'strings.js'), 'utf8'), { window: holder });
    const strings = holder.workbenchStrings;
    for (const [key, entry] of Object.entries(strings)) {
      assert.ok(entry.zh && entry.en, `"${key}" is missing one of the two languages`);
      assert.ok(!/[\u4e00-\u9fff]/.test(entry.en), `the English text of "${key}" contains Chinese: ${entry.en}`);
    }
    const page = readFileSync(join(web, 'index.html'), 'utf8');
    const script = readFileSync(join(web, 'app.js'), 'utf8');
    const used = new Set(['appName']);
    for (const match of page.matchAll(/data-t(?:-title|-label|-placeholder)?="([^"]+)"/g)) used.add(match[1]);
    // Every key in a t('key') call in app.js, including the t(condition ? 'key' : 'key') form.
    for (const call of script.matchAll(/\bt\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      for (const match of call[1].matchAll(/'([A-Za-z]+)'/g)) used.add(match[1]);
    }
    assert.ok(used.size > 25, `only ${used.size} keys were found; the search itself is probably broken`);
    for (const key of used) assert.ok(strings[key], `"${key}" is used but missing from strings.js`);
    for (const key of Object.keys(strings)) assert.ok(used.has(key), `"${key}" in strings.js is not used anywhere`);
    const visible = page.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/[\u4e00-\u9fff]/.test(visible), 'index.html still contains hard-coded Chinese');
  });

  await step('the backend starts and writes endpoint.json', async () => {
    await waitFor('endpoint.json', () => existsSync(join(dataDir, 'endpoint.json')), 10000);
    const endpoint = JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8'));
    assert.equal(endpoint.port, PORT);
    assert.equal(endpoint.key.length, 48);
  });

  await step('a connection with the wrong key is refused; without the panel token the key cannot be obtained either', async () => {
    const outcome = await new Promise((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=wrong`);
      bad.onopen = () => resolve('opened');
      bad.onerror = () => resolve('refused');
    });
    assert.equal(outcome, 'refused');
    const anonymous = await fetch(`http://127.0.0.1:${PORT}/api/link`, { method: 'POST', body: '{}' });
    assert.equal(anonymous.status, 401);
  });

  await step('the agent wakes the browser first (no panel yet, so the screen scale factor is unknown)', async () => {
    const woke = await agent('op=ensure');
    assert.equal(woke.ok, true);
    assert.ok(woke.debugPort > 0);
  });

  await step('the panel connects, the browser starts, frames arrive (lossy first, then lossless once the picture is still)', async () => {
    // Like the real panel: ask for the port and the key with a plain request first (reporting the UI language
    // on the way), then connect directly. Chinese is reported, so the steps below that compare exact error
    // texts behave the same whatever the system language is.
    const link = await (await panelCall('/api/link', { lang: 'zh' })).json();
    assert.equal(link.ok, true);
    assert.equal(link.port, PORT);
    socket = new WebSocket(`ws://127.0.0.1:${link.port}/ws?key=${link.key}`);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.t === 'state') state = message;
        else inbox.push(message);
      } else {
        const bytes = Buffer.from(event.data);
        if (bytes[0] === 0xff) frames.jpeg += 1;
        else if (bytes[0] === 0x89) {
          frames.png += 1;
          frames.lastPngWidth = bytes.readUInt32BE(16);
        }
      }
    };
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('the panel cannot connect to the backend'));
    });
    send({ t: 'resize', width: 900, height: 600, dpr: 1.5 });
    // First use: there is only one blank page, on which the panel draws the new-tab page.
    await waitFor('the browser to be running with one tab', () => state.running && state.tabs.length === 1 && activeTab().url === 'about:blank', 30000);
    await waitFor('a lossy frame', () => frames.jpeg > 0, 10000);
    await waitFor('a lossless frame', () => frames.png > 0, 5000);
  });

  await step('new-tab page: before any page has been visited, Most visited and Recent are both empty', async () => {
    const start = await (await panelCall('/api/start')).json();
    assert.deepEqual(start, { ok: true, sites: [], recent: [], timeZone: '' });
  });

  await step('open the test page from the blank page', async () => {
    send({ t: 'nav', url: deskUrl + '/' });
    await waitFor('the test page to open', () => activeTab().url === deskUrl + '/' && !activeTab().loading && pageState().size);
  });

  await step('the browser was restarted at the scale factor of the panel: the picture has 1.5x the pixels instead of being upscaled and blurry', async () => {
    assert.equal(frames.lastPngWidth, 1350, `the panel is 900 wide at scale factor 1.5, so a frame should be 1350 pixels wide; got ${frames.lastPngWidth}`);
    assert.match(sidecarLog, /restarting the browser at the panel's scale factor 1\.5/);
  });

  await step('a still picture is not redrawn over and over', async () => {
    await sleep(600);
    const before = frames.jpeg + frames.png;
    await sleep(2500);
    assert.ok(frames.jpeg + frames.png - before <= 1, `${frames.jpeg + frames.png - before} more frames arrived during 2.5 seconds of stillness`);
  });

  await step('click', async () => {
    await click(70, 35);
    await waitFor('the button to be clicked', () => pageState().b === true);
  });

  await step('typing, Backspace and Enter on the keyboard', async () => {
    await click(100, 100);
    press('a', 'KeyA', 65, 0, 'a');
    press('B', 'KeyB', 66, 8, 'B');
    press('Backspace', 'Backspace', 8);
    press('Enter', 'Enter', 13, 0, '\r');
    press('c', 'KeyC', 67, 0, 'c');
    await waitFor('the textarea content', () => pageState().ta === 'a\nc');
  });

  await step('Chinese text committed by an IME', async () => {
    send({ t: 'text', text: '你好，世界' });
    await waitFor('the Chinese text to reach the textarea', () => pageState().ta === 'a\nc你好，世界');
  });

  await step('select all, copy back to the panel', async () => {
    press('a', 'KeyA', 65, 2);
    press('c', 'KeyC', 67, 2);
    send({ t: 'copy' });
    const message = await waitFor('the clipboard message', () => inbox.find((item) => item.t === 'clipboard'));
    assert.equal(message.text.replace(/\r\n/g, '\n'), 'a\nc你好，世界');
  });

  await step('how much picture traffic a blinking cursor in an input causes (measured, not judged)', async () => {
    const before = { ...frames };
    await sleep(3000);
    results.push(`        cursor blinking for 3 seconds: ${frames.jpeg - before.jpeg} lossy frames, ${frames.png - before.png} lossless frames`);
  });

  await step('paste several paragraphs into a rich-text box; they land as paragraphs', async () => {
    await click(100, 200);
    send({ t: 'paste', text: '第一段。\n第二段。' }); // not ASCII on purpose
    await waitFor('the rich-text box content', () => pageState().ce === '第一段。\n第二段。');
  });

  // The panel is dragged wider and narrower all the time. After a resize, the following steps still click
  // by page coordinates, and the clicks must still land in the right place (earlier, when Chrome emulated
  // the scale factor, they were off by a factor of two thirds).
  await step('the panel is resized and the page reflows', async () => {
    // The page writes its own width and height into the size field of its title, so check directly whether it
    // kept up. The resize is deliberately done right when the picture has just become still and the sharp frame
    // is being fetched: the screenshot command used for that earlier would wipe out the new size.
    for (const [width, height] of [[820, 560], [700, 520], [860, 580], [820, 560]]) {
      send({ t: 'text', text: '字' }); // type one character into the rich-text box so the picture moves
      await sleep(380 + Math.floor(Math.random() * 80));
      send({ t: 'resize', width, height, dpr: 1.5 });
      await waitFor(`the page to become ${width}x${height}`, () => pageState().size === `${width}x${height}`, 5000);
    }
  });

  await step('dropdown: the options are reported to the panel, and after picking one the page value follows', async () => {
    send({ t: 'mouse', type: 'down', x: 80, y: 284, button: 0, buttons: 1, clickCount: 1, mods: 0 });
    send({ t: 'mouse', type: 'up', x: 80, y: 284, button: 0, buttons: 0, clickCount: 1, mods: 0 });
    const menu = await waitFor('the dropdown options', () => inbox.find((item) => item.t === 'select'));
    assert.deepEqual(menu.options.map((option) => option.label), ['Alpha', 'Beta', 'Gamma']);
    assert.equal(menu.selected, 0);
    assert.ok(Math.abs(menu.rect.x - 20) < 1 && Math.abs(menu.rect.y - 270) < 1);
    send({ t: 'select.pick', index: 2 });
    await waitFor('the dropdown value', () => pageState().sel === 'Gamma');
  });

  await step('confirm box: answered in the panel, the page gets the result', async () => {
    await click(70, 335);
    const tab = await waitFor('the confirm box to appear', () => activeTab().dialog && activeTab());
    assert.equal(tab.dialog.type, 'confirm');
    assert.equal(tab.dialog.message, 'Are you sure?');
    send({ t: 'dialog', accept: true });
    await waitFor('the result of the confirm box', () => pageState().c === true);
  });

  await step('file chooser: the panel is told when the page asks for a file, and the page gets the file after a path is entered', async () => {
    await click(60, 435);
    await waitFor('the file chooser prompt', () => activeTab().fileChooser);
    send({ t: 'files', paths: [join(dataDir, 'endpoint.json')] });
    await waitFor('the page to get the file', () => pageState().f === 'endpoint.json');
    assert.equal(activeTab().fileChooser, null);
  });

  await step('the mouse moves over a link and the cursor shape is reported to the panel', async () => {
    inbox.length = 0;
    send({ t: 'mouse', type: 'move', x: 45, y: 380, buttons: 0, mods: 0 });
    await sleep(60);
    send({ t: 'mouse', type: 'move', x: 46, y: 381, buttons: 0, mods: 0 });
    const message = await waitFor('the cursor message', () => inbox.find((item) => item.t === 'cursor'));
    assert.equal(message.cursor, 'pointer');
  });

  await step('clicking a target=_blank link opens a new tab and switches to it', async () => {
    await click(50, 380);
    await waitFor('two tabs', () => state.tabs.length === 2 && activeTab().url === deskUrl + '/second' && activeTab().title === '第二页');
  });

  await step('address bar navigation, back, forward', async () => {
    send({ t: 'nav', url: deskUrl + '/?again' });
    await waitFor('the new address', () => activeTab().url === deskUrl + '/?again' && activeTab().canBack && !activeTab().loading);
    send({ t: 'back' });
    await waitFor('going back to the second page', () => activeTab().url === deskUrl + '/second' && activeTab().canForward);
    send({ t: 'forward' });
    await waitFor('going forward again', () => activeTab().url === deskUrl + '/?again');
  });

  await step('close a tab', async () => {
    const closing = state.active;
    send({ t: 'tab.close', id: closing });
    await waitFor('one tab to be left', () => state.tabs.length === 1 && state.active !== closing);
  });

  await step('agent endpoint: a wrong key is refused', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/agent?key=nope&op=status`);
    assert.deepEqual(await response.json(), { ok: false, error: '钥匙不对' });
  });

  await step('agent endpoint: the status includes the debug port, and the browser tools of the agent can attach to the same browser', async () => {
    const status = await agent('op=status');
    assert.equal(status.ok, true);
    assert.equal(status.panels, 1);
    assert.ok(status.debugPort > 0);
    const version = await (await fetch(`http://127.0.0.1:${status.debugPort}/json/version`)).json();
    assert.match(version.Browser, /Chrome|Edg/);
    const pages = await (await fetch(`http://127.0.0.1:${status.debugPort}/json/list`)).json();
    assert.ok(pages.some((page) => page.url.startsWith(deskUrl)), 'the pages in the panel are visible on the debug port');
  });

  await step('the + button opens a blank new tab, not some fixed site', async () => {
    send({ t: 'tab.new', url: 'about:blank' });
    await waitFor('a blank new tab', () => state.tabs.length === 2 && activeTab().url === 'about:blank');
  });

  await step('new-tab page: visited pages show up under Most visited and Recent, with titles and icons', async () => {
    const start = await waitForAsync('the icon to be fetched', async () => {
      const data = await (await panelCall('/api/start')).json();
      return data.sites.length && data.sites[0].icon ? data : null;
    });
    assert.equal(start.sites.length, 1, 'one site takes only one tile');
    assert.equal(start.sites[0].host, new URL(deskUrl).host);
    assert.match(start.sites[0].icon, /^data:image\/png;base64,/);
    const urls = start.recent.map((page) => page.url);
    assert.ok(urls.includes(deskUrl + '/second') && urls.includes(deskUrl + '/?again') && urls.includes(deskUrl + '/'), JSON.stringify(urls));
    assert.ok(!urls.includes('about:blank'), 'blank pages are not recorded');
    assert.equal(start.recent.find((page) => page.url === deskUrl + '/second').title, '第二页');
    for (let i = 1; i < start.recent.length; i++) assert.ok(start.recent[i - 1].last >= start.recent[i].last, 'the most recent comes first');
  });

  await step('clicking a visited page on the new-tab page opens it in this tab', async () => {
    send({ t: 'nav', url: deskUrl + '/second' });
    await waitFor('the second page', () => activeTab().url === deskUrl + '/second' && activeTab().title === '第二页');
    send({ t: 'tab.close', id: state.active });
    await waitFor('being back to one tab', () => state.tabs.length === 1 && activeTab().url.startsWith(deskUrl));
  });

  await step('clear the history', async () => {
    assert.deepEqual(await (await panelCall('/api/history-clear')).json(), { ok: true });
    const start = await (await panelCall('/api/start')).json();
    assert.deepEqual([start.sites, start.recent], [[], []]);
  });

  await step('without extensions, operations that only an extension provides do not exist', async () => {
    assert.deepEqual(await agent('op=board'), { ok: false, error: '没有这个操作' });
  });

  await step('back to the test page (the later steps need a page that has not been clicked)', async () => {
    await agent('op=open&url=' + encodeURIComponent(deskUrl + '/'));
    await waitFor('being back on the test page', () => activeTab().url === deskUrl + '/' && !activeTab().loading);
  });

  await step('no more frames after the panel is closed', async () => {
    socket.close();
    await sleep(500);
    const status = await agent('op=status');
    assert.equal(status.panels, 0);
    assert.equal(status.running, true);
  });

  // The fallback path for when the direct connection is not possible (Antigravity forwards only plain requests,
  // or it is viewed remotely from another device).
  await step('fallback path: with plain requests only, frames still arrive and the page can still be clicked', async () => {
    const link = await (await panelCall('/api/link')).json();
    const poll = async (frameSeq) => {
      const response = await panelCall('/api/poll', { session: link.session, frameSeq });
      assert.match(response.headers.get('content-type'), /octet-stream/);
      const buffer = Buffer.from(await response.arrayBuffer());
      const headLength = buffer.readUInt32BE(0);
      return { head: JSON.parse(buffer.subarray(4, 4 + headLength).toString('utf8')), frame: buffer.subarray(4 + headLength) };
    };
    let seq = 0;
    let frame = null;
    let title = '';
    const absorb = (result) => {
      for (const message of result.head.messages) {
        if (message.t === 'state') title = message.tabs.find((tab) => tab.id === message.active)?.title || '';
      }
      if (result.head.frameSeq > seq) {
        seq = result.head.frameSeq;
        frame = result.frame;
      }
    };
    // The real panel reports its size first and asks for the picture afterwards; the same order is followed here:
    // an /api/input that arrives first must be able to create the session too.
    const sized = await (await panelCall('/api/input', { session: link.session, messages: [{ t: 'resize', width: 900, height: 600, dpr: 1.5 }] })).json();
    assert.deepEqual(sized, { ok: true });
    const first = await poll(0);
    assert.ok(first.head.messages.some((message) => message.t === 'state'), 'the first poll should carry the current state');
    absorb(first);

    const until = async (what, done) => {
      const deadline = Date.now() + 15000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what} (title ${title})`);
        absorb(await poll(seq));
      }
    };
    await until('a frame', () => frame);
    assert.ok(frame[0] === 0xff || frame[0] === 0x89, 'what was fetched should be an image');
    assert.equal((await agent('op=status')).panels, 1);

    // At this point the page is the freshly reopened test page, and the button has not been clicked yet.
    assert.match(title, /"b":false/);
    await panelCall('/api/input', { session: link.session, messages: [
      { t: 'mouse', type: 'down', x: 70, y: 35, button: 0, buttons: 1, clickCount: 1, mods: 0 },
      { t: 'mouse', type: 'up', x: 70, y: 35, button: 0, buttons: 0, clickCount: 1, mods: 0 },
    ] });
    await until('the button to be clicked', () => /"b":true/.test(title));

    const malformed = await (await panelCall('/api/input', { session: '../x', messages: [] })).json();
    assert.deepEqual(malformed, { ok: false, error: '会话无效' });
  });

  await step('the language follows the panel: when the panel reports English, error messages for people switch to English; unknown languages are ignored', async () => {
    const page = await (await fetch(`http://127.0.0.1:${PORT}/?token=smoke-token`)).text();
    assert.match(page, /<html data-forced-lang="" lang="en">/, 'when no language is fixed, the page must not carry a fixed language');
    assert.match(page, /<script src="\/strings\.js"><\/script>\s*<script src="\/app\.js"><\/script>/);
    const strings = await fetch(`http://127.0.0.1:${PORT}/strings.js?token=smoke-token`);
    assert.equal(strings.status, 200);
    assert.match(await strings.text(), /workbenchStrings/);

    await panelCall('/api/link', { lang: 'en' });
    assert.equal((await agent('op=status')).lang, 'en');
    assert.deepEqual(await agent('op=board'), { ok: false, error: 'Unknown operation' });
    // A file: address is stopped at the check, so nothing is really opened.
    const refused = await (await panelCall('/api/open-external', { url: 'file:///C:/x' })).json();
    assert.deepEqual(refused, { ok: false, error: 'Only http and https addresses can be opened' });
    assert.deepEqual(await (await panelCall('/api/input', { session: '../x', messages: [] })).json(), { ok: false, error: 'Invalid session' });

    await panelCall('/api/link', { lang: 'fr' });
    assert.equal((await agent('op=status')).lang, 'en');
    await panelCall('/api/link', { lang: 'zh' });
    assert.equal((await agent('op=status')).lang, 'zh');
    assert.deepEqual(await agent('op=board'), { ok: false, error: '没有这个操作' });
  });

  await step('the agent command wb.mjs: once in Chinese, once in English', async () => {
    const zh = await runTool(['status'], { WORKBENCH_LANG: 'zh' });
    assert.equal(zh.code, 0, zh.out);
    assert.match(zh.out, /浏览器开着（.+），面板/);
    const en = await runTool(['status'], { WORKBENCH_LANG: 'en' });
    assert.equal(en.code, 0, en.out);
    assert.match(en.out, /The browser is running \(.+\); the panel is/);
    const usage = await runTool([], { WORKBENCH_LANG: 'en' });
    assert.equal(usage.code, 1);
    assert.match(usage.out, /^Usage: /);
    const gone = await runTool(['status'], { WORKBENCH_LANG: 'en', WORKBENCH_BROWSER_DATA: join(dataDir, 'nowhere') });
    assert.equal(gone.code, 1);
    assert.match(gone.out, /is not running/);
  });
} finally {
  const tabsFile = join(dataDir, 'tabs.json');
  await step('tabs are saved and can be restored next time', async () => {
    await waitFor('tabs.json', () => existsSync(tabsFile), 4000);
    assert.ok(JSON.parse(readFileSync(tabsFile, 'utf8')).urls[0].startsWith(deskUrl));
  });

  // Kill the backend hard (that is what Antigravity does when a plugin is turned off); the browser must exit
  // with it and leave no orphan.
  const browserGone = async () => {
    const list = spawn('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${dataDir.replace(/'/g, "''")}*' }).Count`], { windowsHide: true });
    let out = '';
    list.stdout.on('data', (chunk) => { out += chunk; });
    await new Promise((resolve) => list.on('exit', resolve));
    return Number(out.trim());
  };
  await step('after the backend is killed hard, the browser exits too', async () => {
    if (process.platform !== 'win32') return;
    assert.ok(await browserGone() > 0, 'there should be browser processes before the kill');
    sidecar.kill('SIGKILL');
    // On a busy machine Chrome takes several seconds to wind down, so wait until it has exited instead of
    // checking after exactly 3 seconds.
    const deadline = Date.now() + 30000;
    let left = await browserGone();
    while (left > 0 && Date.now() < deadline) {
      await sleep(1000);
      left = await browserGone();
    }
    assert.equal(left, 0, `${left} browser processes are still left after 30 seconds`);
  });
  sidecar.kill('SIGKILL');
  fakeDesk.close();
  await sleep(500);
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // the browser has just exited and a few files are still held; leave the temp folder for the system to clean up
  }
  console.log(results.join('\n'));
  if (failed) console.log('\n---- backend log ----\n' + sidecarLog.slice(-3000));
  console.log(failed ? '\nSome steps failed' : '\nAll passed');
  process.exit(failed ? 1 : 0);
}
