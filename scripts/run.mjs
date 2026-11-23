// Used by start.bat: install dependencies if missing, build when sources are newer than the build,
// start the server, open the browser once it answers. No shell string building: paths with spaces are safe.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const server = path.join(root, 'server');

function readPort() {
  let port = process.env.PORT;
  const envFile = path.join(root, '.env');
  if (!port && fs.existsSync(envFile)) {
    const m = /^\s*PORT\s*=\s*"?(\d+)"?/m.exec(fs.readFileSync(envFile, 'utf8'));
    if (m) port = m[1];
  }
  return Number(port || 5180);
}
const port = readPort();
const url = `http://localhost:${port}`;

function npm(args, cwd) {
  const r = spawnSync('npm', args, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`\n"npm ${args.join(' ')}" failed in ${cwd}`);
    process.exit(r.status ?? 1);
  }
}

function newestMtime(entries) {
  let newest = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (path.basename(p) === 'node_modules') return;
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    } else newest = Math.max(newest, st.mtimeMs);
  };
  entries.forEach(walk);
  return newest;
}

function stale(outFile, sources) {
  if (!fs.existsSync(outFile)) return true;
  return newestMtime(sources) > fs.statSync(outFile).mtimeMs;
}

async function healthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  if (process.env.NO_OPEN) return; // used by automated checks
  spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node 22 or newer is required (found ${process.versions.node}). Install: winget install OpenJS.NodeJS.LTS`);
  process.exit(1);
}

if (await healthy()) {
  console.log(`Board is already running on ${url}. Opening it.`);
  openBrowser();
  process.exit(0);
}

if (!fs.existsSync(path.join(web, 'node_modules'))) {
  console.log('First run: installing web dependencies...');
  npm(['install'], web);
}
if (!fs.existsSync(path.join(server, 'node_modules'))) {
  console.log('First run: installing server dependencies...');
  npm(['install'], server);
}
if (stale(path.join(web, 'dist', 'index.html'), [path.join(web, 'src'), path.join(web, 'index.html'), path.join(web, 'package.json'), path.join(web, 'vite.config.ts')])) {
  console.log('Building the web app...');
  npm(['run', 'build'], web);
}
if (stale(path.join(server, 'dist', 'index.js'), [path.join(server, 'src'), path.join(server, 'package.json'), path.join(server, 'tsconfig.json')])) {
  console.log('Building the server...');
  npm(['run', 'build'], server);
}

console.log(`Starting Board on ${url} ...`);
const child = spawn(process.execPath, [path.join(server, 'dist', 'index.js')], { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());

for (let i = 0; i < 120; i++) {
  if (await healthy()) {
    openBrowser();
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
