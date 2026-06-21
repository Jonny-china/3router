import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { consola } from "consola";

import { getLogsDir } from "./paths";

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 5;

// 控制台镜像：保留 consola 的彩色/标签输出（dev 友好），用类型安全映射替代字符串索引 cast。
const consoleMirror: Record<"info" | "warn" | "error" | "debug", (msg: string) => void> = {
  info: (msg) => consola.info(msg),
  warn: (msg) => consola.warn(msg),
  error: (msg) => consola.error(msg),
  debug: (msg) => consola.debug(msg),
};

/**
 * 文件超过 maxSize 时滚动：当前 → .1，.1 → .2，…，超 maxFiles 的丢弃。
 * 滚动后重建空当前文件。
 */
export function rotateIfNeeded(file: string, maxSize: number, maxFiles: number): void {
  if (!existsSync(file) || statSync(file).size < maxSize) return;
  for (let i = maxFiles - 1; i >= 1; i--) {
    const cur = `${file}.${i}`;
    const next = `${file}.${i + 1}`;
    if (i + 1 > maxFiles) continue; // 超上限的旧文件直接丢弃
    if (existsSync(cur)) renameSync(cur, next);
  }
  renameSync(file, `${file}.1`);
  writeFileSync(file, ""); // 重建空当前文件，便于后续追加
}

/** 生成短随机请求 id，用于串联同一请求的事件链 */
export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface Logger {
  info: (msg: string, obj?: Record<string, unknown>) => void;
  warn: (msg: string, obj?: Record<string, unknown>) => void;
  error: (msg: string, obj?: Record<string, unknown>) => void;
  debug: (msg: string, obj?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
}

export interface LoggerOptions {
  file: string;
  level?: number; // 0=fatal 1=error 2=warn 3=log 4=info 5=debug 6=trace
  maxSize?: number;
  maxFiles?: number;
}

export function createLogger(opts: LoggerOptions): Logger {
  const { file, level = 4, maxSize = DEFAULT_MAX_SIZE, maxFiles = DEFAULT_MAX_FILES } = opts;
  let dirEnsured = false;

  const write = (
    lvl: "info" | "warn" | "error" | "debug",
    msg: string,
    obj?: Record<string, unknown>,
  ): void => {
    if (!dirEnsured) {
      mkdirSync(dirname(file), { recursive: true });
      dirEnsured = true;
    }
    rotateIfNeeded(file, maxSize, maxFiles);
    const line =
      JSON.stringify({ ts: new Date().toISOString(), level: lvl, message: msg, ...obj }) + "\n";
    appendFileSync(file, line);
    // 同时输出控制台（dev 友好）；类型安全映射替代脆弱的字符串索引 cast。
    consoleMirror[lvl](msg);
  };

  return {
    info: (m, o) => write("info", m, o),
    warn: (m, o) => write("warn", m, o),
    error: (m, o) => write("error", m, o),
    debug: (m, o) => {
      if (level >= 5) write("debug", m, o);
    },
    flush: async () => {},
  };
}

// 进程级单例 logger（读 LOG_LEVEL 环境变量，默认 info）
const globalLogger = createLogger({
  file: `${getLogsDir()}/3router.log`,
  level: Number(process.env.LOG_LEVEL ?? 4),
});
export const logger: Logger = globalLogger;
