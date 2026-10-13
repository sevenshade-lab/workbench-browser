import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { BrowserHost, httpOnly } from './lib/browser.mjs';
import { History } from './lib/history.mjs';
import { forceLanguage, forcedLanguage, language, reportLanguage, say } from './lib/lang.mjs';
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

// The new-tab page is a blank page; the panel draws "Most visited" and "Recent" on top of it.
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
  // If the other side cannot keep up, drop this frame: every frame is a full picture, so the next one
  // makes up for it and the picture never gets corrupted.
  for (const client of clients) if (client.backlog < MAX_FRAME_BACKLOG) client.sendBinary(frame);
});
browser.on('select', (menu) => broadcast({ t: 'select', ...menu }));
browser.on('cursor', (cursor) => broadcast({ t: 'cursor', cursor }));
browser.on('closed', () => broadcast(stateMessage()));

// ---------- Visited pages ----------

const PAGE_ICON = `(() => {
  const links = [...document.querySelectorAll('link[rel~="icon"]')];
  return links.length ? links[links.length - 1].href : '';
})()`;
// A page is recorded as soon as it settles. The title is often final only a little after loading ends,
// so record the title once more a moment later and fetch the icon at the same time.
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
  if (!/^https?:$/.test(parsed.protocol)) throw httpOnly();
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
// Two things are filled in when the page is served: the scripts and styles that extensions want loaded,
// and whether the language has been fixed (if not, the panel decides by itself; see lib/lang.mjs).
app.page('/', asset('index.html', 'text/html; charset=utf-8', (html) => html
  .replace('<html', () => `<html data-forced-lang="${forcedLanguage()}"`)
  .replace('</head>', () => panelTags.head + '</head>')
  .replace('</body>', () => panelTags.body + '</body>')));
app.page('/strings.js', asset('strings.js', 'application/javascript; charset=utf-8'));
app.page('/app.js', asset('app.js', 'application/javascript; charset=utf-8'));
app.api('/styles.css', asset('styles.css', 'text/css; charset=utf-8'), 'GET');

// The panel's endpoints are all POST and the SDK checks the panel token. Failures always come back as
// { ok: false, error }, so the panel never has to guess.
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

// The agent's endpoint: it requires the key in endpoint.json (readable only by the current user of this machine).
// All the main body can do here is wake the browser, report status and open an address.
// Actions on a page go through the browser tools (MCP).
const keyOk = (given) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(agentKey);
  return a.length === b.length && timingSafeEqual(a, b);
};
app.api('/api/agent', guarded(async (data) => {
  if (!keyOk(data.key)) return { ok: false, error: say('钥匙不对', 'Wrong key') };
  lastAgentPing = Date.now();
  switch (data.op) {
    case 'ensure':
      await browser.ensure();
      return { ok: true, debugPort: browser.debugPort, profileDir: browser.profileDir };
    case 'status':
      // panels is the total number of connected panels; polling is how many of them use the fallback path
      // over plain requests.
      return { ok: true, ...browser.snapshot(), debugPort: browser.debugPort, panels: clients.size, polling: pollClients.size, lang: language() };
    case 'open':
      await browser.ensure();
      return { ok: true, tab: await browser.navigate(String(data.url || '')) };
    case 'quit':
      // A starting backend uses this to ask the old one to step down. Reply first, then exit.
      setTimeout(() => quit('a newer backend has started; this one steps down and exits'), 50);
      return { ok: true };
    default:
      if (Object.hasOwn(agentOps, data.op)) return agentOps[data.op](data);
      return { ok: false, error: say('没有这个操作', 'Unknown operation') };
  }
}), 'GET');

