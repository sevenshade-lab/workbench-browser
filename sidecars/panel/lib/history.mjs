// Visited pages: the source of "Most visited" and "Recent" on the new-tab page.
// Kept only in the data folder on this machine, next to the browser profile; never sent anywhere.
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_PAGES = 400;
const MAX_ICON_BYTES = 60 * 1024;
// A page that settles again within half a minute (a reload, in-page navigation back and forth) is not counted twice.
const REVISIT_MS = 30 * 1000;

const originOf = (url) => {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
};

export class History {
  #file;
  #timer = null;
  #iconMisses = new Set();

  constructor(file) {
    this.#file = file;
    this.data = { pages: {}, icons: {} };
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved && typeof saved.pages === 'object' && typeof saved.icons === 'object') this.data = saved;
    } catch {
      // First use, or the file is damaged: start empty
    }
  }

  // Returns the site this page belongs to; pages that are not http/https are not recorded and return an empty value.
  record({ url, title }, now = Date.now()) {
    const origin = originOf(url);
    if (!origin) return '';
    const page = this.data.pages[url] || { title: '', visits: 0, last: 0 };
    if (now - page.last > REVISIT_MS) page.visits += 1;
    page.last = now;
    if (title) page.title = String(title).slice(0, 200);
    this.data.pages[url] = page;
    const urls = Object.keys(this.data.pages);
    if (urls.length > MAX_PAGES) {
      urls.sort((a, b) => this.data.pages[a].last - this.data.pages[b].last);
      for (const old of urls.slice(0, urls.length - MAX_PAGES)) delete this.data.pages[old];
    }
    this.#saveSoon();
    return origin;
  }

  needsIcon(origin) {
    return !!origin && !this.data.icons[origin] && !this.#iconMisses.has(origin);
  }

  // If the icon cannot be fetched, do not try again during this run; try again after the next start,
  // so that an icon that cannot be fetched is not requested on every page load.
  async fetchIcon(origin, href) {
    if (!this.needsIcon(origin)) return;
    this.#iconMisses.add(origin);
    try {
      const iconUrl = new URL(href || '/favicon.ico', origin);
      if (!/^https?:$/.test(iconUrl.protocol)) return;
      const response = await fetch(iconUrl, { signal: AbortSignal.timeout(5000) });
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !type.startsWith('image/')) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_ICON_BYTES) return;
      this.data.icons[origin] = `data:${type};base64,${bytes.toString('base64')}`;
      this.#saveSoon();
    } catch {
      // No icon: the default globe is used
    }
  }

  // Most visited: merged by site, with the most visited page of each site as its entry. Recent: by page, newest first.
  summary() {
    const sites = new Map();
    const pages = Object.entries(this.data.pages).map(([url, page]) => ({ url, ...page }));
    for (const page of pages) {
      const origin = originOf(page.url);
      const site = sites.get(origin) || { origin, visits: 0, last: 0, top: page };
      site.visits += page.visits;
      site.last = Math.max(site.last, page.last);
      if (page.visits > site.top.visits) site.top = page;
      sites.set(origin, site);
    }
    const icon = (url) => this.data.icons[originOf(url)] || '';
    return {
      sites: [...sites.values()]
        .sort((a, b) => b.visits - a.visits || b.last - a.last)
        .slice(0, 8)
        .map((site) => ({ url: site.top.url, title: site.top.title, host: new URL(site.origin).host, icon: icon(site.origin) })),
      recent: pages
        .sort((a, b) => b.last - a.last)
        .slice(0, 30)
        .map((page) => ({ url: page.url, title: page.title, host: new URL(page.url).host, last: page.last, icon: icon(page.url) })),
    };
  }

  clear() {
    this.data = { pages: {}, icons: {} };
    this.#iconMisses.clear();
    this.#save();
  }

  #saveSoon() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.#save(), 1000);
    this.#timer.unref();
  }

  #save() {
    clearTimeout(this.#timer);
    this.#timer = null;
    try {
      writeFileSync(this.#file, JSON.stringify(this.data), 'utf8');
    } catch {
      // Failing to save does not affect browsing
    }
  }
}
