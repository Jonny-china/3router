#!/usr/bin/env bun
/**
 * bun build --compile 多平台编译脚本（方案 B 分发）。
 *
 * 用法：
 *   bun run build:compile                              # 编当前平台（dev 验证）
 *   bun run build:compile -- --target=bun-darwin-arm64  # 编指定平台（CI 矩阵用）
 *
 * 产出 packages/<platform>/3router[.exe]，由对应平台子包发布到 npm。
 *
 * embed 策略：
 *   - config.example.json：通过 src/config.ts 的 import attribute（type: "file"）自动 embed
 *   - dist-web/index.html：作为 entrypoints embed（前端已单文件化，JS/CSS inline）
 *     运行时 server.ts 用 embeddedFiles 读取
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface Platform {
  target: string;
  dir: string;
  bin: string;
}

const PLATFORMS: Platform[] = [
  { target: "bun-darwin-arm64", dir: "darwin-arm64", bin: "3router" },
  { target: "bun-darwin-x64", dir: "darwin-x64", bin: "3router" },
  { target: "bun-linux-x64", dir: "linux-x64", bin: "3router" },
  { target: "bun-linux-arm64", dir: "linux-arm64", bin: "3router" },
  { target: "bun-windows-x64", dir: "win32-x64", bin: "3router.exe" },
];

function currentTarget(): string {
  const map: Record<string, string> = {
    "darwin-arm64": "bun-darwin-arm64",
    "darwin-x64": "bun-darwin-x64",
    "linux-x64": "bun-linux-x64",
    "linux-arm64": "bun-linux-arm64",
    "win32-x64": "bun-windows-x64",
  };
  const key = `${process.platform}-${process.arch}`;
  const target = map[key];
  if (!target) throw new Error(`当前平台不支持: ${key}`);
  return target;
}

const argTarget = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
if (argTarget && !PLATFORMS.some((p) => p.target === argTarget)) {
  throw new Error(
    `未知 --target: ${argTarget}\n可选: ${PLATFORMS.map((p) => p.target).join(", ")}`,
  );
}

const targets = argTarget
  ? PLATFORMS.filter((p) => p.target === argTarget)
  : PLATFORMS.filter((p) => p.target === currentTarget());

// embed 单文件化后的前端 index.html（若未构建则仅编 API 二进制）
const entrypoints: string[] = ["src/cli.ts"];
if (existsSync("dist-web/index.html")) {
  entrypoints.push("dist-web/index.html");
} else {
  console.warn("⚠ dist-web/index.html 不存在，二进制不含 Web 管理面板（仅 API 代理）");
  console.warn("  先运行: pnpm build:web && pnpm build:copy-web");
}

let failed = false;
for (const p of targets) {
  const outDir = join("packages", p.dir);
  const outfile = join(outDir, p.bin);
  mkdirSync(outDir, { recursive: true });

  const result = await Bun.build({
    entrypoints,
    compile: { outfile, target: p.target, minify: true, sourcemap: "external" },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    console.error(`✗ 编译失败: ${p.target}`);
    failed = true;
    continue;
  }

  // Unix 二进制需可执行位（Windows 不需要）
  if (!p.bin.endsWith(".exe")) {
    chmodSync(outfile, 0o755);
  }

  const sizeMB = (Bun.file(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`✓ ${p.target} → ${outfile} (${sizeMB} MB)`);
}

if (failed) process.exit(1);
