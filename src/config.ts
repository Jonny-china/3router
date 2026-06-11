import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import type { Config } from "./types";

/**
 * Returns the base directory for 3router configuration.
 * Override with THREEROUTER_HOME env var for testing.
 */
export function getBasePath(): string {
  return process.env.THREEROUTER_HOME || join(homedir(), ".3router");
}

export function getConfigPath(): string {
  return join(getBasePath(), "config.json");
}

function getExamplePath(): string {
  // Resolved relative to this file: src/config.ts → package root
  return join(dirname(import.meta.dir), "config.example.json");
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
  const basePath = getBasePath();
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    return false;
  }

  mkdirSync(basePath, { recursive: true });

  const examplePath = getExamplePath();
  if (!existsSync(examplePath)) {
    throw new Error(`找不到配置模板文件: ${examplePath}`);
  }
  copyFileSync(examplePath, configPath);
  return true;
}
