import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CdpPipe } from './cdp.mjs';
import { HELPER_BINDING, HELPER_SOURCE, HELPER_WORLD } from './helper-script.mjs';
import { say } from './lang.mjs';

// 面板里那个真浏览器：一个无界面的 Chrome（没有就用 Edge），有自己的资料目录，登录状态留在里面。
// 画面一帧帧送给面板，面板上的鼠标键盘原样送回来。同一个浏览器另开了调试端口，
// 给 agent 的浏览器工具接，所以人和 agent 看到、操作的是同一批页面。

const STREAM_QUALITY = 75;
const SHARPEN_AFTER_MS = 400;
const MOTION_GAP_MS = 250;
const USER_BUSY_MS = 3000;
const MAX_RESTORED_TABS = 6;

export function findBrowserExecutable() {
  const candidates = [
    process.env.WORKBENCH_BROWSER_EXE,
    join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((path) => path && existsSync(path)) || null;
}

export const httpOnly = () => new Error(say('只能打开 http 或 https 地址', 'Only http and https addresses can be opened'));

// 地址栏里敲的东西 → 能打开的地址。只放行 http/https，本机文件和 chrome:// 之类不给进。
export function normalizeUrl(input, home) {
  const raw = String(input || '').trim();
  if (!raw) return home;
  if (/^about:blank$/i.test(raw)) return 'about:blank';
  if (/^:?\d{2,5}$/.test(raw)) return `http://127.0.0.1:${raw.replace(':', '')}/`;
  const search = () => 'https://www.bing.com/search?q=' + encodeURIComponent(raw);
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (/^(javascript|data|file|chrome|view-source|blob|about):/i.test(raw)) throw httpOnly();
    const hostLike = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^\s/:]+\.[^\s/:]+)(:\d+)?([/?#].*)?$/i.test(raw);
    if (!hostLike) return search();
    const local = /^(localhost|127\.|10\.|192\.168\.)/i.test(raw);
    candidate = (local ? 'http://' : 'https://') + raw;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return search();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpOnly();
  return url.href;
}

// 这台机器上有的父进程会带着 TZ=CST-8 这种写法的时区往下传，Chromium 认不得，
// 页面里的时间会整个错掉。不是标准地名写法的就不往下传，让浏览器用系统时区。
function browserEnv() {
  const env = { ...process.env };
  if (env.TZ && !/^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(env.TZ)) delete env.TZ;
  return env;
}

// zh、en 是「在等什么」的两种说法，超时的时候拼进报错里。
const withTimeout = (promise, ms, zh, en) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(say(`${zh}超时`, `Timed out ${en}`))), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

// 浏览器自己的内部页面（地址栏弹层、扩展后台页之类）也会报成 page，不能当标签页。
const isPage = (info) => info.type === 'page' && !/^(devtools|chrome-extension|chrome|chrome-untrusted|edge):/i.test(info.url || '');
// 标签页刚开出来时那一页空白不算历史，后退不该退到白页上去。
const firstRealEntry = (history) => (history.entries[0]?.url === 'about:blank' ? 1 : 0);
const originOf = (url) => {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
};

export class BrowserHost extends EventEmitter {
  #cdp = null;
  #proc = null;
  #starting = null;
  #bySession = new Map();
  #attaching = new Set();
  #pendingActivate = new Set();
  #stateTimer = null;
  #saveTimer = null;
  #titleTimer = null;
  #casting = false;
  #lastUserInput = 0;
  #lastUserClick = 0;
  #firstTab = null;
  #restoring = false;

  constructor({ dataDir, homeUrl, log = () => {} }) {
    super();
    this.dataDir = dataDir;
    this.profileDir = join(dataDir, 'browser-profile');
    this.tabsFile = join(dataDir, 'tabs.json');
    this.displayFile = join(dataDir, 'display.json');
    this.homeUrl = homeUrl;
    this.log = log;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    // dpr 是面板所在屏幕的缩放比。没有面板连着时（agent 自己叫醒浏览器）沿用上次面板报的。
    let lastDpr = 1;
    try {
      lastDpr = Number(JSON.parse(readFileSync(this.displayFile, 'utf8')).dpr) || 1;
    } catch {
      // 还没存过
    }
    this.viewport = { width: 1280, height: 800, dpr: lastDpr };
    // 浏览器按哪个缩放比起的。起了之后不再变——见 #applyViewport 的说明。
    this.launchDpr = lastDpr;
    // 这次启动以来有没有面板连上来过（见 matchDisplay）。
    this.panelSeen = false;
    this.product = '';
    this.lastError = '';
    this.lastActivity = Date.now();
  }

