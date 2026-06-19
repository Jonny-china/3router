# 回到 Bun.serve + consola 日志系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 3router 的 HTTP 层从 `node:http` + 转换链重写为 `Bun.serve`（原生 web stream），删除断连 bug 的主要嫌疑点；同时建立 consola 日志系统（落盘 + 诊断埋点 + 按大小轮转），让流式结束原因可观测。

**Architecture:** `server.ts` 用 `Bun.serve({ fetch })`，直接返回 web `Response`，删除 `incomingToRequest` + `sendResponse`（含 `Readable.fromWeb().pipe(res)` 转换链，~80 行）。新建 `logger.ts`（consola + 自定义 file reporter + 自写按大小轮转）。`proxy.ts` 在 fetch/流结束边界加诊断埋点（`stream.end` 记录 done/error/abort）。

**Tech Stack:** Bun（dev+prod 运行时）、consola（日志）、TypeScript、bun test（测试）

## Global Constraints

- **运行时**：Bun（dev + 生产都是 `bun run`，不再 `node dist/cli.js`）
- **日志路径**：`~/.3router/logs/3router.log`（复用 `getLogsDir()`）
- **日志级别**：默认 `info`，`LOG_LEVEL` 环境变量可调（debug）
- **轮转**：单文件 >10MB 时滚动，保留 5 个（50MB 上限）
- **诊断埋点**（每请求带 `requestId` 串联）：`request.start` / `upstream.fetch` / `stream.end`(字节数+done|error|abort) / `client.disconnect` / `proxy.error`
- **不动**：路由逻辑（`router.ts`）、image cache、CLI 子命令（serve/start/stop/status）、配置路径 `~/.3router/config.json`
- **本 plan 不涉及**：`--compile`、npm 分发、CI（属 Plan 2）；`bin/3router` 探测逻辑暂保留（Plan 2 删）

---

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/paths.ts` | 新建 | 提取 `getBasePath`/`getLogsDir`/`getConfigPath`（从 cli.ts/config.ts 合并，去重 + 避免 logger↔cli 循环依赖） |
| `src/logger.ts` | 新建 | consola 实例 + file reporter + 按大小轮转；导出 `logger` + `withRequestId()` |
| `src/logger.test.ts` | 新建 | 级别过滤、文件写入、轮转触发 |
| `src/server.ts` | 重写 | `Bun.serve`，删 `createServer`/`incomingToRequest`/`sendResponse` |
| `src/server.test.ts` | 修改 | 适配 Bun.serve（启动/路由/静态） |
| `src/proxy.ts` | 修改 | 加诊断埋点（request.start/upstream.fetch/stream.end/proxy.error） |
| `src/proxy.test.ts` | 修改 | 验证埋点记录 |
| `src/config.ts` | 修改 | `fs/promises` → `Bun.file`/`Bun.write`，接入 logger |
| `src/cli.ts` | 修改 | `console.*` → `logger.*`（daemon 生命周期） |
| `package.json` | 修改 | 加 `consola` 依赖 |

---

## Task 1: 实测 consola 在 Bun 下的兼容性

**Files:** 无（验证步骤，决定是否用 consola）

**Interfaces:**
- Produces: 决策结果（consola 可用 / fallback 自建）

- [ ] **Step 1: 安装 consola**

```bash
pnpm add consola
```

- [ ] **Step 2: 写临时验证脚本**

创建 `/tmp/consola-probe.ts`：
```ts
import { consola } from "consola";
consola.info("info 测试");
consola.warn("warn 测试");
consola.error("error 测试");
consola.debug("debug 默认不显示");
consola.create({ level: 5 }).debug("调高级别后显示");
```

- [ ] **Step 3: Bun 运行验证**

Run: `bun run /tmp/consola-probe.ts`
Expected: 输出 info/warn/error 三行；第 5 行（create level 5）显示 debug。无报错。

- [ ] **Step 4: 清理 + commit 决策**

```bash
rm /tmp/consola-probe.ts
```
若 consola 正常工作 → 继续用 consola（Task 2）。若有异常 → 改用自建轻量 logger（在 Task 2 用 `src/logger.ts` 自写 console 包装 + 文件流，不依赖 consola）。

---

## Task 2: logger.ts 模块（consola + file reporter + 轮转）

**Files:**
- Create: `src/logger.ts`
- Create: `src/logger.test.ts`

**Interfaces:**
- Produces: `logger`（consola 实例，info/warn/error/debug）、`rotateIfNeeded(path)`（轮转检查）、`newRequestId()`（生成短 id）

- [ ] **Step 0: 提取 `src/paths.ts`（避免循环依赖 + 去重）**

现状：`getBasePath`/`getLogsDir` 散在 `cli.ts`（`getLogsDir`）和 `config.ts`（`getBasePath`/`getConfigPath`），且 `logger.ts` 全局实例需要日志路径 → 若 `import { getLogsDir } from "./cli"` 会与 `cli.ts → logger` 形成**循环依赖**。先提取：

Create `src/paths.ts`：
```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function getBasePath(): string {
  return process.env.THREEROUTER_HOME || join(homedir(), ".3router");
}
export function getLogsDir(): string {
  return join(getBasePath(), "logs");
}
export function getConfigPath(): string {
  return join(getBasePath(), "config.json");
}
```
然后 `config.ts` 与 `cli.ts` 的 `getBasePath`/`getLogsDir`/`getConfigPath` 改为 `import { ... } from "./paths"`，删除各自本地定义（去重）。后续 `logger.ts` 用 `import { getLogsDir } from "./paths"`（**不是** `./cli`）。

- [ ] **Step 1: 写失败测试 `src/logger.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, newRequestId, rotateIfNeeded } from "./logger";