// ---------- Extensions ----------
//
// extensions/<name>/index.mjs is loaded if present; without that folder this is a plain browser.
// Each extension exports setup(context). It can add endpoints itself through context.app, and it can return:
//   agentOps     operations added to /api/agent ({ name: async (data) => result })
//   panelScript  a script for the panel to load (a file path); it uses window.workbenchBrowser to add
//                buttons and a side column
//   panelStyle   a stylesheet for the panel to load (a file path)
//   timeZone     the time zone for dates shown in the panel (the system's if not given)
//   language     declared by an extension that has only one language ('zh' or 'en'); the whole panel then
//                stays in that language instead of ending up half Chinese and half English
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
    if (made.language) forceLanguage(made.language);
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
    log(`extension loaded: ${name}`);
  } catch (error) {
    log(`extension ${name} failed to load: ${error.message}`);
  }
}

// The entry for the agent's browser tools must be registered in mcp_config.json in the plugin root, with an
// absolute path. Nobody writes it for a copy installed with agy plugin install, so the backend checks it at
// every start and writes it if it is missing or the path is wrong.
// Right after it is first written, Antigravity may need a restart to pick it up.
const PLUGIN_ROOT = join(HERE, '..', '..');
const mcpEntry = join(PLUGIN_ROOT, 'mcp', 'launch.mjs');
if (!process.env.WORKBENCH_NO_MCP_CONFIG && existsSync(join(PLUGIN_ROOT, 'plugin.json')) && existsSync(mcpEntry)) {
  const configFile = join(PLUGIN_ROOT, 'mcp_config.json');
  const wanted = JSON.stringify({ mcpServers: { 'workbench-browser': { command: 'node', args: [mcpEntry] } } }, null, 2);
  let current = '';
  try {
    current = readFileSync(configFile, 'utf8');
  } catch {
    // not there yet
  }
  if (current !== wanted) {
    try {
      writeFileSync(configFile, wanted, 'utf8');
      log('registered the browser tools for the agent (mcp_config.json); restart Antigravity once if the tools do not show up');
    } catch (error) {
      log('could not write mcp_config.json: ' + error.message);
    }
  }
}

const server = await app.run();
const port = server?.address?.()?.port || Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const startedAt = new Date().toISOString();

// ---------- Only one backend at a time ----------
//
// Restarting Antigravity does not always stop the previous backend (observed: the language server is gone,
// but the cmd shell it started and the backend are still alive). The old backend keeps the browser profile
// locked, the browser started by the new backend sees the lock and exits at once, and the panel shows
// "The browser could not start". So there are two guards: a starting backend makes the registered old one
// exit, and every backend also watches the language server and exits when it is gone.

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
      // no such record
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
    // Only one that accepts the key is an old backend of ours. The pid may long since belong to another program;
    // anything that does not accept the key is left alone.
    const ours = await ask('status').then((status) => status.ok === true, () => false);
    if (!ours) continue;
    // The other one started less than 20 seconds ago: most likely two Antigravity instances each own a backend
    // and are pushing each other out. Do not fight over it, or they would keep killing each other.
    if (Date.now() - Date.parse(other.startedAt || 0) < Number(process.env.WORKBENCH_YIELD_GUARD_MS || 20000)) {
      log(`another backend (pid ${other.pid}) has just started; leaving it alone`);
      continue;
    }
    log(`the previous backend (pid ${other.pid}) is still running; asking it to exit`);
    await ask('quit').catch(() => {});
    for (let i = 0; i < 25 && alive(other.pid); i++) await sleep(200);
    if (alive(other.pid)) {
      try {
        process.kill(other.pid);
      } catch {
        // it exited by itself just now
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

// The language server address is given by Antigravity when it starts the backend (host:port). Once it has
// been reachable, three failures in a row mean Antigravity is gone.
// "Once it has been reachable" matters: if some version hands over an address that cannot be reached from
// here, a perfectly good backend must not exit because of that.
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
        quit('the Antigravity language server is gone, so nothing owns this backend any more; exiting');
      } else if (!reachedOnce && misses === 5) {
        log(`the language server address ${languageServer[0]} was never reachable; not using it to tell whether Antigravity is running`);
        clearInterval(watch);
      }
    };
    socket.setTimeout(3000, () => settle(false));
    socket.on('connect', () => settle(true));
    socket.on('error', () => settle(false));
  }, Number(process.env.WORKBENCH_LS_CHECK_MS || 20000));
  watch.unref();
}

