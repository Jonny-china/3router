# 3router CLI + NPM Package + Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert 3router from a local development project into a globally installable npm package that provides a `3router` CLI command with daemon support via platform-native service management (launchd/systemd).

**Architecture:** A `bin/3router` Node.js entry script detects Bun availability, then delegates to `src/cli.ts` which routes subcommands. The `serve` command imports `src/server.ts` (refactored to export a `startServer()` function). The `start` command generates platform-specific service files (launchd plist or systemd unit) with embedded template strings, registers the service, and verifies startup via port polling. Configuration moves from project-local `config.json` to `~/.3router/config.json`.

**Tech Stack:** Bun runtime, TypeScript, npm packaging, launchd (macOS), systemd (Linux), Node.js `net` module (port probing)

---

## File Structure

```
3router/
├── bin/
│   └── 3router                   # #!/usr/bin/env node — Bun detection + CLI delegation
├── src/
│   ├── types.ts                  # (unchanged) Shared TypeScript interfaces
│   ├── config.ts                 # MODIFY: ~/.3router/ paths, env var override, import.meta.dir resolution
│   ├── config.test.ts            # MODIFY: Updated for new path resolution
│   ├── server.ts                 # MODIFY: Export startServer(), dist-web/ path
│   ├── service.ts                # CREATE: Pure service template generation functions
│   ├── service.test.ts           # CREATE: Tests for template generation
│   ├── cli.ts                    # CREATE: Command routing + OS-level daemon management
│   ├── router.ts                 # (unchanged)
│   ├── router.test.ts            # (unchanged)
│   ├── proxy.ts                  # (unchanged)
│   ├── proxy.test.ts             # (unchanged)
│   ├── api.ts                    # (unchanged)
│   ├── image-cache.ts            # (unchanged)
│   ├── image-cache.test.ts       # (unchanged)
│   ├── stream-parser.ts          # (unchanged)
│   ├── stream-parser.test.ts     # (unchanged)
│   ├── transform.ts              # (unchanged)
│   └── transform.test.ts         # (unchanged)
├── dist-web/                     # CREATE: Web frontend build output (copied from web/dist/)
├── config.example.json           # (unchanged) Bundled in npm package
├── package.json                  # MODIFY: bin field, files, scripts, version bump
├── .gitignore                    # MODIFY: Add dist-web/
└── ...
```

---

## Task 1: Update config.ts to ~/.3router/ directory

Config paths change from project-local (`./config.json`) to user-home (`~/.3router/config.json`). An environment variable override (`THREEROUTER_HOME`) enables testing without touching the real home directory. Example config resolution uses `import.meta.dir` for reliable path resolution regardless of `process.cwd()`.

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Rewrite config.ts with new path resolution**

Replace the entire contents of `src/config.ts`:

```typescript
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
```

- [ ] **Step 2: Update config.test.ts for new path resolution**

Replace the entire contents of `src/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "3router-test-"));
  process.env.THREEROUTER_HOME = testDir;
});

afterEach(() => {
  delete process.env.THREEROUTER_HOME;
  rmSync(testDir, { recursive: true, force: true });
});

function writeConfigFile(data: unknown, filename = "config.json") {
  writeFileSync(join(testDir, filename), JSON.stringify(data));
}

const validConfig = {
  port: 9191,
  upstreams: [{ id: "up-1", name: "Test", baseUrl: "https://api.test.com", apiKey: "key-1" }],
  rules: [
    {
      id: "rule-1",
      name: "Default",
      condition: "default" as const,
      upstreamId: "up-1",
      model: "claude-sonnet-4-6",
      priority: 999,
    },
  ],
};

describe("readConfig", () => {
  it("reads and parses a valid config.json from THREEROUTER_HOME", async () => {
    writeConfigFile(validConfig);
    const { readConfig } = await import("./config");
    const config = readConfig();
    expect(config.port).toBe(9191);
    expect(config.upstreams).toHaveLength(1);
    expect(config.upstreams[0].id).toBe("up-1");
    expect(config.rules).toHaveLength(1);
  });

  it("throws when config.json is missing", async () => {
    const { readConfig } = await import("./config");
    expect(() => readConfig()).toThrow();
  });

  it("throws when config.json contains invalid JSON", async () => {
    writeFileSync(join(testDir, "config.json"), "{ broken json");
    const { readConfig } = await import("./config");
    expect(() => readConfig()).toThrow();
  });
});

describe("validateConfig", () => {
  it("accepts a valid config", async () => {
    const { validateConfig } = await import("./config");
    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it("rejects when rules reference nonexistent upstream", async () => {
    const { validateConfig } = await import("./config");
    const badConfig = {
      ...validConfig,
      rules: [
        {
          id: "rule-1",
          name: "Bad",
          condition: "default" as const,
          upstreamId: "nonexistent",
          model: "claude-sonnet-4-6",
          priority: 999,
        },
      ],
    };
    expect(() => validateConfig(badConfig)).toThrow("nonexistent");
  });

  it("rejects when no default rule exists", async () => {
    const { validateConfig } = await import("./config");
    const badConfig = {
      ...validConfig,
      rules: [
        {
          id: "rule-1",
          name: "Image",
          condition: "has_image" as const,
          upstreamId: "up-1",
          model: "claude-opus-4-6",
          priority: 1,
        },
      ],
    };
    expect(() => validateConfig(badConfig)).toThrow("default");
  });

  it("rejects when upstreams array is empty", async () => {
    const { validateConfig } = await import("./config");
    const badConfig = { ...validConfig, upstreams: [] };
    expect(() => validateConfig(badConfig)).toThrow();
  });
});

describe("saveConfig", () => {
  it("writes config to config.json in THREEROUTER_HOME", async () => {
    writeConfigFile(validConfig);
    const { saveConfig, readConfig } = await import("./config");
    const config = { ...validConfig, port: 8080 };
    await saveConfig(config);
    const loaded = readConfig();
    expect(loaded.port).toBe(8080);
    expect(loaded.upstreams).toHaveLength(1);
  });
});

describe("initConfig", () => {
  it("copies config.example.json to config.json when config.json is missing", async () => {
    // The example config is resolved via import.meta.dir in config.ts,
    // so it reads from the package root, not THREEROUTER_HOME.
    // This test verifies that initConfig creates the config in THREEROUTER_HOME.
    const { initConfig, readConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(true);
    const config = readConfig();
    expect(config.port).toBe(9191);
  });

  it("returns false when config.json already exists", async () => {
    writeConfigFile(validConfig);
    const { initConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(false);
  });

  it("creates THREEROUTER_HOME directory if it does not exist", async () => {
    const nestedDir = join(testDir, "nested", ".3router");
    process.env.THREEROUTER_HOME = nestedDir;
    const { initConfig } = await import("./config");
    const result = initConfig();
    expect(result).toBe(true);
  });
});

describe("getBasePath", () => {
  it("returns THREEROUTER_HOME when set", async () => {
    const { getBasePath } = await import("./config");
    expect(getBasePath()).toBe(testDir);
  });

  it("returns ~/.3router when THREEROUTER_HOME is not set", async () => {
    delete process.env.THREEROUTER_HOME;
    const { getBasePath } = await import("./config");
    const expected = join(tmpdir(), "..", ".3router").replace(/\/\.\.\//, "/");
    // Just verify it ends with .3router and uses homedir
    expect(getBasePath()).toContain(".3router");
  });
});
```