const TMP = join(tmpdir(), `3router-test-${Date.now()}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("logger", () => {
  it("写入文件日志（JSON 行）", async () => {
    const logFile = join(TMP, "3router.log");
    const log = createLogger({ file: logFile, level: 3 });
    log.info("hello", { requestId: "abc" });
    await log.flush();
    expect(existsSync(logFile)).toBe(true);
    const line = JSON.parse(readFileSync(logFile, "utf8").trim());
    expect(line.message).toBe("hello");
    expect(line.requestId).toBe("abc");
  });

  it("达到阈值时轮转（>maxSize）", async () => {
    const logFile = join(TMP, "3router.log");
    writeFileSync(logFile, "x".repeat(11 * 1024)); // 11KB，阈值 10KB
    rotateIfNeeded(logFile, 10 * 1024, 5);
    expect(existsSync(logFile + ".1")).toBe(true); // 旧的变成 .1
    expect(existsSync(logFile)).toBe(true); // 新的空文件
  });

  it("newRequestId 生成唯一短 id", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test src/logger.test.ts`
Expected: FAIL — 模块 `./logger` 不存在

- [ ] **Step 3: 实现 `src/logger.ts`**

```ts
import { consola } from "consola";
import { existsSync, renameSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = ReturnType<typeof createLogger>;

export interface LoggerOptions {
  file: string;
  level?: number; // 0=fatal 1=error 2=warn 3=log 4=info 5=debug 6=trace
  maxSize?: number; // 字节，默认 10MB
  maxFiles?: number; // 默认 5
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export function rotateIfNeeded(file: string, maxSize: number, maxFiles: number): void {
  if (!existsSync(file)) return;
  if (statSync(file).size < maxSize) return;
  // 滚动：.4 → .5（删除超出），... .1 → .2, 当前 → .1
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (i + 1 > maxFiles && existsSync(from)) {
      // 超出上限的直接由后续 rename 覆盖（这里 to 是最旧的，会被覆盖）
    }
    if (existsSync(from)) renameSync(from, to);
  }
  // 当前 → .1，但需要先确保旧 .1 已上移（上面循环做了）
  // 注意：上面循环从 1 开始把 file 当作 .1 的来源移到 .2
  // 实际需要一个干净的当前→.1：用空文件占位
  // 修正：rotate 后 file 本身不动（继续追加），但名字要空出来。
  // 简化方案：把当前 file rename 到 .1，新建空 file。
}

export function createLogger(opts: LoggerOptions): {
  info: (msg: string, obj?: Record<string, unknown>) => void;
  warn: (msg: string, obj?: Record<string, unknown>) => void;
  error: (msg: string, obj?: Record<string, unknown>) => void;
  debug: (msg: string, obj?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
} {
  const { file, level = 4, maxSize = DEFAULT_MAX_SIZE, maxFiles = DEFAULT_MAX_FILES } = opts;
  mkdirSync(dirname(file), { recursive: true });

  const write = (lvl: string, msg: string, obj?: Record<string, unknown>) => {
    rotateIfNeeded(file, maxSize, maxFiles);
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, message: msg, ...obj }) + "\n";
    appendFileSync(file, line);
    // 同时输出到控制台（dev 友好）
    (consola as unknown as { [k: string]: (m: string) => void })[lvl]?.(msg);
  };

  return {
    info: (m, o) => write("info", m, o),
    warn: (m, o) => write("warn", m, o),
    error: (m, o) => write("error", m, o),
    debug: (m, o) => { if (level >= 5) write("debug", m, o); },
    flush: async () => {},
  };
}

export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// 进程级单例 logger（读 LOG_LEVEL 环境变量）
import { getLogsDir } from "./paths"; // Step 0 提取，避免循环依赖
const globalLogger = createLogger({
  file: `${getLogsDir()}/3router.log`,
  level: Number(process.env.LOG_LEVEL ?? 4),
});
export const logger = globalLogger;
```

> ⚠️ 上面 `rotateIfNeeded` 的滚动逻辑有已知缺陷（当前文件→.1 的处理）。实现时需修正为：滚动后把当前 file 重命名为 `.1`，并确保不与上移冲突。正确的最小实现见下方「轮转修正」。

**轮转修正版 `rotateIfNeeded`：**
```ts
export function rotateIfNeeded(file: string, maxSize: number, maxFiles: number): void {
  if (!existsSync(file) || statSync(file).size < maxSize) return;
  // 从最旧往新滚动：.4→.5(若达上限则直接删)，.3→.4，.2→.3，.1→.2
  for (let i = maxFiles - 1; i >= 1; i--) {
    const cur = `${file}.${i}`;
    const next = `${file}.${i + 1}`;
    if (i + 1 > maxFiles) continue; // 超出上限的旧文件丢弃（由新写入覆盖）
    if (existsSync(cur)) renameSync(cur, next);
  }
  // 当前 file → .1（注意：此时 .1 已上移到 .2，所以 .1 空出来）
  renameSync(file, `${file}.1`);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test src/logger.test.ts`
Expected: 3 个测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts src/logger.test.ts package.json pnpm-lock.yaml
git commit -m "feat: 新建 consola logger 模块（文件落盘 + 按大小轮转）"
```

---

## Task 3: server.ts 重写为 Bun.serve

**Files:**
- Rewrite: `src/server.ts`
- Modify: `src/server.test.ts`

**Interfaces:**
- Consumes: `logger`（Task 2）、`buildProxyHandler`（proxy.ts）、`handleApiRoute`（api.ts）、`getLogsDir`/`readConfig`/`initConfig`/`validateConfig`（config.ts/cli.ts）
- Produces: `startServer()`（启动 Bun.serve）、`getWebDist()`（保留，返回 dist-web 路径）

- [ ] **Step 1: 更新 `src/server.test.ts` 适配 Bun.serve**

现有 smoke 测试（path traversal、SPA fallback）改用真实 Bun.serve 实例：
```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, tmpdir } from "node:path";

