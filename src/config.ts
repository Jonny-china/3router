import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./types";

export function getConfigPath(): string {
  return join(process.cwd(), "config.json");
}

function getExamplePath(): string {
  return join(process.cwd(), "config.example.json");
}

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

export async function updateConfig(
  transform: (config: Config) => Config,
): Promise<Config> {
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
    writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2) + "\n");
    renameSync(tmpPath, configPath);
    return newConfig;
  } catch (err) {
    // Clean up temp file on failure
    try { rmSync(getConfigPath() + ".tmp", { force: true }); } catch { /* best effort */ }
    throw err;
  } finally {
    releaseLock!();
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await updateConfig(() => config);
}

export function initConfig(): boolean {
  if (existsSync(getConfigPath())) {
    return false;
  }
  copyFileSync(getExamplePath(), getConfigPath());
  return true;
}
