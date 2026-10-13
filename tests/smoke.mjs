// 整条链路的冒烟测试：真的起一个面板后台、真的起浏览器，扮成面板连上去，
// 点、打字、输入法上屏、粘贴、复制、下拉框、确认框、新标签页、前进后退、去过的页，逐项看结果。
// 用的是本机临时起的测试页，不碰任何真网站。
// 用法：node tests/smoke.mjs
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
<button id="b">点我</button>
<textarea id="ta"></textarea>
<div id="ce" contenteditable="true"></div>
<select id="sel"><option>甲</option><option>乙</option><option>丙</option></select>
<button id="c">确认框</button>
<a id="link" href="/second" target="_blank">开新页</a>
<input id="f" type="file">
<script>
  const out = { b: false, c: null, f: '' };
  f.onchange = () => { out.f = f.files.length ? f.files[0].name : ''; sync(); };
  const sync = () => {
    document.title = JSON.stringify({ ...out, ta: ta.value, ce: ce.innerText.trim(), sel: sel.value, key: window.lastKey || '', size: innerWidth + 'x' + innerHeight });
  };
  addEventListener('resize', sync);
  b.onclick = () => { out.b = true; sync(); };
  c.onclick = () => { out.c = confirm('确定吗'); sync(); };
  addEventListener('input', sync, true);
  addEventListener('change', sync, true);
  addEventListener('keydown', (event) => { window.lastKey = event.key; sync(); }, true);
  sync();
