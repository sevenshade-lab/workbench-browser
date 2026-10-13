// Installs this project into Antigravity's plugin folder, replacing the copy that is there. Only the parts
// that make up the plugin are copied; tests and scripts are not.
// If private/plugin/ exists (extensions used only on your own machine and not published), it is laid on top.
//
//   node scripts/install.mjs            only says what it would do; changes nothing
//   node scripts/install.mjs --apply    really installs: backs up the old copy in full, replaces the files,
//                                       then restarts the plugin
//
// Replacing the files and restarting the plugin have to happen together: while the old backend is still
// running and the folder already holds the new files, it cannot find its own pages.
// Its messages follow the system language (Chinese or English); WORKBENCH_LANG overrides it.
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
const backup = join(root, 'backups', stamp);
const note = (text) => console.log((apply ? '' : say('[预演] ', '[dry run] ')) + text);

if (!existsSync(join(root, 'plugin.json'))) {
  console.error(say('没找到 plugin.json，脚本要在项目里运行。', 'plugin.json was not found. Run this script from inside the project.'));
  process.exit(1);
}

// Only a copy that was not installed from this project is backed up: this project's copy always contains
// lib/browser.mjs, and its source is all here, so there is no need to keep another copy.
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

// Empty the folder without insisting on removing the folder itself: while the old backend is still running
// it holds its own folder, and Windows does not allow deleting it.
function emptyDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      emptyDir(path);
      try {
        rmdirSync(path);
      } catch {
        // held by a process: leave the empty folder, the new files are copied into it below
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
  // The entry for the agent's browser tools: the configuration needs an absolute path. The backend also writes
  // this file by itself at start; it is written here first so that Antigravity reads the right one as soon as
  // it restarts the plugin.
  writeFileSync(join(target, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'workbench-browser': { command: 'node', args: [join(target, 'mcp', 'launch.mjs')] },
    },
  }, null, 2), 'utf8');
}

// Which process is the plugin backend right now (the backend writes it to endpoint.json at start).
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

// agy only flips a switch in the configuration, and Antigravity notices a few seconds later. Disable followed
// immediately by enable goes unnoticed, and the backend is still the same old process.
// So wait until the old backend has really exited before enabling, then wait until the new backend is really up.
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
