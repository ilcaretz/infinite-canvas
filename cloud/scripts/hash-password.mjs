// Prints a USERS entry:  node scripts/hash-password.mjs <name> [iterations]   (password is read from stdin, never argv)
//   echo -n "my password" | node scripts/hash-password.mjs alice
// Add the printed entry to the USERS secret (comma separated):  npx wrangler secret put USERS
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const name = (process.argv[2] ?? '').trim().toLowerCase();
const iterations = Number(process.argv[3] ?? 50000);
if (!/^[a-z0-9._-]{1,32}$/.test(name)) {
  console.error('usage: <name: a-z 0-9 . _ - (max 32)> [iterations]  (password on stdin)');
  process.exit(2);
}
if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 100000) {
  console.error('iterations must be 1000..100000 (Workers Web Crypto caps PBKDF2 at 100000)');
  process.exit(2);
}
let pw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) pw += chunk;
pw = pw.replace(/\r?\n$/, '');
if (!pw) {
  console.error('empty password on stdin');
  process.exit(2);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, iterations, 32, 'sha256');
console.log(`${name}:pbkdf2$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`);
