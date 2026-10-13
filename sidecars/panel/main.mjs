import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { BrowserHost } from './lib/browser.mjs';
import { History } from './lib/history.mjs';
import { acceptWebSocket, rejectUpgrade } from './lib/ws.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const EXTENSIONS_DIR = process.env.WORKBENCH_EXTENSIONS || join(HERE, 'extensions');
const IDLE_SHUTDOWN_MS = Number(process.env.WORKBENCH_IDLE_MINUTES || 30) * 60 * 1000;
const MAX_FRAME_BACKLOG = 4 * 1024 * 1024;

mkdirSync(DATA_DIR, { recursive: true });
const log = (text) => console.log(`[${new Date().toISOString()}] ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 新标签页是空白页，面板在上面画「常去」和「最近」。
const browser = new BrowserHost({ dataDir: DATA_DIR, homeUrl: 'about:blank', log });
const history = new History(join(DATA_DIR, 'history.json'));

const clients = new Set();
const agentKey = randomBytes(24).toString('hex');
let lastAgentPing = 0;

const broadcast = (message) => {
  const text = JSON.stringify(message);
  for (const client of clients) client.sendText(text);
};
const stateMessage = () => ({ t: 'state', ...browser.snapshot() });

browser.on('state', () => broadcast(stateMessage()));
browser.on('frame', (frame) => {
  // 对面来不及收就丢这一帧：每帧都是整张图，丢了下一帧补上，不会花屏。
  for (const client of clients) if (client.backlog < MAX_FRAME_BACKLOG) client.sendBinary(frame);
});
browser.on('select', (menu) => broadcast({ t: 'select', ...menu }));
browser.on('cursor', (cursor) => broadcast({ t: 'cursor', cursor }));
browser.on('closed', () => broadcast(stateMessage()));

// ---------- 去过的页 ----------

const PAGE_ICON = `(() => {
  const links = [...document.querySelectorAll('link[rel~="icon"]')];
  return links.length ? links[links.length - 1].href : '';
})()`;
// 页面一停下来就记一笔；标题常常比加载完成晚一点才定下来，所以过一会儿再补一次标题，顺便取图标。
const pendingTitles = new Map();
browser.on('settled', (tab) => {
  if (tab.unreachable) return;
  const url = tab.url;
  if (!history.record({ url, title: tab.title })) return;
  clearTimeout(pendingTitles.get(tab.id));
  pendingTitles.set(tab.id, setTimeout(async () => {
    pendingTitles.delete(tab.id);
    const current = browser.tabs.get(tab.id);
    if (!current || current.url !== url) return;
    const origin = history.record({ url, title: current.title });
    if (!history.needsIcon(origin)) return;
    const href = await browser.evaluate(PAGE_ICON, current.id).catch(() => '');
    await history.fetchIcon(origin, href);
  }, 800));
});

function openExternal(url) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只能打开 http 或 https 地址');
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [parsed.href]]
    : process.platform === 'darwin' ? ['open', [parsed.href]] : ['xdg-open', [parsed.href]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// ---------- HTTP ----------

const app = new SidecarApp();
const file = (path, contentType, edit = (text) => text) => () => new Response(edit(readFileSync(path, 'utf8')), {
  contentType,
  headers: { 'Cache-Control': 'no-store' },
});
const asset = (name, contentType, edit) => file(join(WEB, name), contentType, edit);
// 附加功能要加载的脚本和样式，在送出页面时填进去。
app.page('/', asset('index.html', 'text/html; charset=utf-8', (html) => html
  .replace('</head>', () => panelTags.head + '</head>')
  .replace('</body>', () => panelTags.body + '</body>')));
app.page('/app.js', asset('app.js', 'application/javascript; charset=utf-8'));
app.api('/styles.css', asset('styles.css', 'text/css; charset=utf-8'), 'GET');

// 面板用的接口都是 POST，SDK 会验面板令牌；失败统一回 { ok: false, error }，不让面板猜。
const guarded = (handler) => async (data) => {
  try {
    return await handler(data || {});
  } catch (error) {
    return { ok: false, error: error.message };
  }
};
app.api('/api/start', guarded(() => ({ ok: true, ...history.summary(), timeZone: displayTimeZone })));
app.api('/api/history-clear', guarded(() => {
  history.clear();
  return { ok: true };
}));
app.api('/api/open-external', guarded((data) => {
  openExternal(String(data.url || ''));
  return { ok: true };
}));

// agent 用的接口：凭 endpoint.json 里的钥匙（本机当前用户才读得到）。
// 主体能做的只有：叫醒浏览器、看状态、打开网址。页面上的操作走浏览器工具（MCP）。
const keyOk = (given) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(agentKey);
  return a.length === b.length && timingSafeEqual(a, b);
};
app.api('/api/agent', guarded(async (data) => {
  if (!keyOk(data.key)) return { ok: false, error: '钥匙不对' };
  lastAgentPing = Date.now();
  switch (data.op) {
    case 'ensure':
      await browser.ensure();
      return { ok: true, debugPort: browser.debugPort, profileDir: browser.profileDir };
    case 'status':
      // panels 是连着的面板总数，其中 polling 个走的是普通请求那条后备路。
      return { ok: true, ...browser.snapshot(), debugPort: browser.debugPort, panels: clients.size, polling: pollClients.size };
    case 'open':
      await browser.ensure();
      return { ok: true, tab: await browser.navigate(String(data.url || '')) };
    case 'quit':
      // 新后台启动时用它请旧后台让位。先回话再退。
      setTimeout(() => quit('新的后台起来了，这个让位退出'), 50);
      return { ok: true };
    default:
      if (Object.hasOwn(agentOps, data.op)) return agentOps[data.op](data);
      return { ok: false, error: '没有这个操作' };
  }
}), 'GET');

// ---------- 附加功能 ----------
//
// extensions/<名字>/index.mjs 有就加载，没有这个目录就是纯浏览器。每个附加功能导出 setup(context)，
// 可以自己用 context.app 加接口，也可以返回：
//   agentOps     给 /api/agent 加操作（{ 名字: async (data) => 结果 }）
//   panelScript  面板里要加载的脚本（文件路径），用 window.workbenchBrowser 加按钮和侧栏
//   panelStyle   面板里要加载的样式（文件路径）
//   timeZone     面板上的日期按哪个时区显示（不给就按系统的）
const agentOps = {};
const panelTags = { head: '', body: '' };
let displayTimeZone = '';
for (const name of existsSync(EXTENSIONS_DIR) ? readdirSync(EXTENSIONS_DIR).sort() : []) {
  const entry = join(EXTENSIONS_DIR, name, 'index.mjs');
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(entry)) continue;
  try {
    const { setup } = await import(pathToFileURL(entry).href);
    const made = (await setup({ app, guarded, browser, broadcast, log, sleep, dataDir: DATA_DIR })) || {};
    Object.assign(agentOps, made.agentOps);
    if (made.timeZone) displayTimeZone = made.timeZone;
    if (made.panelScript) {
      app.page(`/ext-${name}.js`, file(made.panelScript, 'application/javascript; charset=utf-8'));
      panelTags.body += `<script src="/ext-${name}.js"></script>
`;
    }
    if (made.panelStyle) {
      app.api(`/ext-${name}.css`, file(made.panelStyle, 'text/css; charset=utf-8'), 'GET');
      panelTags.head += `<link rel="stylesheet" href="/ext-${name}.css">
`;
    }
    log(`已加载附加功能 ${name}`);
  } catch (error) {
    log(`附加功能 ${name} 没加载上：${error.message}`);
  }
}

// agent 的浏览器工具入口要在插件根目录的 mcp_config.json 里登记，而且得写绝对路径。
// 用 agy plugin install 装的没有人替它写，所以后台每次启动自己核对一遍：没有或者路径不对就写上。
// 刚写上的这一次，Antigravity 可能要重启才读得到。
const PLUGIN_ROOT = join(HERE, '..', '..');
const mcpEntry = join(PLUGIN_ROOT, 'mcp', 'launch.mjs');
if (!process.env.WORKBENCH_NO_MCP_CONFIG && existsSync(join(PLUGIN_ROOT, 'plugin.json')) && existsSync(mcpEntry)) {
  const configFile = join(PLUGIN_ROOT, 'mcp_config.json');
  const wanted = JSON.stringify({ mcpServers: { 'workbench-browser': { command: 'node', args: [mcpEntry] } } }, null, 2);
  let current = '';
  try {
    current = readFileSync(configFile, 'utf8');
  } catch {
    // 还没有
  }
  if (current !== wanted) {
    try {
      writeFileSync(configFile, wanted, 'utf8');
      log('已登记 agent 的浏览器工具入口（mcp_config.json）；工具没出现的话重启一次 Antigravity');
    } catch (error) {
      log('没能写 mcp_config.json：' + error.message);
    }
  }
}

const server = await app.run();
const port = server?.address?.()?.port || Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const startedAt = new Date().toISOString();

// ---------- 同一时间只留一个后台 ----------
//
// Antigravity 重启时不一定把上一个后台关掉（实测：语言服务没了，它起的 cmd 壳和后台还活着）。
// 旧后台占着浏览器的资料目录，新后台起的浏览器发现目录被占会立刻退出，面板上就是「浏览器没能启动」。
// 两头都防：新后台启动时让登记在册的旧后台退出；每个后台自己也盯着语言服务，它不在了就退。

const instancesFile = join(DATA_DIR, 'instances.json');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function retireOthers() {
  const known = [];
  for (const file of [instancesFile, join(DATA_DIR, 'endpoint.json')]) {
    try {
      known.push(...[].concat(JSON.parse(readFileSync(file, 'utf8'))));
    } catch {
      // 没有这份记录
    }
  }
  const handled = new Set([process.pid]);
  for (const other of known) {
    if (!other || !other.pid || !other.port || handled.has(other.pid)) continue;
    handled.add(other.pid);
    if (!alive(other.pid)) continue;
    const ask = async (op) => {
      const response = await fetch(`http://127.0.0.1:${other.port}/api/agent?key=${other.key}&op=${op}`, { signal: AbortSignal.timeout(2500) });
      return response.json();
    };
    // 认钥匙的才是我们自己的旧后台。进程号可能早被别的程序占了，不认的一律不碰。
    const ours = await ask('status').then((status) => status.ok === true, () => false);
    if (!ours) continue;
    // 对方刚起来不到 20 秒：多半是两个 Antigravity 各管一个后台在互相顶，这边不抢，免得来回杀个没完。
    if (Date.now() - Date.parse(other.startedAt || 0) < Number(process.env.WORKBENCH_YIELD_GUARD_MS || 20000)) {
      log(`另一个后台（进程 ${other.pid}）刚启动，不去动它`);
      continue;
    }
    log(`上一个后台（进程 ${other.pid}）还开着，让它退出`);
    await ask('quit').catch(() => {});
    for (let i = 0; i < 25 && alive(other.pid); i++) await sleep(200);
    if (alive(other.pid)) {
      try {
        process.kill(other.pid);
      } catch {
        // 刚好自己退了
      }
    }
  }
  writeFileSync(instancesFile, JSON.stringify([{ pid: process.pid, port, key: agentKey, startedAt }]), 'utf8');
}
await retireOthers();