- [ ] **Step 3: Run config tests**

Run: `bun test src/config.test.ts`
Expected: All tests PASS (10 tests across 5 describe blocks)

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "refactor: move config path to ~/.3router/ with env var override

Config resolution now uses ~/.3router/config.json instead of
project-local config.json. THREEROUTER_HOME env var enables
testing without touching the real home directory. Example
config path resolved via import.meta.dir for reliable location
regardless of process.cwd()."
```

---

## Task 2: Refactor server.ts to export startServer()

The server currently runs all initialization at module-load time. Refactor to export a `startServer()` function so the CLI can control when the server starts. The web static files path changes from `web/dist/` to `dist-web/`.

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Rewrite server.ts with exported startServer function**

Replace the entire contents of `src/server.ts`:

```typescript
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import { handleApiRoute } from "./api";
import { readConfig, initConfig, validateConfig } from "./config";
import { buildProxyHandler } from "./proxy";

export function startServer(): void {
  // Initialize config from example if missing
  if (initConfig()) {
    console.log("📝 已从模板创建默认配置 — 请编辑配置文件中填入你的 API Key。");
  }

  // Load and validate config at startup
  const config = readConfig();
  validateConfig(config);

  const proxyHandler = buildProxyHandler();
  // dist-web/ at package root (works for both dev and npm-installed)
  const WEB_DIST = join(dirname(import.meta.dir), "dist-web");

  Bun.serve({
    port: config.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // REST API for config management
      if (url.pathname.startsWith("/api/")) {
        return handleApiRoute(req);
      }

      // Proxy forwarding for API calls
      if (url.pathname.startsWith("/v1/")) {
        return proxyHandler(req);
      }

      // Static files from dist-web (production mode)
      if (existsSync(WEB_DIST)) {
        const requestedPath = url.pathname === "/" ? "index.html" : url.pathname;
        const filePath = join(WEB_DIST, requestedPath);
        // Prevent path traversal: ensure resolved path is within WEB_DIST
        if (!filePath.startsWith(WEB_DIST + "/")) {
          return new Response("禁止访问", { status: 403 });
        }
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file);
        }
        // SPA fallback: serve index.html for any unmatched route
        const indexFile = Bun.file(join(WEB_DIST, "index.html"));
        if (await indexFile.exists()) {
          return new Response(indexFile);
        }
      }

      // Development: redirect to Vite dev server
      return Response.redirect(`http://localhost:5173${url.pathname}`, 302);
    },
  });

  console.log(`🚀 3router listening on http://localhost:${config.port}`);
  console.log(`   ${config.upstreams.length} 个上游服务，${config.rules.length} 条规则`);
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `bun test`
Expected: All existing tests PASS (config, router, proxy, image-cache, stream-parser, transform). The server module is no longer auto-executed on import, so no spurious server startup occurs during testing.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "refactor: export startServer() from server.ts

