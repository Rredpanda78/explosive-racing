import { defineConfig } from 'vite';

// 相對路徑，讓 GitHub Pages 的子路徑 (/explosive-racing/) 也能正常載入
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
  server: { host: true, port: 5173 },
});
