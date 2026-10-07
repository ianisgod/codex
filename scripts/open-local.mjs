#!/usr/bin/env node
/** Starts the local production application and opens the user's default browser. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 3001);
const address = `http://127.0.0.1:${port}`;
let server;
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('GENESIS needs Node.js 24 or later. Install it, then run npm run open again.');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be a whole number from 1 to 65535.');
  process.exit(1);
}

async function npm(args) {
  const command = process.env.npm_execpath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
  await new Promise((resolve, reject) => {
    const task = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', shell: !process.env.npm_execpath && process.platform === 'win32', env: { ...process.env, NPM_CONFIG_CACHE: join(root, '.local', 'npm-cache') } });
    task.once('error', reject);
    task.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} failed (${code}).`)));
  });
}

async function ready() {
  try {
    const health = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(1500) });
    const data = await health.json();
    if (!health.ok || data.status !== 'ok' || data.persistence !== 'sqlite') return false;
    const page = await fetch(address, { signal: AbortSignal.timeout(1500) });
    return page.ok && (await page.text()).includes('<title>GENESIS');
  } catch { return false; }
}

async function openBrowser() {
  if (process.env.GENESIS_NO_BROWSER === '1') return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `start "" "${address}"`] : [address];
  await new Promise((resolve, reject) => {
    const opener = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    opener.once('error', reject);
    opener.once('exit', code => code === 0 ? resolve() : reject(new Error(`Browser opener exited with code ${code}.`)));
  }).catch(() => console.log(`Automatic browser opening is unavailable. Open ${address} in your browser.`));
}

try {
  if (!(await ready())) {
    if (!existsSync(join(root, 'node_modules', 'tsx', 'package.json'))) {
      console.log('Installing the locked dependencies…');
      await npm(['ci', '--no-audit', '--no-fund']);
    }
    if (!existsSync(join(root, 'dist', 'index.html'))) {
      console.log('Building GENESIS…');
      await npm(['run', 'build']);
    }
    server = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', join(root, 'server', 'index.ts')], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' } });
    let exited = false;
    server.once('exit', () => { exited = true; });
    server.once('error', error => { exited = true; console.error(error.message); });
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (exited) throw new Error('The local server could not start. Check the error above; another application may be using this port.');
      if (await ready()) { healthy = true; break; }
      await delay(250);
    }
    if (!healthy) throw new Error('GENESIS did not become ready within the startup window.');
  }
  console.log('GENESIS is ready. Opening your browser…');
  await openBrowser();
  if (server) console.log('Keep this terminal open while playing. Press Ctrl+C to stop.');
} catch (error) {
  console.error(error.message);
  server?.kill('SIGTERM');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (!server || server.exitCode !== null) process.exit(0);
  server.once('exit', () => process.exit(0));
  server.kill('SIGTERM');
});