// ---------- Panel connection ----------
//
// Antigravity does not let the panel connect to this backend directly: the panel page lives under
// plugin://<some id>, and every plain request it makes is forwarded by the Antigravity main process to an
// authenticated gateway, which forwards it here. Plain requests get through this way; long-lived connections
// do not. So the panel first asks with a plain request (/api/link) and gets this backend's real port and a key,
// then connects to ws://127.0.0.1:<port> directly. When the direct connection is not possible (for example
// when Antigravity is viewed remotely from another device), it falls back to plain requests only:
// /api/poll for the picture and messages, /api/input for mouse and keyboard.

const panelKey = randomBytes(24).toString('hex');

function attachClient(client) {
  clients.add(client);
  client.sendJson(stateMessage());
}

function detachClient(client) {
  clients.delete(client);
  if (!clients.size) browser.setCasting(false).catch(() => {});
}

// The "panel" when plain requests stand in for the long-lived connection: from the outside it looks the same
// as the WebSocket end (sendText / sendBinary / backlog / open).
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

  // Only the latest frame is kept: whenever the panel asks, it gets the current picture.
  sendBinary(frame) {
    this.#frame = frame;
    this.#frameSeq += 1;
    this.#wake();
  }

  // Answer at once if there is a new message or a new frame; otherwise hold the request, for at most 20 seconds.
  // The answer is binary: a 4-byte header length + a JSON header (messages, frame number) + the picture
  // (only when there is a new one).
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
// A closed panel stops asking; after half a minute of silence it is considered gone.
setInterval(() => {
  for (const [session, client] of pollClients) {
    if (client.waiting || Date.now() - client.lastSeen < 30000) continue;
    client.open = false;
    pollClients.delete(session);
    detachClient(client);
  }
}, 5000).unref();

// When the panel asks for the way in, it also reports the UI language it chose; error messages meant for
// people then use the same one.
app.api('/api/link', guarded((data) => {
  reportLanguage(data.lang);
  return { ok: true, port, key: panelKey, session: randomBytes(12).toString('hex') };
}));
app.api('/api/poll', guarded(async (data) => {
  const client = pollClient(data.session, true);
  if (!client) return { ok: false, error: say('会话无效', 'Invalid session') };
  return new Response(await client.next(Number(data.frameSeq) || 0), {
    contentType: 'application/octet-stream',
    headers: { 'Cache-Control': 'no-store' },
  });
}));
app.api('/api/input', guarded((data) => {
  // A panel reports its size as soon as it connects, and that message often arrives before the first /api/poll,
  // so a session has to be created here as well.
  const client = pollClient(data.session, true);
  if (!client) return { ok: false, error: say('会话无效', 'Invalid session') };
  client.lastSeen = Date.now();
  for (const message of Array.isArray(data.messages) ? data.messages : []) handleClientMessage(client, message);
  return { ok: true };
}));
// Whatever happens on the panel side (which path the connection took, what blocked it) is written to the log
// here, so diagnosing a problem does not need a screenshot from the user.
app.api('/api/client-log', guarded((data) => {
  log('[panel] ' + String(data.text || '').slice(0, 400));
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
    // The first thing a panel does after connecting is report its size and the screen's scale factor; the browser
    // waits for that before starting, so the scale factor is right.
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
    log('browser failed to start: ' + error.message);
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
  log('this SDK version does not expose the server object, so the panel cannot connect to the backend; the plugin needs an update');
}

// Nobody is watching and the agent has been idle for half an hour: close the browser to save memory.
// Logins stay in the profile and are still there next time.
setInterval(() => {
  if (!browser.running || clients.size) return;
  const idle = Date.now() - Math.max(browser.lastActivity, lastAgentPing);
  if (idle > IDLE_SHUTDOWN_MS) {
    log('idle; closing the browser');
    browser.shutdown().catch(() => {});
  }
}, 60 * 1000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    browser.shutdown().catch(() => {}).finally(() => process.exit(0));
  });
}
