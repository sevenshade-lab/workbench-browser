// 把这个项目装进 Antigravity 的插件目录，替换掉里面原来那一版。只拷插件本身那几样，测试和脚本不拷。
// 有 private/plugin/ 的话（只在自己机器上用、不公开的附加功能），一并叠上去。
//
//   node scripts/install.mjs            只说明会做什么，不动任何东西
//   node scripts/install.mjs --apply    真的装：先整份备份原来的，再换文件，再重启插件
//
// 换文件和重启插件必须一起做：旧后台还在跑的时候目录里已经是新文件，它会找不到自己的页面。
// 说的话跟着系统语言走（中文或英文），WORKBENCH_LANG 可以指定。
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { say } from '../sidecars/panel/lib/lang.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = ['plugin.json', 'LICENSE', 'assets', 'mcp', 'sidecars', 'skills', 'tools'];
const overlay = join(root, 'private', 'plugin');
const target = join(homedir(), '.gemini', 'config', 'plugins', 'workbench-browser');
const dataDir = join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'workbench-browser', 'panel', 'data');
const apply = process.argv.includes('--apply');
const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[-: ]/g, '').slice(0, 12);
const backup = join(root, '原版备份', stamp);
const note = (text) => console.log((apply ? '' : say('[预演] ', '[dry run] ')) + text);

if (!existsSync(join(root, 'plugin.json'))) {
  console.error(say('没找到 plugin.json，脚本要在项目里运行。', 'plugin.json was not found. Run this script from inside the project.'));
  process.exit(1);
}

// 只备份「不是这个项目装进去的」版本：本项目的版本里一定有 lib/browser.mjs，源码都在这边，不用再存一份。
const hasOld = existsSync(join(target, 'plugin.json')) && !existsSync(join(target, 'sidecars', 'panel', 'lib', 'browser.mjs'));
note(hasOld
  ? say(`备份原来的插件到 ${backup}`, `Back up the plugin that is installed now to ${backup}`)
  : say('装着的是本项目的版本（或者还没装过），不用备份', 'The installed copy came from this project (or nothing is installed yet): no backup needed'));
if (apply && hasOld) {
  mkdirSync(backup, { recursive: true });
  cpSync(target, join(backup, 'plugin'), { recursive: true });
  if (existsSync(dataDir)) {
    mkdirSync(join(backup, 'data'), { recursive: true });
    for (const name of readdirSync(dataDir)) {
      if (name.endsWith('.json')) cpSync(join(dataDir, name), join(backup, 'data', name));
    }
  }
}

// 清空目录但不强求删掉目录本身：旧后台还在跑的时候，它占着自己那个文件夹，Windows 不让删。
function emptyDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      emptyDir(path);
      try {
        rmdirSync(path);
      } catch {
        // 有进程占着，留着空目录，下面拷新文件时接着用
      }
    } else {
      rmSync(path, { force: true });
    }
  }
}

note(say(`换文件：${target}`, `Replace the files in ${target}`));
if (existsSync(overlay)) note(say(`叠上附加功能：${overlay}`, `Overlay the private extensions from ${overlay}`));
if (apply) {
  mkdirSync(target, { recursive: true });
  emptyDir(target);
  for (const part of PARTS) {
    if (existsSync(join(root, part))) cpSync(join(root, part), join(target, part), { recursive: true });
  }
  if (existsSync(overlay)) cpSync(overlay, target, { recursive: true });
  // agent 的浏览器工具入口：配置里要写绝对路径。后台启动时也会自己补这个文件，
  // 这里先写好，Antigravity 一重启插件就能读到对的。
  writeFileSync(join(target, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'workbench-browser': { command: 'node', args: [join(target, 'mcp', 'launch.mjs')] },
    },
  }, null, 2), 'utf8');
}

// 插件后台现在是哪个进程（后台启动时自己写进 endpoint.json）。
function sidecarPid() {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'endpoint.json'), 'utf8')).pid;
  } catch {
    return 0;
  }
}
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// agy 只是改配置里的开关，Antigravity 过几秒才注意到。关了马上开，它根本没察觉，后台还是旧的那个进程。
// 所以要等旧后台真的退了再开，开了之后等新后台真的起来。
note(say(
  '重启插件：agy plugin disable workbench-browser → 等旧后台退出 → enable → 等新后台起来',
  'Restart the plugin: agy plugin disable workbench-browser → wait for the old backend to exit → enable → wait for the new backend',
));
let restarted = !apply;
if (apply) {
  const oldPid = sidecarPid();
  try {
    execFileSync('agy', ['plugin', 'disable', 'workbench-browser'], { stdio: 'inherit', windowsHide: true });
    for (let i = 0; i < 40 && alive(oldPid); i++) await sleep(1000);
    execFileSync('agy', ['plugin', 'enable', 'workbench-browser'], { stdio: 'inherit', windowsHide: true });
    for (let i = 0; i < 40 && !restarted; i++) {
      await sleep(1000);
      const pid = sidecarPid();
      restarted = pid !== oldPid && alive(pid);
    }
  } catch (error) {
    console.log(say(`用命令重启插件出错：${error.message}`, `Restarting the plugin from the command line failed: ${error.message}`));
  }
}

if (!apply) {
  console.log(say('\n以上是预演，什么都没动。加 --apply 才会真的执行。', '\nThis was a dry run: nothing was changed. Add --apply to do it.'));
} else if (restarted) {
  console.log(say(
    '\n装好了，新后台已经起来。侧边栏里原来开着的面板要关掉重开一次；agent 的浏览器工具和使用说明可能要重启 Antigravity 才出现。',
    '\nInstalled, and the new backend is up. Close and reopen the panel if it was open. The agent tools and the skill may need an Antigravity restart to show up.',
  ));
} else {
  console.log(say(
    '\n文件已经换好，但没等到新后台起来。请到 Antigravity 的 Customizations → Installed 里把 workbench-browser 关掉再打开。',
    '\nThe files are in place, but the new backend did not come up in time. Turn workbench-browser off and on again under Customizations → Installed in Antigravity.',
  ));
}
