// UI language: Chinese or English.
//
// Who decides, in order:
//   1. An explicit choice: the environment variable WORKBENCH_LANG (zh / en), or an extension declaring
//      that it has only one language;
//   2. What the panel reports: the panel can see which language Antigravity itself runs in
//      (see the "Language" section in web/app.js);
//   3. The system language of this machine (before any panel has connected, for example when the agent
//      wakes the browser first).
// Chinese (Traditional included) gets Chinese; everything else gets English.
//
// The small commands under tools/, mcp/ and scripts/ use this file too. They have no panel to ask,
// so only 1 and 3 apply.

const known = (lang) => (lang === 'zh' || lang === 'en' ? lang : '');

// Maps a language tag (zh-CN, zh_TW.UTF-8, en-GB, ja, ...) to one of the two languages; returns an empty string if it cannot tell.
export function languageOf(tag) {
  const text = String(tag || '').trim().toLowerCase();
  if (/^zh(?![a-z])/.test(text)) return 'zh';
  return /^[a-z]{2,3}(?![a-z])/.test(text) ? 'en' : '';
}

let forced = languageOf(process.env.WORKBENCH_LANG);
let reported = '';
const system = languageOf(new Intl.DateTimeFormat().resolvedOptions().locale) || 'en';

export const language = () => forced || reported || system;
export const forcedLanguage = () => forced;

// For an extension that has only one language: the panel and the backend both follow it.
// A choice made through the environment variable is not overridden.
export function forceLanguage(lang) {
  if (!forced) forced = known(lang);
}

// The language the panel settled on. Unknown values are ignored.
export function reportLanguage(lang) {
  reported = known(lang) || reported;
}

// One sentence in two languages; returns the one for the current language. It is looked up at every use,
// so it follows the panel if the panel reports a different language later.
export const say = (zh, en) => (language() === 'zh' ? zh : en);
