import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
  outExtensions: () => ({ js: ".js" }),
});