</script>`;

// 1x1 的透明 PNG，当测试站的图标。
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
  if (url.pathname === '/second') return html('<!doctype html><meta charset="utf-8"><title>第二页</title><p>第二页</p>');
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
    // 语言不指定死：下面要看它跟着面板报的走。
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
    results.push(`  通过  ${name}`);
  } catch (error) {
    failed = true;
    results.push(`  失败  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`);
  }
}

// ---------- 扮成面板 ----------
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
    if (Date.now() > deadline) throw new Error(`等不到：${what}\n当前页面状态：${activeTab()?.title}\n标签页：${JSON.stringify(state.tabs.map((tab) => tab.url))}`);
    await sleep(40);
  }
}
async function waitForAsync(what, check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
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
// 面板发的普通请求：带面板令牌的 POST。
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

// 跑一下 agent 用的小命令，拿它说的话。
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
  // 不用起后台就能查的：面板上的字。
  await step('面板上的字：页面和脚本里用到的每个键，中文英文都有；页面里不留写死的字', async () => {
    const web = join(root, 'sidecars', 'panel', 'web');
    const holder = {};
    runInNewContext(readFileSync(join(web, 'strings.js'), 'utf8'), { window: holder });
    const strings = holder.workbenchStrings;
    for (const [key, entry] of Object.entries(strings)) {
      assert.ok(entry.zh && entry.en, `「${key}」缺一种语言`);
      assert.ok(!/[一-鿿]/.test(entry.en), `「${key}」的英文里混着中文：${entry.en}`);
    }
    const page = readFileSync(join(web, 'index.html'), 'utf8');
    const script = readFileSync(join(web, 'app.js'), 'utf8');
    const used = new Set(['appName']);
    for (const match of page.matchAll(/data-t(?:-title|-label|-placeholder)?="([^"]+)"/g)) used.add(match[1]);
    // app.js 里的 t('键')，以及 t(条件 ? '键' : '键') 这种写法里的每个键。
    for (const call of script.matchAll(/\bt\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      for (const match of call[1].matchAll(/'([A-Za-z]+)'/g)) used.add(match[1]);
    }
    assert.ok(used.size > 25, `只找到 ${used.size} 个键，多半是找法坏了`);
    for (const key of used) assert.ok(strings[key], `用到了「${key}」，strings.js 里没有`);
    for (const key of Object.keys(strings)) assert.ok(used.has(key), `strings.js 里的「${key}」没有地方用`);
    const visible = page.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/[一-鿿]/.test(visible), 'index.html 里还有写死的中文');
  });

  await step('后台起来，写出 endpoint.json', async () => {
    await waitFor('endpoint.json', () => existsSync(join(dataDir, 'endpoint.json')), 10000);
    const endpoint = JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8'));
    assert.equal(endpoint.port, PORT);
    assert.equal(endpoint.key.length, 48);
  });

  await step('钥匙不对的连接被拒；不带面板令牌也问不到钥匙', async () => {
    const outcome = await new Promise((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=wrong`);
      bad.onopen = () => resolve('opened');
      bad.onerror = () => resolve('refused');
    });
    assert.equal(outcome, 'refused');
    const anonymous = await fetch(`http://127.0.0.1:${PORT}/api/link`, { method: 'POST', body: '{}' });
    assert.equal(anonymous.status, 401);
  });

  await step('agent 先把浏览器叫醒（这时没有面板，不知道屏幕缩放比）', async () => {
    const woke = await agent('op=ensure');
    assert.equal(woke.ok, true);
    assert.ok(woke.debugPort > 0);
  });

  await step('面板连上，浏览器启动，收到画面（先有损、静下来后补无损）', async () => {
    // 和真面板一样：先用普通请求问到端口和钥匙（顺便报上界面语言），再直连。
    // 报中文，后面核对报错原文的几步在哪种语言的系统上跑都一样。
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
      socket.onerror = () => reject(new Error('面板连不上后台'));
    });
    send({ t: 'resize', width: 900, height: 600, dpr: 1.5 });
    // 第一次用：只有一个空白页，面板会在上面画新标签页。
    await waitFor('浏览器运行并有标签页', () => state.running && state.tabs.length === 1 && activeTab().url === 'about:blank', 30000);
    await waitFor('有损帧', () => frames.jpeg > 0, 10000);
    await waitFor('无损帧', () => frames.png > 0, 5000);
  });

  await step('新标签页：还没去过任何页时，常去和最近都是空的', async () => {
    const start = await (await panelCall('/api/start')).json();
    assert.deepEqual(start, { ok: true, sites: [], recent: [], timeZone: '' });
  });

  await step('从空白页打开测试页', async () => {
    send({ t: 'nav', url: deskUrl + '/' });
    await waitFor('测试页打开', () => activeTab().url === deskUrl + '/' && !activeTab().loading && pageState().size);
  });

  await step('浏览器按面板的缩放比重开过：画面是 1.5 倍的像素，不是放大糊出来的', async () => {
    assert.equal(frames.lastPngWidth, 1350, `面板 900 宽、缩放比 1.5，帧应该是 1350 像素宽，实际 ${frames.lastPngWidth}`);
    assert.match(sidecarLog, /按面板的缩放比 1\.5 重开浏览器/);
  });

  await step('画面静止时不会自己不停重画', async () => {
    await sleep(600);
    const before = frames.jpeg + frames.png;
    await sleep(2500);
    assert.ok(frames.jpeg + frames.png - before <= 1, `静止 2.5 秒里又来了 ${frames.jpeg + frames.png - before} 帧`);
  });

  await step('点击', async () => {
    await click(70, 35);
    await waitFor('按钮被点到', () => pageState().b === true);
  });

  await step('键盘打字、退格、回车', async () => {
    await click(100, 100);
    press('a', 'KeyA', 65, 0, 'a');
    press('B', 'KeyB', 66, 8, 'B');
    press('Backspace', 'Backspace', 8);
    press('Enter', 'Enter', 13, 0, '\r');
    press('c', 'KeyC', 67, 0, 'c');
    await waitFor('文本框内容', () => pageState().ta === 'a\nc');
  });

  await step('输入法上屏的中文', async () => {
    send({ t: 'text', text: '你好，世界' });
    await waitFor('中文进文本框', () => pageState().ta === 'a\nc你好，世界');
  });

  await step('全选、复制回面板', async () => {
    press('a', 'KeyA', 65, 2);
    press('c', 'KeyC', 67, 2);
    send({ t: 'copy' });
    const message = await waitFor('剪贴板消息', () => inbox.find((item) => item.t === 'clipboard'));
    assert.equal(message.text.replace(/\r\n/g, '\n'), 'a\nc你好，世界');
  });

  await step('光标在输入框里闪的时候，画面流量有多大（只量不判）', async () => {
    const before = { ...frames };
    await sleep(3000);
    results.push(`        光标闪烁 3 秒：有损 ${frames.jpeg - before.jpeg} 帧，无损 ${frames.png - before.png} 帧`);
  });

  await step('粘贴多段文字进富文本框，按段落落下', async () => {
    await click(100, 200);
    send({ t: 'paste', text: '第一段。\n第二段。' });
    await waitFor('富文本框内容', () => pageState().ce === '第一段。\n第二段。');
  });

  // 面板被拖宽拖窄是常事。改过大小之后，后面几步照旧按页面坐标去点，落点必须还是准的
  //（早先让 Chrome 模拟缩放比时，这里会偏成原来的三分之二）。
  await step('面板改了大小，页面跟着重排', async () => {
    // 页面把自己的宽高写进标题里的 size 字段，直接看它跟没跟上。
    // 特意挑画面刚静下来、正在补清晰图的时候改：早先补图用的截图命令会把新尺寸冲掉。
    for (const [width, height] of [[820, 560], [700, 520], [860, 580], [820, 560]]) {
      send({ t: 'text', text: '字' }); // 往富文本框里敲一个字，让画面动一下
      await sleep(380 + Math.floor(Math.random() * 80));
      send({ t: 'resize', width, height, dpr: 1.5 });
      await waitFor(`页面变成 ${width}x${height}`, () => pageState().size === `${width}x${height}`, 5000);
    }
  });

  await step('下拉框：选项报给面板，选了之后页面的值跟着变', async () => {
    send({ t: 'mouse', type: 'down', x: 80, y: 284, button: 0, buttons: 1, clickCount: 1, mods: 0 });
    send({ t: 'mouse', type: 'up', x: 80, y: 284, button: 0, buttons: 0, clickCount: 1, mods: 0 });
    const menu = await waitFor('下拉选项', () => inbox.find((item) => item.t === 'select'));
    assert.deepEqual(menu.options.map((option) => option.label), ['甲', '乙', '丙']);
    assert.equal(menu.selected, 0);
    assert.ok(Math.abs(menu.rect.x - 20) < 1 && Math.abs(menu.rect.y - 270) < 1);
    send({ t: 'select.pick', index: 2 });
    await waitFor('下拉框的值', () => pageState().sel === '丙');
  });

  await step('确认框：面板上答，页面拿到结果', async () => {
    await click(70, 335);
    const tab = await waitFor('确认框出现', () => activeTab().dialog && activeTab());
    assert.equal(tab.dialog.type, 'confirm');
    assert.equal(tab.dialog.message, '确定吗');
    send({ t: 'dialog', accept: true });
    await waitFor('确认框的结果', () => pageState().c === true);
  });

  await step('选文件：页面要文件时面板收到提示，填路径后页面拿到文件', async () => {
    await click(60, 435);
    await waitFor('选文件提示', () => activeTab().fileChooser);
    send({ t: 'files', paths: [join(dataDir, 'endpoint.json')] });
    await waitFor('页面拿到文件', () => pageState().f === 'endpoint.json');
    assert.equal(activeTab().fileChooser, null);
  });

  await step('鼠标移到链接上，指针样子报给面板', async () => {
    inbox.length = 0;
    send({ t: 'mouse', type: 'move', x: 45, y: 380, buttons: 0, mods: 0 });
    await sleep(60);
    send({ t: 'mouse', type: 'move', x: 46, y: 381, buttons: 0, mods: 0 });
    const message = await waitFor('指针消息', () => inbox.find((item) => item.t === 'cursor'));
    assert.equal(message.cursor, 'pointer');
  });

  await step('点 target=_blank 的链接：开成新标签页并切过去', async () => {
    await click(50, 380);
    await waitFor('两个标签页', () => state.tabs.length === 2 && activeTab().url === deskUrl + '/second' && activeTab().title === '第二页');
  });

  await step('地址栏导航、后退、前进', async () => {
    send({ t: 'nav', url: deskUrl + '/?again' });
    await waitFor('到新地址', () => activeTab().url === deskUrl + '/?again' && activeTab().canBack && !activeTab().loading);
    send({ t: 'back' });
    await waitFor('退回第二页', () => activeTab().url === deskUrl + '/second' && activeTab().canForward);
    send({ t: 'forward' });
    await waitFor('再前进', () => activeTab().url === deskUrl + '/?again');
  });

  await step('关标签页', async () => {
    const closing = state.active;
    send({ t: 'tab.close', id: closing });
    await waitFor('剩一个标签页', () => state.tabs.length === 1 && state.active !== closing);
  });

  await step('agent 接口：钥匙不对就拒绝', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/agent?key=nope&op=status`);
    assert.deepEqual(await response.json(), { ok: false, error: '钥匙不对' });
  });

  await step('agent 接口：状态里有调试端口，agent 的浏览器工具能接上同一个浏览器', async () => {
    const status = await agent('op=status');
    assert.equal(status.ok, true);
    assert.equal(status.panels, 1);
    assert.ok(status.debugPort > 0);
    const version = await (await fetch(`http://127.0.0.1:${status.debugPort}/json/version`)).json();
    assert.match(version.Browser, /Chrome|Edg/);
    const pages = await (await fetch(`http://127.0.0.1:${status.debugPort}/json/list`)).json();
    assert.ok(pages.some((page) => page.url.startsWith(deskUrl)), '调试端口上看得到面板里的页面');
  });

  await step('点 + 开的是空白的新标签页，不是哪个固定的站', async () => {
    send({ t: 'tab.new', url: 'about:blank' });
    await waitFor('空白的新标签页', () => state.tabs.length === 2 && activeTab().url === 'about:blank');
  });

  await step('新标签页：去过的页进了「常去」和「最近」，带着标题和图标', async () => {
    const start = await waitForAsync('图标取到', async () => {
      const data = await (await panelCall('/api/start')).json();
      return data.sites.length && data.sites[0].icon ? data : null;
    });
    assert.equal(start.sites.length, 1, '同一个站只占一格');
    assert.equal(start.sites[0].host, new URL(deskUrl).host);
    assert.match(start.sites[0].icon, /^data:image\/png;base64,/);
    const urls = start.recent.map((page) => page.url);
    assert.ok(urls.includes(deskUrl + '/second') && urls.includes(deskUrl + '/?again') && urls.includes(deskUrl + '/'), JSON.stringify(urls));
    assert.ok(!urls.includes('about:blank'), '空白页不进记录');
    assert.equal(start.recent.find((page) => page.url === deskUrl + '/second').title, '第二页');
    for (let i = 1; i < start.recent.length; i++) assert.ok(start.recent[i - 1].last >= start.recent[i].last, '最近的在前');
  });

  await step('从新标签页点一个去过的页：在这个标签页里打开', async () => {
    send({ t: 'nav', url: deskUrl + '/second' });
    await waitFor('第二页', () => activeTab().url === deskUrl + '/second' && activeTab().title === '第二页');
    send({ t: 'tab.close', id: state.active });
    await waitFor('回到一个标签页', () => state.tabs.length === 1 && activeTab().url.startsWith(deskUrl));
  });

  await step('清空记录', async () => {
    assert.deepEqual(await (await panelCall('/api/history-clear')).json(), { ok: true });
    const start = await (await panelCall('/api/start')).json();
    assert.deepEqual([start.sites, start.recent], [[], []]);
  });

  await step('没装附加功能时，章节那几个操作不存在', async () => {
    assert.deepEqual(await agent('op=board'), { ok: false, error: '没有这个操作' });
  });

  await step('回到测试页（后面的步骤要一张没点过的页）', async () => {
    await agent('op=open&url=' + encodeURIComponent(deskUrl + '/'));
    await waitFor('回到测试页', () => activeTab().url === deskUrl + '/' && !activeTab().loading);
  });

  await step('面板关掉后不再出画面', async () => {
    socket.close();
    await sleep(500);
    const status = await agent('op=status');
    assert.equal(status.panels, 0);
    assert.equal(status.running, true);
  });

  // 直连走不通时（Antigravity 只转普通请求，或者是从别的设备远程看）的后备路。
  await step('后备路：只用普通请求，也能拿到画面、点得动页面', async () => {
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
    // 真面板是先报大小、后来取画面的，顺序照着它来：先到的 /api/input 也得能开出会话。
    const sized = await (await panelCall('/api/input', { session: link.session, messages: [{ t: 'resize', width: 900, height: 600, dpr: 1.5 }] })).json();
    assert.deepEqual(sized, { ok: true });
    const first = await poll(0);
    assert.ok(first.head.messages.some((message) => message.t === 'state'), '第一次取应该带着当前状态');
    absorb(first);

    const until = async (what, done) => {
      const deadline = Date.now() + 15000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`等不到：${what}（标题 ${title}）`);
        absorb(await poll(seq));
      }
    };
    await until('画面', () => frame);
    assert.ok(frame[0] === 0xff || frame[0] === 0x89, '取到的应该是一张图');
    assert.equal((await agent('op=status')).panels, 1);

    // 这时页面是刚重新打开的测试页，按钮还没点过。
    assert.match(title, /"b":false/);
    await panelCall('/api/input', { session: link.session, messages: [
      { t: 'mouse', type: 'down', x: 70, y: 35, button: 0, buttons: 1, clickCount: 1, mods: 0 },
      { t: 'mouse', type: 'up', x: 70, y: 35, button: 0, buttons: 0, clickCount: 1, mods: 0 },
    ] });
    await until('按钮被点到', () => /"b":true/.test(title));

    const malformed = await (await panelCall('/api/input', { session: '../x', messages: [] })).json();
    assert.deepEqual(malformed, { ok: false, error: '会话无效' });
  });

  await step('语言跟着面板走：面板报英文，后台给人看的报错就换成英文；不认识的语言不理', async () => {
    const page = await (await fetch(`http://127.0.0.1:${PORT}/?token=smoke-token`)).text();
    assert.match(page, /<html data-forced-lang="" lang="en">/, '没指定语言时，页面上不该带着指定的语言');
    assert.match(page, /<script src="\/strings\.js"><\/script>\s*<script src="\/app\.js"><\/script>/);
    const strings = await fetch(`http://127.0.0.1:${PORT}/strings.js?token=smoke-token`);
    assert.equal(strings.status, 200);
    assert.match(await strings.text(), /workbenchStrings/);

    await panelCall('/api/link', { lang: 'en' });
    assert.equal((await agent('op=status')).lang, 'en');
    assert.deepEqual(await agent('op=board'), { ok: false, error: 'Unknown operation' });
    // file: 地址在检查这一步就被拦下，不会真的去开。
    const refused = await (await panelCall('/api/open-external', { url: 'file:///C:/x' })).json();
    assert.deepEqual(refused, { ok: false, error: 'Only http and https addresses can be opened' });
    assert.deepEqual(await (await panelCall('/api/input', { session: '../x', messages: [] })).json(), { ok: false, error: 'Invalid session' });

    await panelCall('/api/link', { lang: 'fr' });
    assert.equal((await agent('op=status')).lang, 'en');
    await panelCall('/api/link', { lang: 'zh' });
    assert.equal((await agent('op=status')).lang, 'zh');
    assert.deepEqual(await agent('op=board'), { ok: false, error: '没有这个操作' });
  });

  await step('agent 用的小命令 wb.mjs：中文、英文各说一遍', async () => {
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
  await step('标签页被记下来，下次能恢复', async () => {
    await waitFor('tabs.json', () => existsSync(tabsFile), 4000);
    assert.ok(JSON.parse(readFileSync(tabsFile, 'utf8')).urls[0].startsWith(deskUrl));
  });

  // 硬杀后台（Antigravity 关插件就是这么干的），浏览器必须跟着退，不留孤儿。
  const browserGone = async () => {
    const list = spawn('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${dataDir.replace(/'/g, "''")}*' }).Count`], { windowsHide: true });
    let out = '';
    list.stdout.on('data', (chunk) => { out += chunk; });
    await new Promise((resolve) => list.on('exit', resolve));
    return Number(out.trim());
  };
  await step('后台被硬杀后，浏览器跟着退出', async () => {
    if (process.platform !== 'win32') return;
    assert.ok(await browserGone() > 0, '杀之前应该有浏览器进程');
    sidecar.kill('SIGKILL');
    // 机器忙的时候 Chrome 收尾要好几秒，所以是等它退完，不是掐着 3 秒看。
    const deadline = Date.now() + 30000;
    let left = await browserGone();
    while (left > 0 && Date.now() < deadline) {
      await sleep(1000);
      left = await browserGone();
    }
    assert.equal(left, 0, `30 秒后还剩 ${left} 个浏览器进程`);
  });
  sidecar.kill('SIGKILL');
  fakeDesk.close();
  await sleep(500);
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // 浏览器刚退，个别文件还没放手；临时目录留给系统清
  }
  console.log(results.join('\n'));
  if (failed) console.log('\n---- 后台日志 ----\n' + sidecarLog.slice(-3000));
  console.log(failed ? '\n有失败项' : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
