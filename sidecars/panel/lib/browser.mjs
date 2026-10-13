import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CdpPipe } from './cdp.mjs';
import { HELPER_BINDING, HELPER_SOURCE, HELPER_WORLD } from './helper-script.mjs';
import { say } from './lang.mjs';

// The real browser behind the panel: a headless Chrome (Edge if Chrome is missing) with its own profile,
// where logins stay. The picture is sent to the panel frame by frame, and the panel's mouse and keyboard
// input is sent back as is. The same browser also opens a debug port for the agent's browser tools,
// so the user and the agent see and operate the same set of pages.

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

// What was typed into the address bar → an address that can be opened. Only http/https is let through;
// local files, chrome:// and the like are refused.
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

// Some parent processes pass down a time zone written like TZ=CST-8, which Chromium does not understand,
// and every time shown in a page would be wrong. Anything that is not a standard Area/Location name is not
// passed on, so the browser uses the system time zone.
function browserEnv() {
  const env = { ...process.env };
  if (env.TZ && !/^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(env.TZ)) delete env.TZ;
  return env;
}

// zh and en are the two ways of saying what is being waited for; they go into the error message on timeout.
const withTimeout = (promise, ms, zh, en) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(say(`${zh}超时`, `Timed out ${en}`))), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

// The browser's own internal pages (the omnibox popup, extension background pages and so on) are also
// reported as "page" targets; they must not be treated as tabs.
const isPage = (info) => info.type === 'page' && !/^(devtools|chrome-extension|chrome|chrome-untrusted|edge):/i.test(info.url || '');
// The blank page a tab starts with does not count as history; going back must not land on a blank page.
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
    // dpr is the scale factor of the screen the panel is on. With no panel connected (the agent woke the browser
    // by itself), the last value a panel reported is used.
    let lastDpr = 1;
    try {
      lastDpr = Number(JSON.parse(readFileSync(this.displayFile, 'utf8')).dpr) || 1;
    } catch {
      // never saved yet
    }
    this.viewport = { width: 1280, height: 800, dpr: lastDpr };
    // The scale factor the browser was started with. It never changes afterwards; see the note on #applyViewport.
    this.launchDpr = lastDpr;
    // Whether a panel has connected since this start (see matchDisplay).
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

  // The agent's browser tools find the same browser through this file.
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

  // ---------- Start and stop ----------

  async ensure() {
    if (this.running) return;
    if (!this.#starting) {
      this.lastError = '';
      this.#changed();
      this.#starting = (async () => {
        // Right after the previous browser exits, while it has not yet let go of the profile, a new one exits as
        // soon as it starts; wait a little and try twice more.
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
      // Retrying will not make one appear; report it right away.
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
      // Which language the browser itself uses (websites choose the page language from it): none is given, so it
      // follows the system, like the user's everyday Chrome.
      // Set WORKBENCH_BROWSER_LANG to choose another (for example ja or en-GB).
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
      this.log('browser exited');
      this.#teardown();
      this.emit('closed');
      this.#changed();
    });
    cdp.on('event', (message) => {
      try {
        this.#onEvent(message);
      } catch (error) {
        this.log('error while handling a browser event: ' + error.message);
      }
    });

    let version;
    try {
      version = await withTimeout(cdp.send('Browser.getVersion'), 20000, '等待浏览器启动', 'waiting for the browser to start');
    } catch (error) {
      // When a browser is already running on the same profile, the new process hands the work over to it and
      // exits at once.
      const detail = stderr ? stderr.trim().split('\n').pop() : '';
      throw new Error(say(
        `浏览器没能启动（${error.message}）${detail ? '：' + detail : ''}`,
        `The browser could not start (${error.message})${detail ? ': ' + detail : ''}`,
      ));
    }
    this.product = version.product || '';
    this.log(`browser started: ${this.product}`);

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
      // first use, nothing saved yet
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
      // The other tabs attach asynchronously; wait until they are all here, then switch back to the one that was
      // active last time.
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

  // Close the browser and return only once it has really exited (when it is reopened right away, the profile
  // must no longer be held by the old process).
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

  // The agent woke the browser first (there was no panel then, so the screen's scale factor was unknown), and
  // now a panel has connected with a different scale factor: while nobody has looked at it yet, restart once
  // at the panel's scale factor, otherwise the text the user sees is upscaled and blurry.
  // Tabs are restored by address.
  async matchDisplay(dpr) {
    const wanted = Math.min(3, Math.max(1, Math.round((Number(dpr) || 1) * 100) / 100));
    const stale = this.running && !this.panelSeen && wanted !== this.launchDpr;
    this.panelSeen = true;
    if (!stale) return false;
    this.log(`restarting the browser at the panel's scale factor ${wanted} (was ${this.launchDpr})`);
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
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  // ---------- Tabs ----------

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
          // This event only comes when the address changes, and the title it carries is the placeholder from before
          // loading; the real title is reported by the helper inside the page.
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
          // A cross-site navigation switches to another renderer process and the helper's channel is sometimes not
          // carried over, so add it again here (adding it twice is harmless).
          this.#send(tab, 'Runtime.addBinding', { name: HELPER_BINDING, executionContextName: HELPER_WORLD }).catch(() => {});
          // A background tab is moving by itself (most likely the agent is working in it): light its dot, do not
          // take over the picture.
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
      // A new tab that pops up right after the user clicked on the page was opened by that click
      // (a target=_blank link, a popup window).
      const openedByClick = (info.openerId && info.openerId === this.activeId) || Date.now() - this.#lastUserClick < 1500;
      const userAsked = this.#pendingActivate.delete(id) || this.#pendingActivate.delete('next');
      if (!this.activeId || userAsked || (openedByClick && !this.#restoring)) {
        await this.selectTab(id);
      } else if (!this.#restoring) {
        // A new tab the user did not open was opened by the agent: follow it if the user is not clicking or typing
        // right now, otherwise just light its dot.
        if (Date.now() - this.#lastUserInput > USER_BUSY_MS) await this.selectTab(id);
        else tab.busy = true;
      }
      this.#changed();
      if (this.#firstTab) {
        this.#firstTab();
        this.#firstTab = null;
      }
    } catch (error) {
      this.log(`failed to attach to a tab: ${error.message}`);
    } finally {
      this.#attaching.delete(id);
    }
  }

  async #setupTab(tab) {
    await this.#send(tab, 'Page.enable');
    // Without Runtime enabled, the helper's messages never arrive. Add the channel first and install the helper
    // after it, so the helper can report as soon as it runs.
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
      // the page is changing; a navigation event will fill this in
    }
    // The page may have finished loading long before the tab was attached, so no load-finished event will come;
    // read the title once here.
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

  // ---------- Navigation ----------

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

  // The fallback for pages where the helper cannot report (an error page, for example).
  async #refreshTitle(tab) {
    try {
      const result = await this.#send(tab, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      const title = result.result?.value;
      if (typeof title === 'string' && title && title !== tab.title) {
        tab.title = title.slice(0, 300);
        this.#changed();
      }
    } catch {
      // the page is changing
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
        // the tab has just closed
      }
    }, 120);
  }

  // ---------- Picture ----------

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
        // it does not matter if this cannot be saved; the default is used next time
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

  // Only the page's width and height are changed; the scale factor is not emulated (deviceScaleFactor: 0).
  // The scale factor is fixed on the command line at start (--force-device-scale-factor), so the whole
  // browser natively has that ratio.
  // Earlier the scale factor was emulated here as well, and mouse coordinates were right at some times and
  // wrong at others: a click at (300,300) reached the page as (200,200), and every viewport change could flip
  // it again. Page.captureScreenshot was used at the same time to fetch a sharp picture, and when the emulated
  // scale factor differs from the real one it temporarily changes the emulation settings and restores them,
  // so the two most likely collided. It was never worked out which of the two was at fault; both were dropped,
  // and now Chrome holds no emulation state that has to be restored back and forth.
  // If the panel later moves to a screen with a different scale factor, the panel scales the picture, and the
  // browser catches up at its next start.
  async #applyViewport(tab) {
    const { width, height } = this.viewport;
    await this.#send(tab, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false }).catch(() => {});
  }

  // The picture is produced only while a panel is open; it stops when nobody is watching, to save CPU.
  async setCasting(on) {
    this.#casting = on;
    // Titles normally come from the helper inside the page; while a panel is watching they are also checked on
    // a timer, so a page where the helper is not installed does not stay stuck on an old title.
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

  // Start the screencast (or restart it with new settings). Without format, the format asked for last time is kept.
  // At the very moment a page navigates, Chrome refuses (Not attached to an active page), so keep trying
  // after a failure.
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

  // While the picture is moving a lossy format is used (fast). After 0.4 seconds of stillness the screencast is
  // switched to a lossless format; Chrome sends one frame right away when it restarts, and the text becomes sharp.
  // Occasional changes in lossless mode (a cursor blink, one typed character) are still sent lossless; frames
  // arriving in quick succession mean motion again, so switch back to lossy.
  //
  // Page.captureScreenshot is not used for the sharp picture: when it finishes it restores the viewport to what
  // it was when it began, which collides with the panel resizing, and the new size is wiped out (reproduced
  // every time): the page does not reflow and the picture is squashed.
  #onFrame(tab, params) {
    this.#send(tab, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    if (tab.id !== this.activeId || !this.#casting) return;
    this.emit('frame', Buffer.from(params.data, 'base64'));
    const now = Date.now();
    const moving = now - tab.lastFrameAt < MOTION_GAP_MS;
    tab.lastFrameAt = now;
    clearTimeout(tab.sharpTimer);
    if (tab.castFormat === 'png') {
      // Right after switching, Chrome may send two frames in a row; that does not count as motion, otherwise it
      // would flip back and forth between the two formats.
      if (moving && now - tab.formatSince > 300) this.#startCast(tab, 'jpeg');
    } else {
      tab.sharpTimer = setTimeout(() => this.#startCast(tab, 'png'), SHARPEN_AFTER_MS);
    }
    this.#checkViewport(tab, params.metadata);
  }

  // A frame carries the page's actual size at that moment. If it does not match what the panel asked for
  // (for example a tool on the agent's side changed the viewport), set it again.
  #checkViewport(tab, metadata) {
    if (!metadata) return;
    const { width, height } = this.viewport;
    const matches = Math.abs(metadata.deviceWidth - width) <= 1 && Math.abs(metadata.deviceHeight - height) <= 1;
    const now = Date.now();
    if (matches) {
      tab.mismatchSince = 0;
    } else if (!tab.mismatchSince) {
      tab.mismatchSince = now; // maybe the resize command is still on its way; wait a little
    } else if (now - tab.mismatchSince > 700 && now - tab.viewportFixedAt > 2000) {
      tab.viewportFixedAt = now;
      this.#applyViewport(tab);
    }
  }

  // A still page with no new frames never reaches the check above; after a resize or a switch to another tab,
  // check once actively.
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
      else this.log(`could not set the page size: wanted ${width}x${height}, got ${actualWidth}x${actualHeight}`);
    } catch {
      // the page is changing
    }
  }

  // ---------- Input ----------

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

  // Text committed by an IME, the emoji panel and the like: not sent as key presses but inserted directly
  // as a piece of text.
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

  // Paste: put the text into this browser's own clipboard first, then press Ctrl+V once.
  // The page then receives a real paste, which is what makes rich-text editors handle paragraphs properly;
  // if that fails, fall back to inserting the text.
  async paste(input, tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.dialog || typeof input !== 'string' || !input) return 'none';
    // Line breaks in the Windows clipboard are \r\n; pasted as is into a rich-text box they produce extra blank lines.
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
        // the page does not allow clipboard access; continue below
      }
    }
    await this.#send(tab, 'Input.insertText', { text }).catch(() => {});
    return 'insert';
  }

  // Called after Ctrl+C / Ctrl+X in the panel: read this browser's clipboard and hand it to the panel,
  // which writes it to the system clipboard.
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

  // ---------- Reading pages (for extensions that check results; read-only) ----------

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

  // ---------- Internals ----------

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
      this.log('failed to save the tab list: ' + error.message);
    }
  }
}
