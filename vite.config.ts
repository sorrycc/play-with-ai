/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// @ts-expect-error plain .mjs module shared with the standalone server
import { createApi } from './server/api.mjs';

/** Mounts the API proxy inside the dev server, so `npm run dev` is the only process. */
function apiProxy(env: Record<string, string>): Plugin {
  return {
    name: 'play-with-ai-api',
    configureServer(server) {
      const api = createApi(env);
      server.middlewares.use(async (req, res, next) => {
        if (!(await api(req, res))) next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // '' prefix: load every key from .env. They stay in this process; nothing here reaches the bundle.
  plugins: [react(), tailwindcss(), apiProxy(loadEnv(mode, process.cwd(), ''))],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
}));
