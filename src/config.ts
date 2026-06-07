import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
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
    throw new Error("Config must have at least one upstream");
  }

  const upstreamIds = new Set(config.upstreams.map((u) => u.id));

  for (const rule of config.rules) {
    if (!upstreamIds.has(rule.upstreamId)) {
      throw new Error(`Rule "${rule.name}" references nonexistent upstream "${rule.upstreamId}"`);
    }
  }

  const hasDefault = config.rules.some((r) => r.condition === "default");
  if (!hasDefault) {
    throw new Error("Config must have at least one rule with condition 'default'");
  }
}

export function saveConfig(config: Config): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

export function initConfig(): boolean {
  if (existsSync(getConfigPath())) {
    return false;
  }
  copyFileSync(getExamplePath(), getConfigPath());
  return true;
}
