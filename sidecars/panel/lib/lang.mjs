// 界面语言：中文或英文。
//
// 谁说了算，按先后：
//   1. 指定的：环境变量 WORKBENCH_LANG（zh / en），或者某个附加功能声明自己只有一种语言；
//   2. 面板报上来的：面板看得到 Antigravity 自己在用哪种语言（见 web/app.js 的「语言」一节）；
//   3. 这台机器的系统语言（还没有面板连上来的时候，比如 agent 先叫醒了浏览器）。
// 中文（含繁体）用中文，其余一律英文。
//
// tools/、mcp/、scripts/ 里的小命令也用这个文件。它们没有面板可问，只有 1 和 3。

const known = (lang) => (lang === 'zh' || lang === 'en' ? lang : '');

// 把语言标记（zh-CN、zh_TW.UTF-8、en-GB、ja……）归到两种里的一种；认不出来返回空。
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

// 附加功能只有一种语言时用：面板和后台都按它来。环境变量指定过的不改。
export function forceLanguage(lang) {
  if (!forced) forced = known(lang);
}

// 面板定下来的语言。不认识的值不理。
export function reportLanguage(lang) {
  reported = known(lang) || reported;
}

// 一句话两种说法，按当前语言取一种。每次用的时候现取，所以面板后来报了别的语言也跟得上。
export const say = (zh, en) => (language() === 'zh' ? zh : en);
