// 脱离 Antigravity 单独把面板后台跑起来，开发和自测用。
// 用法：node scripts/run-standalone.mjs [端口] [--private]   然后浏览器打开 http://127.0.0.1:<端口>/?token=dev
// 想看另一种语言的界面，地址后面加 &lang=en 或 &lang=zh。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { say } from '../sidecars/panel/lib/lang.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 加 --private 把 private/ 里的附加功能也带上（有的话）。
const withPrivate = process.argv.includes('--private');
const port = process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || process.env.PORT || '4790';
const privateExtensions = join(root, 'private', 'plugin', 'sidecars', 'panel', 'extensions');
const loader = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js');
if (!existsSync(loader)) {
  console.error(say('没找到 Antigravity 的 sidecar_sdk：', 'The Antigravity sidecar_sdk was not found: ') + loader);
  process.exit(1);
}

const child = spawn(process.execPath, ['--import=' + pathToFileURL(loader).href, 'main.mjs'], {
  cwd: join(root, 'sidecars', 'panel'),
  stdio: 'inherit',
  env: {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: 'standalone',
    ANTIGRAVITY_CSRF_TOKEN: 'standalone',
    ANTIGRAVITY_SIDECAR_WEB_PORT: port,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: process.env.WORKBENCH_DEV_TOKEN || 'dev',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: process.env.WORKBENCH_DEV_DATA || join(root, '.dev-data'),
    ...(withPrivate && existsSync(privateExtensions) ? { WORKBENCH_EXTENSIONS: privateExtensions } : {}),
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