writeFileSync(join(DATA_DIR, 'endpoint.json'), JSON.stringify({
  port,
  key: agentKey,
  pid: process.pid,
  profileDir: browser.profileDir,
  startedAt,
}, null, 2), 'utf8');

function quit(reason) {
  log(reason);
  browser.shutdown().catch(() => {}).finally(() => process.exit(0));
}

// 语言服务的地址是 Antigravity 启动后台时给的（host:port）。连上过之后又连续三次连不上，就当 Antigravity 已经不在了。
// 「连上过」这个前提很要紧：万一哪个版本给的地址这边连不了，不能因此把好好的后台自己退掉。
const languageServer = /^(.+):(\d+)$/.exec(String(process.env.ANTIGRAVITY_LS_ADDRESS || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''));
if (languageServer) {
  let reachedOnce = false;
  let misses = 0;
  const watch = setInterval(() => {
    const socket = net.connect({ host: languageServer[1].replace(/^\[|\]$/g, ''), port: Number(languageServer[2]) });
    let settled = false;
    const settle = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (reachable) {
        reachedOnce = true;
        misses = 0;
        return;
      }
      misses += 1;
      if (reachedOnce && misses === 3) {
        quit('Antigravity 的语言服务不在了，这个后台没人管了，退出');
      } else if (!reachedOnce && misses === 5) {
        log(`语言服务地址 ${languageServer[0]} 一次都没连上，不靠它判断 Antigravity 在不在`);
        clearInterval(watch);
      }
    };
    socket.setTimeout(3000, () => settle(false));
    socket.on('connect', () => settle(true));
    socket.on('error', () => settle(false));
  }, Number(process.env.WORKBENCH_LS_CHECK_MS || 20000));
  watch.unref();
}