Server initialization is now wrapped in an exported function
instead of running at module load time. This allows the CLI
to control when the server starts. Web static files path
changed from web/dist/ to dist-web/ for npm package layout."
```

---

## Task 3: Create service template generation module

Pure functions that generate launchd plist XML and systemd unit file content. Separated from OS-level operations for testability. Also includes port probing utilities used by the `start` command.

**Files:**
- Create: `src/service.ts`
- Create: `src/service.test.ts`

- [ ] **Step 1: Write failing tests for service template generation**

Create `src/service.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import {
  generatePlistContent,
  generateSystemdUnitContent,
  isPortInUse,
  waitForPort,
  LAUNCH_LABEL,
  SYSTEMD_UNIT_NAME,
} from "./service";
import { createServer } from "node:net";

describe("generatePlistContent", () => {
  it("generates valid XML with correct label", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/path/to/server.ts", "/tmp/logs");
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain(`<key>Label</key>`);
    expect(plist).toContain(`<string>${LAUNCH_LABEL}</string>`);
  });

  it("includes ProgramArguments with bun run and serve", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/opt/3router/src/server.ts", "/home/user/.3router/logs");
    expect(plist).toContain("<string>/usr/local/bin/bun</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>/opt/3router/src/server.ts</string>");
    expect(plist).toContain("<string>serve</string>");
  });

  it("sets RunAtLoad and KeepAlive to true", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/path/to/server.ts", "/tmp/logs");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    // Both should be <true/>
    const runAtLoadMatch = plist.match(/RunAtLoad<\/key>\s*<true\/>/);
    const keepAliveMatch = plist.match(/KeepAlive<\/key>\s*<true\/>/);
    expect(runAtLoadMatch).not.toBeNull();
    expect(keepAliveMatch).not.toBeNull();
  });

  it("sets correct log paths", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/path/to/server.ts", "/home/user/.3router/logs");
    expect(plist).toContain("<string>/home/user/.3router/logs/stdout.log</string>");
    expect(plist).toContain("<string>/home/user/.3router/logs/stderr.log</string>");
  });

  it("sets ThrottleInterval to 1", () => {
    const plist = generatePlistContent("/usr/local/bin/bun", "/path/to/server.ts", "/tmp/logs");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toMatch(/ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
  });
});

describe("generateSystemdUnitContent", () => {
  it("generates valid unit file with correct Unit section", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/opt/3router/src/server.ts");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=3router API proxy");
  });

  it("includes ExecStart with bun run and serve", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/opt/3router/src/server.ts");
    expect(unit).toContain("ExecStart=/usr/bin/bun run /opt/3router/src/server.ts serve");
  });

  it("sets Restart=on-failure and RestartSec=3", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/path/to/server.ts");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=3");
  });

  it("sets Type=simple", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/path/to/server.ts");
    expect(unit).toContain("Type=simple");
  });

  it("sets WantedBy=default.target", () => {
    const unit = generateSystemdUnitContent("/usr/bin/bun", "/path/to/server.ts");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("isPortInUse", () => {
  it("returns true when port is occupied", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;

    const result = await isPortInUse(port);
    expect(result).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns false when port is free", async () => {
    // Use port 0 to find a free port, then close it and check
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // After closing, the port should be free (might take a moment)
    // Use a high port that's very likely free as fallback
    const result = await isPortInUse(59999);
    expect(result).toBe(false);
  });
});

describe("waitForPort", () => {
  it("resolves quickly when port is already available", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as { port: number }).port;

    const start = Date.now();
    await waitForPort(port, 5000);
    const elapsed = Date.now() - start;

    // Should resolve within the first poll interval (500ms)
    expect(elapsed).toBeLessThan(1000);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects when port never becomes available", async () => {
    // Use a port that nothing is listening on
    // Use a short timeout to keep the test fast
    await expect(waitForPort(59998, 1500)).rejects.toThrow("1500ms");
  });
});

