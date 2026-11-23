// `npm run dev` at the app root: server (tsx watch) + Vite dev server with /api proxied to it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = process.env.PORT;
const envFile = path.join(root, '.env');
if (!port && fs.existsSync(envFile)) {
  const m = /^\s*PORT\s*=\s*"?(\d+)"?/m.exec(fs.readFileSync(envFile, 'utf8'));
  if (m) port = m[1];
}
port = port || '5180';

const env = { ...process.env, PORT: port, BOARD_API: `http://127.0.0.1:${port}` };
const procs = [
  spawn('npm', ['run', 'dev'], { cwd: path.join(root, 'server'), env, stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'dev'], { cwd: path.join(root, 'web'), env, stdio: 'inherit', shell: true }),
];
console.log(`Dev mode: open http://localhost:5173  (API server on ${port})`);
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (c) => { stop(); process.exit(c ?? 0); }));