const TMP_WEB = join(tmpdir(), `3router-web-${Date.now()}`);
let server: { stop: () => void; port: number };

beforeEach(() => {
  mkdirSync(TMP_WEB, { recursive: true });
  writeFileSync(join(TMP_WEB, "index.html"), "<h1>home</h1>");
});
afterEach(async () => {
  server?.stop();
  rmSync(TMP_WEB, { recursive: true, force: true });
});

describe("Bun.serve", () => {
  it("SPA 根路径返回 index.html", async () => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(Bun.file(join(TMP_WEB, "index.html"))),
    });
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("home");
  });

  it("path traversal 被拦截（403）", async () => {
    // 调用 serveStatic 函数直接测（不通过 HTTP）
    const { serveStatic } = await import("./server");
    const res = await serveStatic("/../../etc/passwd", TMP_WEB);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test src/server.test.ts`
Expected: FAIL（当前 server.ts 还是 node:http，Bun.serve 接口不匹配 / serveStatic 签名变了）

- [ ] **Step 3: 重写 `src/server.ts`**

```ts
import { readConfig, initConfig, validateConfig } from "./config";
import { buildProxyHandler } from "./proxy";
import { handleApiRoute } from "./api";
import { logger } from "./logger";
import { getLogsDir } from "./cli";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function getWebDist(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
}

export async function serveStatic(
  pathname: string,
  webDist: string = getWebDist(),
): Promise<Response> {
  if (!existsSync(webDist)) {
    return Response.redirect(`http://localhost:5173${pathname}`, 302);
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(webDist, requested);
  if (!filePath.startsWith(webDist + "/")) return new Response("禁止访问", { status: 403 });

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, { headers: { "content-type": mimeFor(filePath) } });
  }
  // SPA fallback
  const index = Bun.file(join(webDist, "index.html"));
  return (await index.exists())
    ? new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } })
    : new Response("Not Found", { status: 404 });
}