describe("constants", () => {
  it("exports LAUNCH_LABEL as com.3router.daemon", () => {
    expect(LAUNCH_LABEL).toBe("com.3router.daemon");
  });

  it("exports SYSTEMD_UNIT_NAME as 3router.service", () => {
    expect(SYSTEMD_UNIT_NAME).toBe("3router.service");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/service.test.ts`
Expected: FAIL — module `./service` does not exist

- [ ] **Step 3: Implement service.ts**

Create `src/service.ts`:

```typescript
import { createServer } from "node:net";

export const LAUNCH_LABEL = "com.3router.daemon";
export const SYSTEMD_UNIT_NAME = "3router.service";

/**
 * Generate launchd plist XML content.
 */
export function generatePlistContent(
  bunPath: string,
  serverPath: string,
  logsDir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${serverPath}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>${logsDir}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${process.env.HOME}</string>
  </dict>
</dict>
</plist>`;
}

/**
 * Generate systemd user unit file content.
 */
export function generateSystemdUnitContent(
  bunPath: string,
  serverPath: string,
): string {
  return `[Unit]
Description=3router API proxy

[Service]
Type=simple
ExecStart=${bunPath} run ${serverPath} serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

/**
 * Check if a TCP port is currently in use.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port);
  });
}

/**
 * Poll a port every 500ms until it becomes available.
 * Rejects if the port is not available within the timeout.
 */
export function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const maxAttempts = Math.ceil(timeoutMs / 500);
  let attempts = 0;

  return new Promise((resolve, reject) => {
    function check() {
      attempts++;
      isPortInUse(port).then((inUse) => {
        if (inUse) {
          resolve();
        } else if (attempts >= maxAttempts) {
          reject(new Error(`等待 3router 启动超时（${timeoutMs}ms）`));
        } else {
          setTimeout(check, 500);
        }
      });
    }
    check();
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/service.test.ts`
Expected: All tests PASS (13 tests across 6 describe blocks)

- [ ] **Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "feat: add service template generation and port utilities

Pure functions for generating launchd plist and systemd unit
file content. Port probing and polling utilities for daemon
startup verification. Separated from OS-level operations for
testability."
```

---

## Task 4: Create CLI module — serve command

The CLI module (`src/cli.ts`) routes subcommands. Start with the `serve` command which starts the server in foreground mode, and the default behavior (no subcommand = serve).

**Files:**
- Create: `src/cli.ts`

- [ ] **Step 1: Implement cli.ts with serve command and command routing**

Create `src/cli.ts`:

```typescript
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getBasePath, getConfigPath } from "./config";
import {
  LAUNCH_LABEL,
  SYSTEMD_UNIT_NAME,
  generatePlistContent,
  generateSystemdUnitContent,
  isPortInUse,
  waitForPort,
} from "./service";

const VERSION = "0.2.0";

// --- Utility ---

function getServerPath(): string {
  // src/cli.ts → src/server.ts (same directory)
  return join(import.meta.dir, "server.ts");
}

function getLogsDir(): string {
  return join(getBasePath(), "logs");
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

// --- Commands ---

function commandServe(): void {
  // Dynamic import to avoid loading server.ts (and its side effects)
  // when running other commands
  import("./server").then(({ startServer }) => {
    console.log("3router 前台模式运行中...");
    startServer();
  });
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0] || "serve";

switch (command) {
  case "serve":
    commandServe();
    break;
  default:
    console.error(`未知命令: ${command}`);
    console.error(`可用命令: serve, start, stop, status`);
    process.exit(1);
}
```

- [ ] **Step 2: Test serve command manually**

Run: `bun run src/cli.ts serve`
Expected: Server starts with output like:
```
3router 前台模式运行中...
🚀 3router listening on http://localhost:9191
   1 个上游服务，2 条规则
```
Press Ctrl+C to stop.

- [ ] **Step 3: Test default command (no args)**

Run: `bun run src/cli.ts`
Expected: Same as `serve` — server starts in foreground mode.
Press Ctrl+C to stop.

- [ ] **Step 4: Test unknown command**

Run: `bun run src/cli.ts foobar`
Expected:
```
未知命令: foobar
可用命令: serve, start, stop, status
```
Exit code: 1

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add CLI module with serve command

Command routing for 3router CLI. The serve command dynamically
imports server.ts and calls startServer(). Default command
(no args) is serve."
```

---

## Task 5: Implement start command

The `start` command generates a platform-specific service file, registers the service with launchd/systemd, starts the daemon, and verifies it is running via port polling.

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add start command to cli.ts**

Replace the entire contents of `src/cli.ts`:

```typescript
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { getBasePath, getConfigPath, readConfig, initConfig, validateConfig } from "./config";
import {
  LAUNCH_LABEL,
  SYSTEMD_UNIT_NAME,
  generatePlistContent,
  generateSystemdUnitContent,
  isPortInUse,
  waitForPort,
} from "./service";

const VERSION = "0.2.0";

// --- Utility ---

function getServerPath(): string {
  return join(import.meta.dir, "server.ts");
}

function getLogsDir(): string {
  return join(getBasePath(), "logs");
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function getBunPath(): string {
  const result = execSync("which bun", { encoding: "utf-8" }).trim();
  if (!result) {
    console.error("错误: 找不到 bun 可执行文件。请确认 Bun 已安装并在 PATH 中。");
    process.exit(1);
  }
  return result;
}

function getUid(): string {
  return execSync("id -u", { encoding: "utf-8" }).trim();
}

// --- Service file paths ---

function getPlistPath(): string {
  return join(
    process.env.HOME || "~",
    "Library",
    "LaunchAgents",
    `${LAUNCH_LABEL}.plist`,
  );
}

function getSystemdUnitPath(): string {
  return join(
    process.env.HOME || "~",
    ".config",
    "systemd",
    "user",
    SYSTEMD_UNIT_NAME,
  );
}

// --- Service state detection ---

function isServiceRegistered(): boolean {
  if (isMacOS()) {
    return existsSync(getPlistPath());
  }
  if (isLinux()) {
    return existsSync(getSystemdUnitPath());
  }
  return false;
}

function isServiceRunning(): boolean {
  if (isMacOS()) {
    try {
      const output = execSync(`launchctl print gui/${getUid()}/${LAUNCH_LABEL} 2>/dev/null`, {
        encoding: "utf-8",
      });
      // If launchctl print succeeds, the service is loaded
      return output.includes(LAUNCH_LABEL);
    } catch {
      return false;
    }
  }
  if (isLinux()) {
    try {
      const output = execSync("systemctl --user is-active 3router 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
      return output === "active";
    } catch {
      return false;
    }
  }
  return false;
}

function getServicePid(): string | null {
  if (isMacOS()) {
    try {
      const output = execSync(`launchctl print gui/${getUid()}/${LAUNCH_LABEL} 2>/dev/null`, {
        encoding: "utf-8",
      });
      const match = output.match(/pid = (\d+)/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
  if (isLinux()) {
    try {
      const output = execSync(
        "systemctl --user show 3router --property=MainPID --value 2>/dev/null",
        { encoding: "utf-8" },
      ).trim();
      return output && output !== "0" ? output : null;
    } catch {
      return null;
    }
  }
  return null;
}

// --- Commands ---

function commandServe(): void {
  import("./server").then(({ startServer }) => {
    console.log("3router 前台模式运行中...");
    startServer();
  });
}

function commandStart(): void {
  if (!isMacOS() && !isLinux()) {
    console.error("错误: daemon 模式仅支持 macOS 和 Linux");
    process.exit(1);
  }

  // Idempotency: already running
  if (isServiceRunning()) {
    const pid = getServicePid();
    console.log(`3router is already running (PID ${pid || "unknown"})`);
    return;
  }

  // Idempotency: installed but not running — just start
  if (isServiceRegistered()) {
    console.log("3router 服务已安装但未运行，正在启动...");
    startService();
    verifyStartup();
    return;
  }

  // Fresh install: generate service file, register, start
  console.log("正在安装 3router daemon...");

  // Initialize config if needed
  if (initConfig()) {
    console.log(`📝 配置已初始化: ${getConfigPath()}`);
    console.log("   请编辑配置文件以添加你的 API Key。");
  }

  // Create logs directory
  mkdirSync(getLogsDir(), { recursive: true });

  // Generate and write service file
  const bunPath = getBunPath();
  const serverPath = getServerPath();

  if (isMacOS()) {
    const plistContent = generatePlistContent(bunPath, serverPath, getLogsDir());
    const plistPath = getPlistPath();
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plistContent);
    console.log(`   Plist 已写入: ${plistPath}`);
  } else {
    const unitContent = generateSystemdUnitContent(bunPath, serverPath);
    const unitPath = getSystemdUnitPath();
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unitContent);
    console.log(`   Unit 已写入: ${unitPath}`);
  }

  // Register and start
  registerAndStartService();
  verifyStartup();
}

function registerAndStartService(): void {
  if (isMacOS()) {
    const uid = getUid();
    const plistPath = getPlistPath();
    execSync(`launchctl bootstrap gui/${uid} ${plistPath}`, { stdio: "inherit" });
    execSync(`launchctl kickstart gui/${uid}/${LAUNCH_LABEL}`, { stdio: "inherit" });
  } else {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync("systemctl --user enable 3router", { stdio: "inherit" });
    execSync("systemctl --user start 3router", { stdio: "inherit" });
  }
}

function startService(): void {
  if (isMacOS()) {
    const uid = getUid();
    execSync(`launchctl kickstart gui/${uid}/${LAUNCH_LABEL}`, { stdio: "inherit" });
  } else {
    execSync("systemctl --user start 3router", { stdio: "inherit" });
  }
}

function verifyStartup(): void {
  let port: number;
  try {
    const config = readConfig();
    port = config.port;
  } catch {
    console.error("错误: 无法读取配置文件，跳过启动验证");
    return;
  }

  console.log("正在验证服务启动...");
  waitForPort(port, 15000)
    .then(() => {
      console.log(`✅ 3router daemon 已启动，端口: ${port}`);
    })
    .catch((err: Error) => {
      console.error(`❌ ${err.message}`);
      console.error("   请检查日志:");
      if (isMacOS()) {
        console.error(`   cat ${getLogsDir()}/stderr.log`);
      } else {
        console.error("   journalctl --user -u 3router -n 20");
      }
      process.exit(1);
    });
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0] || "serve";

switch (command) {
  case "serve":
    commandServe();
    break;
  case "start":
    commandStart();
    break;
  default:
    console.error(`未知命令: ${command}`);
    console.error(`可用命令: serve, start, stop, status`);
    process.exit(1);
}
```

- [ ] **Step 2: Verify serve command still works**

Run: `bun run src/cli.ts serve`
Expected: Server starts normally (same as Task 4).
Press Ctrl+C to stop.

- [ ] **Step 3: Test unknown command error message updated**

Run: `bun run src/cli.ts badcommand`
Expected:
```
未知命令: badcommand
可用命令: serve, start, stop, status
```

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add start command for daemon installation

Generates launchd plist (macOS) or systemd unit (Linux),
registers the service, starts the daemon, and verifies
startup via port polling. Idempotent: detects already-running
and already-installed states."
```

---

## Task 6: Implement stop and status commands

The `stop` command stops the daemon, unregisters the service, and removes the service file. The `status` command displays current state.

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add stop and status commands to cli.ts**

Replace the entire contents of `src/cli.ts`:

```typescript
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { getBasePath, getConfigPath, readConfig, initConfig, validateConfig } from "./config";
import {
  LAUNCH_LABEL,
  SYSTEMD_UNIT_NAME,
  generatePlistContent,
  generateSystemdUnitContent,
  isPortInUse,
  waitForPort,
} from "./service";

const VERSION = "0.2.0";

// --- Utility ---

function getServerPath(): string {
  return join(import.meta.dir, "server.ts");
}

function getLogsDir(): string {
  return join(getBasePath(), "logs");
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function getBunPath(): string {
  const result = execSync("which bun", { encoding: "utf-8" }).trim();
  if (!result) {
    console.error("错误: 找不到 bun 可执行文件。请确认 Bun 已安装并在 PATH 中。");
    process.exit(1);
  }
  return result;
}

function getUid(): string {
  return execSync("id -u", { encoding: "utf-8" }).trim();
}

// --- Service file paths ---

function getPlistPath(): string {
  return join(
    process.env.HOME || "~",
    "Library",
    "LaunchAgents",
    `${LAUNCH_LABEL}.plist`,
  );
}

function getSystemdUnitPath(): string {
  return join(
    process.env.HOME || "~",
    ".config",
    "systemd",
    "user",
    SYSTEMD_UNIT_NAME,
  );
}

// --- Service state detection ---

function isServiceRegistered(): boolean {
  if (isMacOS()) {
    return existsSync(getPlistPath());
  }
  if (isLinux()) {
    return existsSync(getSystemdUnitPath());
  }
  return false;
}

function isServiceRunning(): boolean {
  if (isMacOS()) {
    try {
      const output = execSync(`launchctl print gui/${getUid()}/${LAUNCH_LABEL} 2>/dev/null`, {
        encoding: "utf-8",
      });
      return output.includes(LAUNCH_LABEL);
    } catch {
      return false;
    }
  }
  if (isLinux()) {
    try {
      const output = execSync("systemctl --user is-active 3router 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
      return output === "active";
    } catch {
      return false;
    }
  }
  return false;
}

function getServicePid(): string | null {
  if (isMacOS()) {
    try {
      const output = execSync(`launchctl print gui/${getUid()}/${LAUNCH_LABEL} 2>/dev/null`, {
        encoding: "utf-8",
      });
      const match = output.match(/pid = (\d+)/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
  if (isLinux()) {
    try {
      const output = execSync(
        "systemctl --user show 3router --property=MainPID --value 2>/dev/null",
        { encoding: "utf-8" },
      ).trim();
      return output && output !== "0" ? output : null;
    } catch {
      return null;
    }
  }
  return null;
}

// --- Commands ---

function commandServe(): void {
  import("./server").then(({ startServer }) => {
    console.log("3router 前台模式运行中...");
    startServer();
  });
}

function commandStart(): void {
  if (!isMacOS() && !isLinux()) {
    console.error("错误: daemon 模式仅支持 macOS 和 Linux");
    process.exit(1);
  }

  // Idempotency: already running
  if (isServiceRunning()) {
    const pid = getServicePid();
    console.log(`3router is already running (PID ${pid || "unknown"})`);
    return;
  }

  // Idempotency: installed but not running — just start
  if (isServiceRegistered()) {
    console.log("3router 服务已安装但未运行，正在启动...");
    startService();
    verifyStartup();
    return;
  }

  // Fresh install
  console.log("正在安装 3router daemon...");

  if (initConfig()) {
    console.log(`📝 配置已初始化: ${getConfigPath()}`);
    console.log("   请编辑配置文件以添加你的 API Key。");
  }

  mkdirSync(getLogsDir(), { recursive: true });

  const bunPath = getBunPath();
  const serverPath = getServerPath();

  if (isMacOS()) {
    const plistContent = generatePlistContent(bunPath, serverPath, getLogsDir());
    const plistPath = getPlistPath();
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plistContent);
    console.log(`   Plist 已写入: ${plistPath}`);
  } else {
    const unitContent = generateSystemdUnitContent(bunPath, serverPath);
    const unitPath = getSystemdUnitPath();
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unitContent);
    console.log(`   Unit 已写入: ${unitPath}`);
  }

  registerAndStartService();
  verifyStartup();
}

function commandStop(): void {
  if (!isMacOS() && !isLinux()) {
    console.error("错误: daemon 模式仅支持 macOS 和 Linux");
    process.exit(1);
  }

  // Idempotency: not running and not installed
  if (!isServiceRunning() && !isServiceRegistered()) {
    console.log("3router is not running");
    return;
  }

  console.log("正在停止 3router daemon...");

  // Stop and unregister
  if (isMacOS()) {
    const uid = getUid();
    try {
      execSync(`launchctl bootout gui/${uid}/${LAUNCH_LABEL}`, { stdio: "inherit" });
    } catch {
      // Service may already be unloaded
    }
  } else {
    try {
      execSync("systemctl --user stop 3router", { stdio: "inherit" });
    } catch {
      // Service may already be stopped
    }
    try {
      execSync("systemctl --user disable 3router", { stdio: "inherit" });
    } catch {
      // Best effort
    }
  }

  // Remove service file
  if (isMacOS()) {
    const plistPath = getPlistPath();
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      console.log(`   已删除: ${plistPath}`);
    }
  } else {
    const unitPath = getSystemdUnitPath();
    if (existsSync(unitPath)) {
      rmSync(unitPath);
      execSync("systemctl --user daemon-reload", { stdio: "inherit" });
      console.log(`   已删除: ${unitPath}`);
    }
  }

  console.log("✅ 3router daemon 已停止");
}

function commandStatus(): void {
  console.log(`3router v${VERSION}`);

  if (isServiceRunning()) {
    const pid = getServicePid();
    console.log(`Status: running (PID ${pid || "unknown"})`);

    try {
      const config = readConfig();
      console.log(`Port:   ${config.port}`);
    } catch {
      // Config may not be readable
    }
  } else {
    console.log("Status: stopped");
  }

  console.log(`Config: ${getConfigPath()}`);
}

// --- Service management helpers ---

function registerAndStartService(): void {
  if (isMacOS()) {
    const uid = getUid();
    const plistPath = getPlistPath();
    execSync(`launchctl bootstrap gui/${uid} ${plistPath}`, { stdio: "inherit" });
    execSync(`launchctl kickstart gui/${uid}/${LAUNCH_LABEL}`, { stdio: "inherit" });
  } else {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync("systemctl --user enable 3router", { stdio: "inherit" });
    execSync("systemctl --user start 3router", { stdio: "inherit" });
  }
}

function startService(): void {
  if (isMacOS()) {
    const uid = getUid();
    execSync(`launchctl kickstart gui/${uid}/${LAUNCH_LABEL}`, { stdio: "inherit" });
  } else {
    execSync("systemctl --user start 3router", { stdio: "inherit" });
  }
}

function verifyStartup(): void {
  let port: number;
  try {
    const config = readConfig();
    port = config.port;
  } catch {
    console.error("错误: 无法读取配置文件，跳过启动验证");
    return;
  }

  console.log("正在验证服务启动...");
  waitForPort(port, 15000)
    .then(() => {
      console.log(`✅ 3router daemon 已启动，端口: ${port}`);
    })
    .catch((err: Error) => {
      console.error(`❌ ${err.message}`);
      console.error("   请检查日志:");
      if (isMacOS()) {
        console.error(`   cat ${getLogsDir()}/stderr.log`);
      } else {
        console.error("   journalctl --user -u 3router -n 20");
      }
      process.exit(1);
    });
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0] || "serve";

switch (command) {
  case "serve":
    commandServe();
    break;
  case "start":
    commandStart();
    break;
  case "stop":
    commandStop();
    break;
  case "status":
    commandStatus();
    break;
  default:
    console.error(`未知命令: ${command}`);
    console.error(`可用命令: serve, start, stop, status`);
    process.exit(1);
}
```

- [ ] **Step 2: Test status command when not running**

Run: `bun run src/cli.ts status`
Expected:
```
3router v0.2.0
Status: stopped
Config: /Users/<you>/.3router/config.json
```

- [ ] **Step 3: Test stop command when not running (idempotency)**

Run: `bun run src/cli.ts stop`
Expected:
```
3router is not running
```

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add stop and status commands

stop: stops daemon, unregisters service, removes service file.
Idempotent — prints 'not running' if already stopped.
status: displays version, running state, PID, port, and
config path."
```

---

## Task 7: Create bin script

The `bin/3router` entry point is a Node.js script (since npm guarantees Node.js availability) that checks for Bun and delegates to `src/cli.ts`.

**Files:**
- Create: `bin/3router`

- [ ] **Step 1: Create bin/3router**

Create the directory and file `bin/3router`:

```javascript
#!/usr/bin/env node

const { execFileSync } = require("child_process");

// Check if Bun is installed
let bunPath;
try {
  bunPath = execFileSync("which", ["bun"], { encoding: "utf-8" }).trim();
} catch {
  console.error("Error: Bun runtime is required but not installed.");
  console.error("");
  console.error("Install Bun:");
  console.error("  curl -fsSL https://bun.sh/install | bash");
  console.error("");
  console.error("Then try again:");
  console.error("  3router " + process.argv.slice(2).join(" "));
  process.exit(1);
}

// Resolve path to src/cli.ts relative to this script
const path = require("path");
const cliPath = path.join(__dirname, "..", "src", "cli.ts");

// Delegate to Bun
try {
  execFileSync(bunPath, ["run", cliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (err) {
  // execFileSync throws on non-zero exit; the child already printed output
  process.exit(err.status || 1);
}
```

- [ ] **Step 2: Make bin/3router executable**

Run: `chmod +x bin/3router`

- [ ] **Step 3: Verify the script is executable**

Run: `ls -la bin/3router`
Expected: File permissions include execute bit (e.g., `-rwxr-xr-x`)

- [ ] **Step 4: Test bin script directly**

Run: `node bin/3router status`
Expected:
```
3router v0.2.0
Status: stopped
Config: /Users/<you>/.3router/config.json
```

- [ ] **Step 5: Commit**

```bash
git add bin/3router
git commit -m "feat: add bin/3router entry script with Bun detection

Node.js shebang script that checks for Bun availability and
delegates to src/cli.ts. Uses execFileSync for proper signal
handling and exit code propagation."
```

---

## Task 8: Update package.json and build pipeline

Update `package.json` for npm publishing: add `bin` field, `files` allowlist, build scripts, bump version to 0.2.0, and change `private` to `false`. Update `.gitignore` for `dist-web/`.

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Update package.json**

Replace the entire contents of `package.json`:

```json
{
  "name": "3router",
  "version": "0.2.0",
  "private": false,
  "type": "module",
  "bin": {
    "3router": "bin/3router"
  },
  "files": [
    "bin/",
    "src/",
    "dist-web/",
    "config.example.json"
  ],
  "engines": {
    "bun": ">=1.0"
  },
  "scripts": {
    "dev": "bun run --watch src/server.ts",
    "build": "cd web && pnpm build && rm -rf ../dist-web && cp -r dist ../dist-web",
    "build:web": "cd web && pnpm build",
    "build:copy": "rm -rf dist-web && cp -r web/dist dist-web",
    "prepublishOnly": "npm run build",
    "start": "bun run src/cli.ts serve",
    "test": "bun test",
    "lint": "oxlint src/ web/src/",
    "format": "oxfmt src/ web/src/",
    "format:check": "oxfmt --check src/ web/src/"
  },
  "devDependencies": {
    "bun-types": "^1.3.14",
    "oxfmt": "^0.53.0",
    "oxlint": "^1.68.0",
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 2: Add dist-web/ to .gitignore**

Add this line to `.gitignore` under the "Build output" section (after the existing `web/dist/` line):

```
dist-web/
```

The full `.gitignore` should now include:

```
# Build output
web/dist/
dist-web/
```

- [ ] **Step 3: Build the web frontend and copy to dist-web/**

Run: `npm run build`
Expected: Vite builds `web/dist/`, then copies it to `dist-web/` at the project root.

- [ ] **Step 4: Verify dist-web/ exists and has expected content**

Run: `ls dist-web/`
Expected: `index.html` and `assets/` directory

- [ ] **Step 5: Verify npm package contents with --dry-run**

Run: `npm pack --dry-run`
Expected: The output lists files that would be included in the package. Should include:
- `bin/3router`
- `src/*.ts` (no `.test.ts` files if they are excluded by `.gitignore` or npm's default behavior)
- `dist-web/index.html`
- `dist-web/assets/*`
- `config.example.json`
- `package.json`

Should NOT include:
- `config.json` (not in `files`)
- `web/` (not in `files`)
- `node_modules/` (never included)
- `.gitignore` (not in `files`)

If test files are included and you want to exclude them, add a `.npmignore` or adjust `files`. Note: npm includes test files by default; this is acceptable for now.

- [ ] **Step 6: Run all tests to verify nothing is broken**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: configure package.json for npm publishing

Add bin field for 3router CLI command, files allowlist for
npm package contents, build pipeline with dist-web/ copy,
prepublishOnly hook, version bump to 0.2.0, and private=false."
```

---

## Task 9: Smoke test full CLI workflow

End-to-end verification of the complete CLI workflow: foreground mode, status, start daemon, verify running, stop daemon, verify stopped.

**Files:** (no file changes — verification only)

- [ ] **Step 1: Test foreground serve**

Run: `bun run src/cli.ts serve`
Expected: Server starts, logs port and upstream/rule counts. Open `http://localhost:9191` in a browser — the web UI should load (if `dist-web/` exists) or redirect to Vite dev server.
Press Ctrl+C to stop.

- [ ] **Step 2: Test status when stopped**

Run: `bun run src/cli.ts status`
Expected:
```
3router v0.2.0
Status: stopped
Config: /Users/<you>/.3router/config.json
```

- [ ] **Step 3: Test start daemon**

Run: `bun run src/cli.ts start`
Expected output (on macOS):
```
正在安装 3router daemon...
   Plist 已写入: /Users/<you>/Library/LaunchAgents/com.3router.daemon.plist
正在验证服务启动...
✅ 3router daemon 已启动，端口: 9191
```

- [ ] **Step 4: Test status when running**

Run: `bun run src/cli.ts status`
Expected:
```
3router v0.2.0
Status: running (PID <number>)
Port:   9191
Config: /Users/<you>/.3router/config.json
```

- [ ] **Step 5: Test start idempotency**

Run: `bun run src/cli.ts start`
Expected:
```
3router is already running (PID <number>)
```

- [ ] **Step 6: Verify daemon is serving requests**

Run: `curl http://localhost:9191/api/config`
Expected: JSON response with the current configuration

- [ ] **Step 7: Test stop**

Run: `bun run src/cli.ts stop`
Expected:
```
正在停止 3router daemon...
   已删除: /Users/<you>/Library/LaunchAgents/com.3router.daemon.plist
✅ 3router daemon 已停止
```

- [ ] **Step 8: Test stop idempotency**

Run: `bun run src/cli.ts stop`
Expected:
```
3router is not running
```

- [ ] **Step 9: Verify status after stop**

Run: `bun run src/cli.ts status`
Expected:
```
3router v0.2.0
Status: stopped
Config: /Users/<you>/.3router/config.json
```

- [ ] **Step 10: Verify port is free**

Run: `curl http://localhost:9191/api/config`
Expected: Connection refused (port is free)

- [ ] **Step 11: Test npm link (simulates global install)**

Run: `npm link`
Expected: Creates a global symlink. Then:

Run: `3router status`
Expected: Same output as `bun run src/cli.ts status`

Run: `3router serve`
Expected: Server starts in foreground mode.
Press Ctrl+C to stop.

Run: `npm unlink -g 3router`
Expected: Removes the global symlink.

- [ ] **Step 12: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 13: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve issues found during smoke testing"
```

Only commit if changes were made. If everything passed, skip this step.
