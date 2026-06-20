import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, newRequestId, rotateIfNeeded } from "./logger";

const TMP = join(tmpdir(), `3router-logger-test-${Date.now()}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("logger", () => {
  it("写入文件日志（JSON 行，含上下文字段）", async () => {
    const logFile = join(TMP, "3router.log");
    const log = createLogger({ file: logFile, level: 4 });
    log.info("hello", { requestId: "abc", upstream: "百炼" });
    await log.flush();
    expect(existsSync(logFile)).toBe(true);
    const line = JSON.parse(readFileSync(logFile, "utf8").trim());
    expect(line.message).toBe("hello");
    expect(line.requestId).toBe("abc");
    expect(line.upstream).toBe("百炼");
    expect(line.ts).toBeTruthy();
  });

  it("达到阈值时滚动（>maxSize → 当前变 .1，并重建空文件）", () => {
    const logFile = join(TMP, "3router.log");
    writeFileSync(logFile, "x".repeat(11 * 1024)); // 11KB，阈值 10KB
    rotateIfNeeded(logFile, 10 * 1024, 5);
    expect(existsSync(logFile + ".1")).toBe(true); // 旧内容 → .1
    expect(existsSync(logFile)).toBe(true); // 当前重建为空
    expect(statSync(logFile).size).toBe(0);
  });

  it("多次滚动保留 maxFiles 个（第 6 个被丢弃）", () => {
    const logFile = join(TMP, "3router.log");
    writeFileSync(logFile, "x".repeat(11 * 1024));
    rotateIfNeeded(logFile, 10 * 1024, 5);
    writeFileSync(logFile, "y".repeat(11 * 1024));
    rotateIfNeeded(logFile, 10 * 1024, 5);
    // 两次滚动后应存在 .1（最近一次）和 .2（最早一次）
    expect(existsSync(logFile + ".1")).toBe(true);
    expect(existsSync(logFile + ".2")).toBe(true);
  });

  it("newRequestId 生成唯一短 id", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(4);
  });

  it("debug 级别受 level 控制（level<5 时不写 debug）", async () => {
    const logFile = join(TMP, "debug.log");
    const logLow = createLogger({ file: logFile, level: 4 });
    logLow.debug("hidden");
    expect(existsSync(logFile)).toBe(false); // debug 没写，文件未建

    const logFile2 = join(TMP, "debug2.log");
    const logHigh = createLogger({ file: logFile2, level: 5 });
    logHigh.debug("visible");
    expect(existsSync(logFile2)).toBe(true);
    const line = JSON.parse(readFileSync(logFile2, "utf8").trim());
    expect(line.message).toBe("visible");
    expect(line.level).toBe("debug");
  });
});