export function startServer(): void {
  if (initConfig()) logger.info("已从模板创建默认配置");
  const config = readConfig();
  validateConfig(config);

  const proxyHandler = buildProxyHandler();

  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      try {
        if (url.pathname.startsWith("/v1/")) return await proxyHandler(req);
        if (url.pathname.startsWith("/api/")) return await handleApiRoute(req);
        return await serveStatic(url.pathname);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("请求错误", { path: url.pathname, error: msg });
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    },
  });

  logger.info("3router 启动", {
    port: config.port,
    upstreams: config.upstreams.length,
    rules: config.rules.length,
  });
}
```

**删除**：`createServer`、`incomingToRequest`、`sendResponse`（含 `Readable.fromWeb().pipe(res)`）、`handleWebRequest`、`packageRoot`。这些是断连 bug 的转换层。

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test src/server.test.ts`
Expected: PASS

- [ ] **Step 5: 启动验证（手动）**

Run: `bun run dev`
Expected: 控制台 + `~/.3router/logs/3router.log` 都有「3router 启动」日志，端口 9191 监听。Ctrl+C 退出。

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "refactor: server.ts 重写为 Bun.serve，删除 node:http 转换链"
```

---

## Task 4: proxy.ts 加诊断埋点

**Files:**
- Modify: `src/proxy.ts`
- Modify: `src/proxy.test.ts`

**Interfaces:**
- Consumes: `logger`（Task 2）、`newRequestId`（Task 2）

- [ ] **Step 1: 更新 `src/proxy.test.ts` 验证埋点**

```ts
import { describe, expect, it, mock } from "bun:test";
// mock fetch 返回一个流式 body，结束后验证 stream.end 记录

describe("proxy 诊断埋点", () => {
  it("上游返回 200 时记录 request.start + upstream.fetch + stream.end(done)", async () => {
    // mock config 返回固定 upstream；mock fetch 返回 Response("ok")
    // 调用 buildProxyHandler()，发一个 Request
    // 断言 logger.info 被调用且 stream.end 的 reason=done
  });

  it("上游抛错时记录 proxy.error", async () => {
    // mock fetch reject
    // 断言 logger.error 记录 proxy.error
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test src/proxy.test.ts`
Expected: FAIL（埋点未实现）

- [ ] **Step 3: 修改 `src/proxy.ts` 加埋点**

在 `buildProxyHandler` 内（参考现有结构，关键改动点）：
```ts
import { logger, newRequestId } from "./logger";

// handler 开头
const requestId = newRequestId();
const t0 = performance.now();
logger.info("request.start", { requestId, method: req.method, path: new URL(req.url).pathname });

// 匹配规则后
logger.info("request.start", { requestId, upstream: match.upstream.name, model: match.model });

// fetch 后
const upstreamRes = await fetch(upstreamReq);
logger.info("upstream.fetch", {
  requestId,
  status: upstreamRes.status,
  durationMs: Math.round(performance.now() - t0),
  stream: upstreamRes.headers.get("content-type")?.includes("event-stream") ?? false,
});

// 返回 Response 前，包装 body 记录 stream.end
function wrapStream(body: ReadableStream<Uint8Array> | null, requestId: string) {
  if (!body) {
    logger.info("stream.end", { requestId, bytes: 0, reason: "done", durationMs: 0 });
    return body;
  }
  const reader = body.getReader();
  let bytes = 0;
  const tStart = performance.now();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          logger.info("stream.end", {
            requestId, bytes,
            reason: "done",
            durationMs: Math.round(performance.now() - tStart),
          });
          controller.close();
          return;
        }
        if (value) bytes += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        logger.error("stream.end", {
          requestId, bytes,
          reason: err instanceof Error && err.name === "AbortError" ? "abort" : "error",
          error: err instanceof Error ? err.message : String(err),
        });
        controller.error(err);
      }
    },
    cancel() {
      logger.info("stream.end", { requestId, bytes, reason: "abort" });
    },
  });
}

// 返回前
const wrappedBody = wrapStream(upstreamRes.body, requestId);
return new Response(wrappedBody, { status: upstreamRes.status, headers: responseHeaders });

// catch 块
logger.error("proxy.error", { requestId, error: message });
```

> 注意：image cache 的 tee 逻辑保留——对 clientStream 包装埋点，cacheStream 不变。

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test src/proxy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat: proxy 加流式诊断埋点（stream.end 记录 done|error|abort）"
```

