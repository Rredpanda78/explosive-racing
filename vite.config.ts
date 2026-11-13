import { defineConfig } from 'vite';

// 相對路徑，讓 GitHub Pages 的子路徑 (/explosive-racing/) 也能正常載入
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        // three.js 獨立成一個檔（檔名含雜湊）：遊戲程式更新時，回訪的玩家不用重新下載這 600 KB
        codeSplitting: { groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }] },
      },
    },
  },
  server: { host: true, port: 5173 },
});
