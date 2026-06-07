import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsDir = join(__dirname, "..", "certs");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    https: {
      cert: readFileSync(join(certsDir, "cert.pem")),
      key: readFileSync(join(certsDir, "key.pem")),
    },
    proxy: {
      "/api": {
        target: "https://localhost:9191",
        changeOrigin: true,
        secure: false,
      },
      "/v1": {
        target: "https://localhost:9191",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
