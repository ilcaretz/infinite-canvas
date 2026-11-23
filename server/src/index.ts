import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const { app } = await buildApp(cfg);
if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.host) && !cfg.appPassword) {
  console.warn(`WARNING: listening on ${cfg.host} with no APP_PASSWORD - anyone who can reach this port can read and change the board.`);
}
try {
  await app.listen({ host: cfg.host, port: cfg.port });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${cfg.port} is already in use. Close the other Board window or set PORT in .env.`);
  } else console.error(e);
  process.exit(1);
}
console.log(`Board server: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}  (data: ${cfg.dataDir}, storage: ${cfg.storageDriver}${cfg.appPassword ? ', login on' : ''})`);