// ---------- 面板连接 ----------
//
// Antigravity 不让面板直连这个后台：面板页面挂在 plugin://<一串字> 下面，它发的每个普通请求
// 由 Antigravity 主进程转给一层带鉴权的网关，网关再转到这里。普通请求这样走得通，长连接走不通。
// 所以面板先用普通请求来问一声（/api/link），拿到这个后台的真实端口和一把钥匙，
// 再直接连 ws://127.0.0.1:<端口>。直连不上的时候（比如从别的设备远程看 Antigravity），
// 退回到全用普通请求：/api/poll 取画面和消息，/api/input 送鼠标键盘。

const panelKey = randomBytes(24).toString('hex');

function attachClient(client) {
  clients.add(client);
  client.sendJson(stateMessage());
}

function detachClient(client) {
  clients.delete(client);
  if (!clients.size) browser.setCasting(false).catch(() => {});
}

// 用普通请求顶替长连接时的「面板」：对外和长连接的那一头长得一样（sendText / sendBinary / backlog / open）。
class PollClient {
  open = true;
  backlog = 0;
  lastSeen = Date.now();
  #messages = [];
  #frame = null;
  #frameSeq = 0;
  #waiters = new Set();

  get waiting() {
    return this.#waiters.size > 0;
  }

  sendText(text) {
    this.#messages.push(text);
    if (this.#messages.length > 400) this.#messages.splice(0, this.#messages.length - 400);
    this.#wake();
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  // 只留最新一帧：面板来取的时候拿到的总是当前画面。
  sendBinary(frame) {
    this.#frame = frame;
    this.#frameSeq += 1;
    this.#wake();
  }

  // 有新消息或新画面就立刻回；都没有就挂着等，最多 20 秒。
  // 回的是一段二进制：4 字节头长 + JSON 头（消息、帧序号）+ 画面（有新的才带）。
  next(haveSeq) {
    this.lastSeen = Date.now();
    if (this.#messages.length || this.#frameSeq > haveSeq) return Promise.resolve(this.#take(haveSeq));
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        this.lastSeen = Date.now();
        resolve(this.#take(haveSeq));
      };
      const timer = setTimeout(waiter, 20000);
      this.#waiters.add(waiter);
    });
  }

  #take(haveSeq) {
    const withFrame = this.#frame && this.#frameSeq > haveSeq;
    const head = Buffer.from(`{"messages":[${this.#messages.splice(0).join(',')}],"frameSeq":${withFrame ? this.#frameSeq : haveSeq}}`, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(head.length);
    return Buffer.concat(withFrame ? [size, head, this.#frame] : [size, head]);
  }

  #wake() {
    for (const waiter of [...this.#waiters]) waiter();
  }
}

const pollClients = new Map();
function pollClient(session, create) {
  if (!/^[0-9a-f]{24}$/.test(String(session || ''))) return null;
  let client = pollClients.get(session);
  if (!client && create) {
    client = new PollClient();
    pollClients.set(session, client);
    attachClient(client);
  }
  return client || null;
}
// 面板关掉后不会再来取；半分钟没动静就当它走了。
setInterval(() => {
  for (const [session, client] of pollClients) {
    if (client.waiting || Date.now() - client.lastSeen < 30000) continue;
    client.open = false;
    pollClients.delete(session);
    detachClient(client);
  }
}, 5000).unref();

app.api('/api/link', guarded(() => ({ ok: true, port, key: panelKey, session: randomBytes(12).toString('hex') })));
app.api('/api/poll', guarded(async (data) => {
  const client = pollClient(data.session, true);
  if (!client) return { ok: false, error: '会话无效' };
  return new Response(await client.next(Number(data.frameSeq) || 0), {
    contentType: 'application/octet-stream',
    headers: { 'Cache-Control': 'no-store' },
  });
}));
app.api('/api/input', guarded((data) => {
  // 面板一连上就先报自己的大小，这一条常常比第一次 /api/poll 先到，所以这里也要能开出会话。
  const client = pollClient(data.session, true);
  if (!client) return { ok: false, error: '会话无效' };
  client.lastSeen = Date.now();
  for (const message of Array.isArray(data.messages) ? data.messages : []) handleClientMessage(client, message);
  return { ok: true };
}));
// 面板那头出了什么事（连接走的哪条路、被什么拦了），记到这边的日志里，排查时不用找用户要截图。
app.api('/api/client-log', guarded((data) => {
  log('[面板] ' + String(data.text || '').slice(0, 400));
  return { ok: true };
}));

function onClientMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  handleClientMessage(client, message);
}

function handleClientMessage(client, message) {
  if (!message || typeof message !== 'object') return;
  const run = (work) => Promise.resolve().then(work).catch((error) => client.sendJson({ t: 'error', message: error.message }));
  switch (message.t) {
    // 面板连上后第一件事是报自己多大、屏幕缩放比多少；浏览器等拿到这个再起，缩放比才对。
    case 'resize': run(async () => {
      await browser.setViewport(message);
      await browser.matchDisplay(message.dpr);
      await startFor(client);
    }); break;
    case 'mouse': browser.mouse(message); break;
    case 'key': browser.key(message); break;
    case 'text': browser.insertText(message.text); break;
    case 'paste': run(() => browser.paste(String(message.text || ''))); break;
    case 'copy': run(async () => client.sendJson({ t: 'clipboard', text: await browser.readClipboard() })); break;
    case 'nav': run(() => browser.navigate(message.url)); break;
    case 'back': run(() => browser.back()); break;
    case 'forward': run(() => browser.forward()); break;
    case 'reload': run(() => browser.reload()); break;
    case 'stop': run(() => browser.stop()); break;
    case 'tab.new': run(() => browser.newTab(message.url)); break;
    case 'tab.select': run(() => browser.selectTab(message.id)); break;
    case 'tab.close': run(() => browser.closeTab(message.id)); break;
    case 'dialog': run(() => browser.answerDialog(message.accept, message.text)); break;
    case 'files': run(() => browser.chooseFiles(message.paths)); break;
    case 'select.pick': run(() => browser.pickSelect(message.index)); break;
    case 'start': run(() => startFor(client)); break;
    default: break;
  }
}

async function startFor(client) {
  try {
    await browser.ensure();
    if (clients.size) await browser.setCasting(true);
  } catch (error) {
    if (client.open) client.sendJson(stateMessage());
    log('浏览器启动失败：' + error.message);
  }
}

if (server && typeof server.on === 'function') {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://local');
    const given = Buffer.from(String(url.searchParams.get('key') || ''));
    const wanted = Buffer.from(panelKey);
    if (url.pathname !== '/ws' || given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      rejectUpgrade(socket);
      return;
    }
    const client = acceptWebSocket(req, socket, head);
    if (!client) return;
    client.on('text', (raw) => onClientMessage(client, raw));
    client.on('close', () => detachClient(client));
    attachClient(client);
  });
} else {
  log('这一版 SDK 没有交出服务器对象，面板连不上后台；需要更新插件');
}

// 没人看、agent 也半小时没动：把浏览器关掉省内存。登录状态在资料目录里，下次打开还在。
setInterval(() => {
  if (!browser.running || clients.size) return;
  const idle = Date.now() - Math.max(browser.lastActivity, lastAgentPing);
  if (idle > IDLE_SHUTDOWN_MS) {
    log('空闲，关闭浏览器');
    browser.shutdown().catch(() => {});
  }
}, 60 * 1000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    browser.shutdown().catch(() => {}).finally(() => process.exit(0));
  });
}
