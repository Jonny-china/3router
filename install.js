#!/usr/bin/env node

// postinstall: 校验当前平台的预编译二进制是否就位。
// optionalDependencies 应已按 os/cpu 自动装好匹配的 @3router/<platform> 子包；
// 若缺失（罕见，如平台未覆盖），给出清晰提示而非静默失败。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const pkg = `@3router/${platform}`;

try {
  require.resolve(pkg);
} catch {
  console.warn(`[3router] 警告: 未找到当前平台 (${platform}) 的预编译二进制 ${pkg}。`);
  console.warn("[3router] 3router 可能无法直接运行。");
  console.warn("[3router] 可从 GitHub Release 下载对应平台二进制: https://github.com/Jonny-china/3router/releases");
}
