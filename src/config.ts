import { readFileSync, writeFileSync, renameSync, existsSync, rmSync, mkdirSync } from "node:fs";

// 配置模板通过 import attribute（type: "file"）embed 进二进制：
// 开发时为相对路径 "../config.example.json"，编译后为内部路径 "$bunfs/config.example.json"。
// 运行时 readFileSync 都能正确读取（Bun 对 embed 文件兼容 node fs）。
import exampleConfigPath from "../config.example.json" with { type: "file" };
import { logger } from "./logger";
import { getBasePath, getConfigPath } from "./paths";
import type { Config } from "./types";

export function readConfig(): Config {
  const raw = readFileSync(getConfigPath(), "utf-8");
  return JSON.parse(raw) as Config;
}

export function validateConfig(config: Config): void {
  if (!config.upstreams || config.upstreams.length === 0) {
    throw new Error("配置中至少需要一个上游服务");
  }

  const upstreamIds = new Set(config.upstreams.map((u) => u.id));

  for (const rule of config.rules) {
    if (!upstreamIds.has(rule.upstreamId)) {
      throw new Error(`规则「${rule.name}」引用了不存在的上游服务「${rule.upstreamId}」`);
    }
  }

  const hasDefault = config.rules.some((r) => r.condition === "default");
  if (!hasDefault) {
    throw new Error("配置中至少需要一条 condition 为 'default' 的规则");
  }
}

// Module-level write lock to serialize concurrent config mutations
let writeLock: Promise<void> = Promise.resolve();

export async function updateConfig(transform: (config: Config) => Config): Promise<Config> {
  const previousLock = writeLock;
  let releaseLock: () => void;
  writeLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    const config = readConfig();
    const newConfig = transform(config);
    validateConfig(newConfig);
    const configPath = getConfigPath();
    const tmpPath = configPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmpPath, configPath);
    logger.info("配置已更新");
    return newConfig;
  } catch (err) {
    logger.error("配置写入失败", { error: err instanceof Error ? err.message : String(err) });
    try {
      rmSync(getConfigPath() + ".tmp", { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  } finally {
    releaseLock!();
  }
}

export function initConfig(): boolean {
  const basePath = getBasePath();
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    return false;
  }

  mkdirSync(basePath, { recursive: true, mode: 0o700 });
  // exampleConfigPath: embed 后从 $bunfs 读取模板内容，复制到用户配置目录。
  // TS 因 resolveJsonModule 把它推断成 JSON 对象，但 import attribute type:"file"
  // 在运行时返回的是文件路径字符串，这里 cast 回 string。
  const content = readFileSync(exampleConfigPath as unknown as string, "utf-8");
  writeFileSync(configPath, content, { mode: 0o600 });
  return true;
}
