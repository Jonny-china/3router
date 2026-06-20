import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// 单文件构建：把 JS/CSS inline 进单个 index.html，
// 便于 bun build --compile 通过 entrypoints embed 进二进制（真·单文件分发）。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:9191", changeOrigin: true },
      "/v1": { target: "http://localhost:9191", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // 单文件模式：所有资源 inline，不外置 hashed 文件
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
  },
});
