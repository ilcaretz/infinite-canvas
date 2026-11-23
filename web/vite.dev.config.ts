import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// `npm run dev`: Vite on 5173, /api proxied to the Board server (default http://127.0.0.1:5180).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const api = env.BOARD_API ?? 'http://127.0.0.1:5180';

export default mergeConfig(
  base,
  defineConfig({
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: api, changeOrigin: false } },
    },
  }),
);