  get running() {
    return !!this.#cdp && !this.#cdp.closed;
  }

  get active() {
    return this.tabs.get(this.activeId) || null;
  }

  // agent 的浏览器工具靠这个文件找到同一个浏览器。
  get debugPort() {
    try {
      const [port] = readFileSync(join(this.profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
      return Number(port) || null;
    } catch {
      return null;
    }
  }

  snapshot() {
    return {
      running: this.running,
      starting: !!this.#starting,
      product: this.product,
      error: this.lastError,
      active: this.activeId,
      tabs: this.order.map((id) => this.tabs.get(id)).filter(Boolean).map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        canBack: tab.canBack,
        canForward: tab.canForward,
        crashed: tab.crashed,
        busy: tab.busy,
        dialog: tab.dialog,
        fileChooser: tab.fileChooser ? { multiple: tab.fileChooser.multiple } : null,
      })),
    };
  }

  // ---------- 启动与关闭 ----------

  async ensure() {
    if (this.running) return;
    if (!this.#starting) {
      this.lastError = '';
      this.#changed();
      this.#starting = (async () => {
        // 上一个浏览器刚退、资料目录还没放手时，新的会一起来就退出；等一下再试两次。
        for (let attempt = 0; ; attempt++) {
          try {
            await this.#launch();
            return;
          } catch (error) {
            this.#teardown();
            if (attempt >= 2 || error.retry === false) {
              this.lastError = error.message;
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
      })().finally(() => {
        this.#starting = null;
        this.#changed();
      });
    }
    return this.#starting;
  }

  async #launch() {
    const exe = findBrowserExecutable();
    if (!exe) {
      // 再试也不会有，直接报。
      throw Object.assign(new Error(say('没找到 Chrome 或 Edge，内置浏览器起不来', 'Chrome or Edge was not found, so the built-in browser cannot start')), { retry: false });
    }
    mkdirSync(this.profileDir, { recursive: true });
    this.launchDpr = this.viewport.dpr;
    this.panelSeen = false;
    const proc = spawn(exe, [
      '--headless=new',
      '--remote-debugging-pipe',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--window-size=1280,800',
      `--force-device-scale-factor=${this.launchDpr}`,
      // 浏览器自己用哪种语言（网站据此给哪种语言的页面）：不指定，让它跟系统走，和用户平时的 Chrome 一样。
      // 想另指一种就设 WORKBENCH_BROWSER_LANG（比如 ja、en-GB）。
      ...(process.env.WORKBENCH_BROWSER_LANG ? [`--lang=${process.env.WORKBENCH_BROWSER_LANG}`] : []),
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true, env: browserEnv() });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    proc.on('error', (error) => {
      this.lastError = say(`浏览器启动失败：${error.message}`, `The browser failed to start: ${error.message}`);
    });
    const cdp = new CdpPipe(proc.stdio[3], proc.stdio[4]);
    this.#proc = proc;
    this.#cdp = cdp;
    cdp.on('close', () => {
      if (this.#cdp !== cdp) return;
      this.log('浏览器已退出');
      this.#teardown();
      this.emit('closed');
      this.#changed();
    });
    cdp.on('event', (message) => {
      try {
        this.#onEvent(message);
      } catch (error) {
        this.log('处理浏览器事件出错：' + error.message);
      }
    });

    let version;
    try {
      version = await withTimeout(cdp.send('Browser.getVersion'), 20000, '等待浏览器启动', 'waiting for the browser to start');
    } catch (error) {
      // 同一个资料目录已经有浏览器在跑时，新进程会把活交给旧的然后立刻退出。
      const detail = stderr ? stderr.trim().split('\n').pop() : '';
      throw new Error(say(
        `浏览器没能启动（${error.message}）${detail ? '：' + detail : ''}`,
        `The browser could not start (${error.message})${detail ? ': ' + detail : ''}`,
      ));
    }
    this.product = version.product || '';
    this.log(`浏览器已启动：${this.product}`);

    const firstTab = new Promise((resolve) => { this.#firstTab = resolve; });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await withTimeout(firstTab, 15000, '等待第一个标签页', 'waiting for the first tab');
    await this.#restoreTabs();
  }

  async #restoreTabs() {
    let saved = { urls: [], active: 0 };
    try {
      saved = JSON.parse(readFileSync(this.tabsFile, 'utf8'));
    } catch {
      // 第一次用，没有存过
    }
    const urls = (Array.isArray(saved.urls) ? saved.urls : []).filter((url) => originOf(url)).slice(0, MAX_RESTORED_TABS);
    if (!urls.length) urls.push(this.homeUrl);
    this.#restoring = true;
    try {
      const first = this.tabs.get(this.order[0]);
      if (first) await this.#send(first, 'Page.navigate', { url: urls[0] }).catch(() => {});
      for (const url of urls.slice(1)) {
        await this.#cdp.send('Target.createTarget', { url }).catch(() => {});
      }
      // 其余标签页是异步挂上来的，等它们到齐再切回上次停留的那个。
      const deadline = Date.now() + 3000;
      while (this.order.length < urls.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const wanted = this.order[Math.min(Math.max(0, saved.active | 0), this.order.length - 1)];
      if (wanted && wanted !== this.activeId) await this.selectTab(wanted);
    } finally {
      this.#restoring = false;
    }
  }

  // 关浏览器，等它真的退干净再返回（紧接着重开时，资料目录不能还被旧进程占着）。
  async shutdown() {
    if (!this.running) return;
    this.#saveTabsNow();
    const cdp = this.#cdp;
    const proc = this.#proc;
    const exited = new Promise((resolve) => {
      if (!proc || proc.exitCode !== null) resolve();
      else proc.once('exit', resolve);
    });
    try {
      await withTimeout(cdp.send('Browser.close'), 3000, '关闭浏览器', 'closing the browser');
    } catch {
      proc?.kill();
    }
    await withTimeout(exited, 8000, '等浏览器退出', 'waiting for the browser to exit').catch(() => proc?.kill());
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 浏览器是 agent 先叫醒的（那时没有面板，不知道屏幕缩放比），现在面板连上来了、缩放比对不上：
  // 趁还没人看过，按面板的缩放比重开一次，不然人看到的字是放大糊掉的。标签页按地址恢复。
  async matchDisplay(dpr) {
    const wanted = Math.min(3, Math.max(1, Math.round((Number(dpr) || 1) * 100) / 100));
    const stale = this.running && !this.panelSeen && wanted !== this.launchDpr;
    this.panelSeen = true;
    if (!stale) return false;
    this.log(`按面板的缩放比 ${wanted} 重开浏览器（原来是 ${this.launchDpr}）`);
    await this.shutdown();
    return true;
  }

  #teardown() {
    for (const tab of this.tabs.values()) {
      clearTimeout(tab.sharpTimer);
      clearTimeout(tab.historyTimer);
    }
    this.tabs.clear();
    this.#bySession.clear();
    this.#attaching.clear();
    this.#pendingActivate.clear();
    this.order = [];
    this.activeId = null;
    const proc = this.#proc;
    this.#proc = null;
    this.#cdp = null;
    if (proc && proc.exitCode === null) {
      try { proc.kill(); } catch { /* 已经没了 */ }
    }
  }

  // ---------- 标签页 ----------

  #onEvent({ method, params, sessionId }) {
    if (!sessionId) {
      if (method === 'Target.targetCreated') {
        if (isPage(params.targetInfo)) this.#attach(params.targetInfo);
      } else if (method === 'Target.targetInfoChanged') {
        const info = params.targetInfo;
        const tab = this.tabs.get(info.targetId);
        if (tab && !isPage(info)) {
          this.#cdp.send('Target.detachFromTarget', { sessionId: tab.sessionId }).catch(() => {});
          this.#removeTab(tab.id);
        } else if (tab) {
          // 这个事件只在换地址时来，带的标题是加载前的占位；真正的标题由页面里的帮手报上来。
          if (info.url && info.url !== tab.infoUrl) {
            tab.infoUrl = info.url;
            tab.title = info.title || '';
            if (!tab.unreachable) tab.url = info.url;
            this.#changed();
          }
        } else if (isPage(info)) {
          this.#attach(info);
        }
      } else if (method === 'Target.targetDestroyed') {
        this.#removeTab(params.targetId);
      } else if (method === 'Target.detachedFromTarget') {
        const tab = this.#bySession.get(params.sessionId);
        if (tab) this.#removeTab(tab.id);
      }
      return;
    }
    const tab = this.#bySession.get(sessionId);
    if (!tab) return;
    this.lastActivity = Date.now();
    switch (method) {
      case 'Page.screencastFrame':
        this.#onFrame(tab, params);
        break;
      case 'Page.frameStartedLoading':
        if (params.frameId === tab.mainFrameId) {
          tab.loading = true;
          this.#changed();
        }
        break;
      case 'Page.frameStoppedLoading':
        if (params.frameId === tab.mainFrameId) {
          tab.loading = false;
          this.#refreshHistory(tab);
          this.#refreshTitle(tab);
          if (tab.id === this.activeId && this.#casting && !tab.casting) this.#startCast(tab, 'jpeg');
          this.#changed();
          this.emit('settled', tab);
        }
        break;
      case 'Page.frameNavigated':
        if (!params.frame.parentId) {
          tab.mainFrameId = params.frame.id;
          tab.unreachable = !!params.frame.unreachableUrl;
          tab.url = params.frame.unreachableUrl || params.frame.url;
          tab.crashed = false;
          // 跨站跳转会换渲染进程，帮手的通道有时没跟着装上，这里补一次（重复装无害）。
          this.#send(tab, 'Runtime.addBinding', { name: HELPER_BINDING, executionContextName: HELPER_WORLD }).catch(() => {});
          // 后台标签页自己在动（多半是 agent 在里面干活）：亮个点，不抢画面。
          if (tab.id !== this.activeId && !this.#restoring) tab.busy = true;
          this.#refreshHistory(tab);
          this.#changed();
        }
        break;
      case 'Page.navigatedWithinDocument':
        if (params.frameId === tab.mainFrameId) {
          tab.url = params.url;
          this.#refreshHistory(tab);
          this.#changed();
          this.emit('settled', tab);
        }
        break;
      case 'Page.javascriptDialogOpening':
        tab.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt || '' };
        this.#changed();
        break;
      case 'Page.javascriptDialogClosed':
        tab.dialog = null;
        this.#changed();
        break;
      case 'Page.fileChooserOpened':
        tab.fileChooser = { backendNodeId: params.backendNodeId, multiple: params.mode === 'selectMultiple' };
        this.#changed();
        break;
      case 'Runtime.bindingCalled':
        if (params.name === HELPER_BINDING) this.#onHelper(tab, params);
        break;
      case 'Inspector.targetCrashed':
        tab.crashed = true;
        tab.loading = false;
        this.#changed();
        break;
      default:
        break;
    }
  }

  async #attach(info) {
    const id = info.targetId;
    if (this.tabs.has(id) || this.#attaching.has(id) || !this.#cdp) return;
    this.#attaching.add(id);
    try {
      const { sessionId } = await this.#cdp.send('Target.attachToTarget', { targetId: id, flatten: true });
      const tab = {
        id,
        sessionId,
        url: info.url || 'about:blank',
        title: info.title || '',
        loading: false,
        unreachable: false,
        mainFrameId: null,
        canBack: false,
        canForward: false,
        dialog: null,
        fileChooser: null,
        crashed: false,
        busy: false,
        casting: false,
        castStarting: false,
        castRestart: false,
        castWanted: 'jpeg',
        castFormat: 'jpeg',
        formatSince: 0,
        lastFrameAt: 0,
        mismatchSince: 0,
        viewportFixedAt: 0,
        infoUrl: info.url || '',
        helperContext: null,
        sharpTimer: null,
        historyTimer: null,
      };
      this.tabs.set(id, tab);
      this.#bySession.set(sessionId, tab);
      this.order.push(id);
      await this.#setupTab(tab);
      // 人刚在页面上点了一下就冒出来的新标签页，是那一下点开的（target=_blank 的链接、弹出窗口）。
      const openedByClick = (info.openerId && info.openerId === this.activeId) || Date.now() - this.#lastUserClick < 1500;
      const userAsked = this.#pendingActivate.delete(id) || this.#pendingActivate.delete('next');
      if (!this.activeId || userAsked || (openedByClick && !this.#restoring)) {
        await this.selectTab(id);
      } else if (!this.#restoring) {
        // 不是人开的新标签页，就是 agent 开的：人此刻没在点没在打字就跟过去看，否则只亮个点。
        if (Date.now() - this.#lastUserInput > USER_BUSY_MS) await this.selectTab(id);
        else tab.busy = true;
      }
      this.#changed();
      if (this.#firstTab) {
        this.#firstTab();
        this.#firstTab = null;
      }
    } catch (error) {
      this.log(`挂接标签页失败：${error.message}`);
    } finally {
      this.#attaching.delete(id);
    }
  }

  async #setupTab(tab) {
    await this.#send(tab, 'Page.enable');
    // 不开 Runtime，帮手报的信收不到。先给通道再装帮手，帮手一运行就能报信。
    await this.#send(tab, 'Runtime.enable').catch(() => {});
    await this.#send(tab, 'Runtime.addBinding', { name: HELPER_BINDING, executionContextName: HELPER_WORLD }).catch(() => {});
    await this.#send(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: HELPER_SOURCE, worldName: HELPER_WORLD, runImmediately: true }).catch(() => {});
    await this.#send(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.#send(tab, 'Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
    await this.#applyViewport(tab);
    try {
      const { frameTree } = await this.#send(tab, 'Page.getFrameTree');
      tab.mainFrameId = frameTree.frame.id;
      tab.unreachable = !!frameTree.frame.unreachableUrl;
      tab.url = frameTree.frame.unreachableUrl || frameTree.frame.url || tab.url;
    } catch {
      // 页面正在换，等导航事件来补
    }
    // 挂上来时页面可能早就加载完了，不会再有加载结束的事件，这里补读一次标题。
    this.#refreshTitle(tab);
  }

  #removeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    clearTimeout(tab.sharpTimer);
    clearTimeout(tab.historyTimer);
    this.tabs.delete(id);
    this.#bySession.delete(tab.sessionId);
    const index = this.order.indexOf(id);
    this.order = this.order.filter((other) => other !== id);
    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[Math.min(index, this.order.length - 1)];
      if (next) this.selectTab(next).catch(() => {});
      else if (this.running && this.#casting) this.newTab(this.homeUrl).catch(() => {});
    }
    this.#changed();
  }

  async newTab(input) {
    await this.ensure();
    const url = normalizeUrl(input, this.homeUrl);
    this.#pendingActivate.add('next');
    const { targetId } = await this.#cdp.send('Target.createTarget', { url });
    if (this.tabs.has(targetId)) await this.selectTab(targetId);
    return targetId;
  }

  async selectTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const previous = this.active;
    if (previous && previous !== tab) await this.#stopCast(previous);
    this.activeId = id;
    tab.busy = false;
    await this.#send(tab, 'Page.bringToFront').catch(() => {});
    if (this.#casting) this.#startCast(tab, 'jpeg');
    this.#verifyViewport(tab);
    this.#refreshHistory(tab);
    this.#changed();
  }

  async closeTab(id) {
    if (!this.tabs.has(id)) return;
    if (this.tabs.size === 1) await this.newTab(this.homeUrl);
    await this.#cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
  }

  // ---------- 导航 ----------

  async navigate(input, tabId = this.activeId) {
    await this.ensure();
    const tab = this.tabs.get(tabId) || this.active;
    if (!tab) return this.newTab(input);
    const url = normalizeUrl(input, this.homeUrl);
    tab.loading = true;
    tab.url = url;
    this.#changed();
    await this.#send(tab, 'Page.navigate', { url });
    return tab.id;
  }

  async #step(delta) {
    const tab = this.active;
    if (!tab) return;
    const history = await this.#send(tab, 'Page.getNavigationHistory');
    const index = history.currentIndex + delta;
    if (index < firstRealEntry(history)) return;
    const entry = history.entries[index];
    if (entry) await this.#send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  back() { return this.#step(-1); }
  forward() { return this.#step(1); }

  async reload() {
    const tab = this.active;
    if (tab) await this.#send(tab, 'Page.reload', {});
  }

  async stop() {
    const tab = this.active;
    if (tab) await this.#send(tab, 'Page.stopLoading');
  }

  // 帮手报不上来的页面（比如出错页）用这个兜底。
  async #refreshTitle(tab) {
    try {
      const result = await this.#send(tab, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      const title = result.result?.value;
      if (typeof title === 'string' && title && title !== tab.title) {
        tab.title = title.slice(0, 300);
        this.#changed();
      }
    } catch {
      // 页面正在换
    }
  }

  #refreshHistory(tab) {
    clearTimeout(tab.historyTimer);
    tab.historyTimer = setTimeout(async () => {
      try {
        const history = await this.#send(tab, 'Page.getNavigationHistory');
        const canBack = history.currentIndex > firstRealEntry(history);
        const canForward = history.currentIndex < history.entries.length - 1;
        if (canBack !== tab.canBack || canForward !== tab.canForward) {
          tab.canBack = canBack;
          tab.canForward = canForward;
          this.#changed();
        }
      } catch {
        // 标签页刚关
      }
    }, 120);
  }

  // ---------- 画面 ----------

  async setViewport({ width, height, dpr }) {
    const next = {
      width: Math.round(Math.min(3840, Math.max(320, Number(width) || 0))),
      height: Math.round(Math.min(2160, Math.max(240, Number(height) || 0))),
      dpr: Math.min(3, Math.max(1, Math.round((Number(dpr) || 1) * 100) / 100)),
    };
    const same = next.width === this.viewport.width && next.height === this.viewport.height;
    if (next.dpr !== this.viewport.dpr) {
      try {
        mkdirSync(this.dataDir, { recursive: true });
        writeFileSync(this.displayFile, JSON.stringify({ dpr: next.dpr }), 'utf8');
      } catch {
        // 记不下来不要紧，下次按默认起
      }
    }
    this.viewport = next;
    if (same || !this.running) return;
    await Promise.all([...this.tabs.values()].map((tab) => this.#applyViewport(tab)));
    const tab = this.active;
    if (!tab) return;
    if (this.#casting) this.#startCast(tab, 'jpeg');
    this.#verifyViewport(tab);
  }

  // 只改页面的宽高，不模拟缩放比（deviceScaleFactor: 0）；缩放比在启动时用命令行定死
  //（--force-device-scale-factor），整个浏览器天生就是那个比例。
  // 早先在这里连缩放比一起模拟，结果鼠标坐标时对时错：点 (300,300) 页面收到 (200,200)，
  // 每改一次视口还可能翻一次面。那时同时在用 Page.captureScreenshot 补清晰图——它遇到
  //「模拟的缩放比 ≠ 真实缩放比」会临时改一轮模拟参数再恢复，多半是两边撞车。没有再去分清
  // 到底是谁，两样都不用了：这样 Chrome 里不存在需要来回恢复的模拟状态。
  // 面板之后换到缩放比不同的屏幕，画面由面板缩放显示，下次启动浏览器时再跟上。
  async #applyViewport(tab) {
    const { width, height } = this.viewport;
    await this.#send(tab, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false }).catch(() => {});
  }

  // 有面板开着才出画面；没人看就停，省 CPU。
  async setCasting(on) {
    this.#casting = on;
    // 标题平时靠页面里的帮手报；有面板看着的时候再定时核一遍，帮手没装上的页面也不会停在旧标题。
    clearInterval(this.#titleTimer);
    this.#titleTimer = on ? setInterval(() => {
      for (const tab of this.tabs.values()) if (!tab.dialog) this.#refreshTitle(tab);
    }, 2000) : null;
    this.#titleTimer?.unref();
    const tab = this.active;
    if (!tab) return;
    if (on) this.#startCast(tab, 'jpeg');
    else await this.#stopCast(tab);
  }

  // 开（或按新参数重开）画面流。format 不给就沿用上次要的格式。
  // 页面正在跳转的那一瞬间 Chrome 会拒绝（Not attached to an active page），所以失败了要接着试。
  #startCast(tab, format) {
    if (format) tab.castWanted = format;
    if (tab.castStarting) {
      tab.castRestart = true;
      return;
    }
    tab.castStarting = true;
    (async () => {
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          if (tab.id !== this.activeId || !this.#casting || !this.tabs.has(tab.id)) return;
          tab.castRestart = false;
          const wanted = tab.castWanted;
          const { width, height } = this.viewport;
          try {
            if (tab.casting) await this.#send(tab, 'Page.stopScreencast');
            await this.#send(tab, 'Page.startScreencast', {
              format: wanted,
              ...(wanted === 'jpeg' ? { quality: STREAM_QUALITY } : {}),
              maxWidth: Math.ceil(width * this.launchDpr),
              maxHeight: Math.ceil(height * this.launchDpr),
              everyNthFrame: 1,
            });
            tab.casting = true;
            tab.castFormat = wanted;
            tab.formatSince = Date.now();
            if (!tab.castRestart) return;
          } catch {
            tab.casting = false;
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
      } finally {
        tab.castStarting = false;
      }
    })();
  }

  async #stopCast(tab) {
    clearTimeout(tab.sharpTimer);
    if (!tab.casting) return;
    tab.casting = false;
    await this.#send(tab, 'Page.stopScreencast').catch(() => {});
  }

  // 画面在动时用有损格式（快）；静下来 0.4 秒就把画面流切成无损格式，Chrome 重开时会立刻送一张，字就清楚了。
  // 无损模式里零星的变化（光标闪一下、敲一个字）照样无损地送；帧来得密说明又动起来了，切回有损。
  //
  // 不用 Page.captureScreenshot 补清晰图：它收尾时会把视口恢复成它开始时的样子，
  // 正好撞上面板改大小，新尺寸就被冲掉（实测必现），页面不重排、画面被挤扁。
  #onFrame(tab, params) {
    this.#send(tab, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    if (tab.id !== this.activeId || !this.#casting) return;
    this.emit('frame', Buffer.from(params.data, 'base64'));
    const now = Date.now();
    const moving = now - tab.lastFrameAt < MOTION_GAP_MS;
    tab.lastFrameAt = now;
    clearTimeout(tab.sharpTimer);
    if (tab.castFormat === 'png') {
      // 刚切过来时 Chrome 可能连送两张，不算「动起来了」，否则会在两种格式之间来回倒。
      if (moving && now - tab.formatSince > 300) this.#startCast(tab, 'jpeg');
    } else {
      tab.sharpTimer = setTimeout(() => this.#startCast(tab, 'png'), SHARPEN_AFTER_MS);
    }
    this.#checkViewport(tab, params.metadata);
  }

  // 帧里带着页面当时的实际大小。和面板要的对不上（比如 agent 那边的工具动过视口），就重新设一次。
  #checkViewport(tab, metadata) {
    if (!metadata) return;
    const { width, height } = this.viewport;
    const matches = Math.abs(metadata.deviceWidth - width) <= 1 && Math.abs(metadata.deviceHeight - height) <= 1;
    const now = Date.now();
    if (matches) {
      tab.mismatchSince = 0;
    } else if (!tab.mismatchSince) {
      tab.mismatchSince = now; // 可能只是改大小的命令还在路上，等一等
    } else if (now - tab.mismatchSince > 700 && now - tab.viewportFixedAt > 2000) {
      tab.viewportFixedAt = now;
      this.#applyViewport(tab);
    }
  }

  // 没有新帧的静止页面，上面那个检查碰不到；改完大小、切到一个标签页之后主动核一次。
  async #verifyViewport(tab, attempt = 0) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (!this.tabs.has(tab.id) || tab.dialog) return;
    const { width, height } = this.viewport;
    try {
      const result = await this.#send(tab, 'Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true });
      const [actualWidth, actualHeight] = result.result?.value || [];
      if (Math.abs(actualWidth - width) <= 1 && Math.abs(actualHeight - height) <= 1) return;
      await this.#applyViewport(tab);
      if (attempt < 3) this.#verifyViewport(tab, attempt + 1);
      else this.log(`页面大小设不上：要 ${width}x${height}，实际 ${actualWidth}x${actualHeight}`);
    } catch {
      // 页面正在换
    }
  }

  // ---------- 输入 ----------

  #touch() {
    this.#lastUserInput = Date.now();
    this.lastActivity = this.#lastUserInput;
  }

  mouse(event) {
    const tab = this.active;
    if (!tab || tab.dialog) return;
    this.#touch();
    const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' }[event.type];
    if (!type) return;
    const buttons = event.buttons | 0;
    const held = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none';
    const params = {
      type,
      x: Number(event.x) || 0,
      y: Number(event.y) || 0,
      modifiers: event.mods | 0,
      buttons,
      button: type === 'mouseMoved' ? held : (['left', 'middle', 'right'][event.button] || 'none'),
      clickCount: type === 'mousePressed' || type === 'mouseReleased' ? Math.max(1, event.clickCount | 0) : 0,
    };
    if (type === 'mouseWheel') {
      params.button = 'none';
      params.deltaX = Number(event.dx) || 0;
      params.deltaY = Number(event.dy) || 0;
    }
    if (type === 'mouseReleased') this.#lastUserClick = Date.now();
    this.#send(tab, 'Input.dispatchMouseEvent', params).catch(() => {});
  }

  key(event) {
    const tab = this.active;
    if (!tab || tab.dialog) return;
    this.#touch();
    const base = {
      key: String(event.key || ''),
      code: String(event.code || ''),
      windowsVirtualKeyCode: event.keyCode | 0,
      nativeVirtualKeyCode: event.keyCode | 0,
      modifiers: event.mods | 0,
      location: event.location | 0,
    };
    if (event.type === 'down') {
      if (base.key === 'Enter') this.#lastUserClick = Date.now();
      const text = typeof event.text === 'string' && event.text ? event.text : undefined;
      this.#send(tab, 'Input.dispatchKeyEvent', {
        ...base,
        type: text ? 'keyDown' : 'rawKeyDown',
        autoRepeat: !!event.repeat,
        ...(text ? { text, unmodifiedText: text } : {}),
      }).catch(() => {});
    } else if (event.type === 'up') {
      this.#send(tab, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }).catch(() => {});
    }
  }

  // 输入法上屏的字、表情面板之类：不走按键，直接当成一段文字插进去。
  insertText(text) {
    const tab = this.active;
    if (!tab || tab.dialog || !text) return;
    this.#touch();
    this.#send(tab, 'Input.insertText', { text: String(text) }).catch(() => {});
  }

  async #clipboardReady(tab) {
    const origin = originOf(tab.url);
    if (!origin) return false;
    try {
      await this.#cdp.send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
      return true;
    } catch {
      return false;
    }
  }

  // 粘贴：先把文字放进这个浏览器自己的剪贴板，再按一次 Ctrl+V。
  // 这样页面收到的是一次真粘贴，富文本编辑器才会按段落处理；不行再退回逐段插入。
  async paste(input, tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.dialog || typeof input !== 'string' || !input) return 'none';
    // Windows 剪贴板里的换行是 \r\n，原样贴进富文本框会多出空行。
    const text = input.replace(/\r\n?/g, '\n');
    this.#touch();
    if (await this.#clipboardReady(tab)) {
      try {
        const written = await this.#send(tab, 'Runtime.evaluate', {
          expression: `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        if (written.result?.value === true) {
          const combo = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 };
          await this.#send(tab, 'Input.dispatchKeyEvent', { ...combo, type: 'rawKeyDown' });
          await this.#send(tab, 'Input.dispatchKeyEvent', { ...combo, type: 'keyUp' });
          return 'paste';
        }
      } catch {
        // 页面不让用剪贴板，走下面
      }
    }
    await this.#send(tab, 'Input.insertText', { text }).catch(() => {});
    return 'insert';
  }

  // 面板上按了 Ctrl+C / Ctrl+X 之后来取：读这个浏览器的剪贴板，交给面板写进系统剪贴板。
  async readClipboard() {
    const tab = this.active;
    if (!tab || !(await this.#clipboardReady(tab))) return '';
    await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      const read = await this.#send(tab, 'Runtime.evaluate', {
        expression: 'navigator.clipboard.readText()',
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      return typeof read.result?.value === 'string' ? read.result.value : '';
    } catch {
      return '';
    }
  }

  async pickSelect(index) {
    const tab = this.active;
    if (!tab || !tab.helperContext) return;
    await this.#send(tab, 'Runtime.evaluate', {
      expression: `globalThis.__workbenchBrowserPick(${Number(index) | 0})`,
      contextId: tab.helperContext,
    }).catch(() => {});
  }

  async answerDialog(accept, text) {
    const tab = this.active;
    if (!tab || !tab.dialog) return;
    tab.dialog = null;
    this.#changed();
    await this.#send(tab, 'Page.handleJavaScriptDialog', { accept: !!accept, promptText: typeof text === 'string' ? text : undefined }).catch(() => {});
  }

  async chooseFiles(paths) {
    const tab = this.active;
    if (!tab || !tab.fileChooser) return;
    const chooser = tab.fileChooser;
    tab.fileChooser = null;
    this.#changed();
    const files = (Array.isArray(paths) ? paths : []).map((path) => String(path).trim()).filter(Boolean);
    if (!files.length) return;
    const missing = files.find((path) => !existsSync(path));
    if (missing) throw new Error(say(`没有这个文件：${missing}`, `No such file: ${missing}`));
    await this.#send(tab, 'DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId });
  }

  #onHelper(tab, params) {
    let message;
    try {
      message = JSON.parse(params.payload);
    } catch {
      return;
    }
    if (message.type === 'select') {
      tab.helperContext = params.executionContextId;
      if (tab.id === this.activeId) this.emit('select', { rect: message.rect, options: message.options, selected: message.selected });
    } else if (message.type === 'cursor') {
      if (tab.id === this.activeId) this.emit('cursor', String(message.cursor || 'default'));
    } else if (message.type === 'title') {
      const title = String(message.title || '').slice(0, 300);
      if (title !== tab.title) {
        tab.title = title;
        this.#changed();
      }
    }
  }

  // ---------- 读页面（给看板核对用，只读不改） ----------

  async evaluate(expression, tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(say('没有打开的页面', 'No page is open'));
    const result = await this.#send(tab, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || say('页面里执行出错', 'The script failed in the page'));
    return result.result?.value;
  }

  pageText(tabId = this.activeId) {
    return this.evaluate('document.body ? document.body.innerText : ""', tabId);
  }

  // ---------- 内部 ----------

  #send(tab, method, params = {}) {
    if (!this.#cdp) return Promise.reject(new Error(say('浏览器没在运行', 'The browser is not running')));
    return this.#cdp.send(method, params, tab.sessionId);
  }

  #changed() {
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      this.emit('state', this.snapshot());
      this.#saveTabsSoon();
    }, 30);
  }

  #saveTabsSoon() {
    if (this.#saveTimer || !this.running) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#saveTabsNow();
    }, 1500);
  }

  #saveTabsNow() {
    if (!this.running || !this.order.length) return;
    const urls = this.order.map((id) => this.tabs.get(id)?.url).filter((url) => originOf(url));
    if (!urls.length) return;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.tabsFile, JSON.stringify({ urls, active: Math.max(0, this.order.indexOf(this.activeId)) }, null, 2), 'utf8');
    } catch (error) {
      this.log('记标签页失败：' + error.message);
    }
  }
}