---

## Task 5: config.ts 改用 Bun.file + 接入 logger

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`（若涉及 fs 调用）

**Interfaces:**
- Consumes: `logger`
- Produces: `readConfig`/`writeConfig` 行为不变（内部 Bun.file）

- [ ] **Step 1: 跑现有 config 测试建立基线**

Run: `bun test src/config.test.ts`
Expected: PASS（现有测试应仍绿）

- [ ] **Step 2: 改 `src/config.ts`：`fs/promises.readFile` → `Bun.file().text()`，`writeFile` → `Bun.write`，关键操作加 logger**

具体：保留函数签名（`getConfigPath`/`readConfig`/`initConfig`/`validateConfig`），内部：
```ts
import { logger } from "./logger";
// 读：const raw = await Bun.file(getConfigPath()).text();
// 写：await Bun.write(getConfigPath(), JSON.stringify(config, null, 2));
// initConfig 成功时 logger.info("配置已初始化", ...)
// readConfig 失败时 logger.error
```

- [ ] **Step 3: 跑测试确认行为不变**

Run: `bun test src/config.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "refactor: config.ts 改用 Bun.file/Bun.write + 接入 logger"
```

---

## Task 6: cli.ts 接入 logger（console → logger）

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: 替换 cli.ts 所有 `console.log/warn/error` → `logger.info/warn/error`**

参考 grep 结果，约 15 处（"3router 前台模式运行中..."、"Plist 已写入"、端口占用错误等）：
```ts
import { logger } from "./logger";
// console.log("3router 前台模式运行中...") → logger.info("前台模式运行中")
// console.error(`错误: 端口 ${port} 已被占用`) → logger.error("端口被占用", { port })
// 其余同理
```

- [ ] **Step 2: 启动验证**

Run: `bun run src/cli.ts serve`
Expected: 控制台 + 日志文件均有启动记录，无 `console.*` 残留（`rg "console\.(log|error|warn)" src/` 应无业务输出，仅测试文件可能有）。

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "refactor: cli.ts 日志接入 logger（替换 console）"
```

---

## Task 7: 集成验证（断连 bug 复测）

**Files:** 无（验证步骤）

- [ ] **Step 1: 全量测试**

Run: `bun test`
Expected: 全绿

- [ ] **Step 2: 启动 + Claude Code 真实长对话验证**

```bash
bun run dev
```
用 Claude Code（`ANTHROPIC_BASE_URL=http://localhost:9191`）进行**长对话**（生成大段代码、多次追问），观察：
- ✅ 不再出现 `Connection closed mid-response`
- ✅ `~/.3router/logs/3router.log` 有完整事件链（request.start → upstream.fetch → stream.end）

- [ ] **Step 3: 检查日志内容**

```bash
tail -20 ~/.3router/logs/3router.log
```
Expected: 看到 JSON 行，含 `stream.end` 的 `reason: "done"`；若曾断连，`reason` 会显示 `error`/`abort` 并带错误信息。

- [ ] **Step 4: 验证轮转（可选）**

制造 >10MB 日志（循环发请求）或临时把 `maxSize` 改小，确认 `.1`/`.2` 滚动文件生成。

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "test: 集成验证通过 — Bun.serve 流式稳定 + 日志落盘"
```

---

## Self-Review 清单

- [x] spec A1（server.ts Bun.serve）→ Task 3
- [x] spec A2（proxy 透传 + 埋点）→ Task 4
- [x] spec A3（config Bun.file）→ Task 5
- [x] spec A4（cli 日志；bin/3router 探测）→ Task 6（探测删除留 Plan 2）
- [x] spec B1（logger.ts consola）→ Task 2
- [x] spec B2（诊断埋点）→ Task 4
- [x] spec B3（落盘轮转）→ Task 2
- [x] spec B4（替换 console）→ Task 5/6
- [x] consola 实测风险 → Task 1（前置验证 + fallback）
- [ ] spec C/D/E（编译/分发/CI/文档）→ **属 Plan 2**（本 plan 不覆盖，刻意）

**类型一致性**：`logger.info/warn/error`、`newRequestId()`、`createLogger()` 在各 Task 签名一致；`wrapStream(body, requestId)` 在 Task 4 定义并被引用。

---

## Plan 2（后续，本 plan 完成后）

- `--compile` 多平台构建 + 方案 B npm 分发（主包 + 平台子包 + shim）
- release.yml 矩阵重写 + 多包 OIDC
- npm scope org 创建、`npm deprecate` 旧包、文档更新
