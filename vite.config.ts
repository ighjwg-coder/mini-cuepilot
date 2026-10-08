import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 서버와 같은 .env 의 PORT 를 프록시 대상으로 사용
if (existsSync('.env')) process.loadEnvFile('.env');

const apiPort = Number(process.env.PORT ?? 3000);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
});
