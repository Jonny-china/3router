import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig, initConfig } from "./config";
import { logger } from "./logger";
import { getLogsDir, getConfigPath } from "./paths";
import { startServer } from "./server";
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

interface RuntimeInfo {
  name: "bun" | "node";
  execPath: string;
  cliEntry: string;
}

function detectRuntime(): RuntimeInfo {
  const versions = (process as { versions?: { bun?: string } }).versions ?? {};
  const name: "bun" | "node" = typeof versions.bun === "string" ? "bun" : "node";
  return {
    name,
    execPath: process.execPath,
    cliEntry: fileURLToPath(import.meta.url),
  };
}

function buildRuntimeCommand(runtime: RuntimeInfo, action: string): string[] {
  if (runtime.name === "bun") {
    return [runtime.execPath, "run", runtime.cliEntry, action];
  }
  return [runtime.execPath, runtime.cliEntry, action];
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

let cachedUid: string | undefined;
function getUid(): string {
  if (!cachedUid) {
    cachedUid = execSync("id -u", { encoding: "utf-8" }).trim();
  }
  return cachedUid;
}

// --- Service file paths ---

function getPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
}

function getSystemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

// --- Service state detection ---

interface ServiceState {
  running: boolean;
  pid: string | null;
}

function isServiceRegistered(): boolean {
  if (isMacOS()) {
    return existsSync(getPlistPath());
  }
  if (isLinux()) {
    return existsSync(getSystemdUnitPath());
  }
  return false;
}

function getServiceState(): ServiceState {
  if (isMacOS()) {
    try {
      const output = execSync(`launchctl print gui/${getUid()}/${LAUNCH_LABEL} 2>/dev/null`, {
        encoding: "utf-8",
      });
      const match = output.match(/pid = (\d+)/);
      return { running: true, pid: match?.[1] ?? null };
    } catch {
      return { running: false, pid: null };
    }
  }
  if (isLinux()) {
    try {
      const active = execSync("systemctl --user is-active 3router 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
      if (active !== "active") {
        return { running: false, pid: null };
      }
      const pid = execSync("systemctl --user show 3router --property=MainPID --value 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
      return { running: true, pid: pid && pid !== "0" ? pid : null };
    } catch {
      return { running: false, pid: null };
    }
  }
  return { running: false, pid: null };
}

// --- Commands ---

function commandServe(): void {
  try {
    logger.info("3router 前台模式运行中...");
    startServer();
  } catch (err: unknown) {
    logger.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function commandStart(): void {
  // Idempotency: already running
  const state = getServiceState();
  if (state.running) {
    logger.info(`3router is already running (PID ${state.pid || "unknown"})`);
    return;
  }

  // Remaining start logic is async (port pre-check uses isPortInUse)
  void (async () => {
    // Port pre-check (spec requirement: check port before starting)
    try {
      const config = readConfig();
      const portBusy = await isPortInUse(config.port);
      if (portBusy) {
        logger.error(`错误: 端口 ${config.port} 已被占用，请释放端口后重试`);
        process.exit(1);
      }
    } catch {
      // Config may not exist yet — will be initialized below
    }

    // Idempotency: installed but not running — just start
    if (isServiceRegistered()) {
      logger.info("3router 服务已安装但未运行，正在启动...");
      startService();
      verifyStartup();
      return;
    }

    // Fresh install: generate service file, register, start
    logger.info("正在安装 3router daemon...");

    // Initialize config if needed
    if (initConfig()) {
      logger.info(`📝 配置已初始化: ${getConfigPath()}`);
      logger.info("   请编辑配置文件以添加你的 API Key。");
    }

    // Create logs directory
    mkdirSync(getLogsDir(), { recursive: true });

    // Generate and write service file
    const runtime = detectRuntime();
    const serveCmd = buildRuntimeCommand(runtime, "serve");

    if (isMacOS()) {
      const plistContent = generatePlistContent(serveCmd, getLogsDir());
      const plistPath = getPlistPath();
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, plistContent);
      logger.info(`   Plist 已写入: ${plistPath}`);
    } else {
      const unitContent = generateSystemdUnitContent(serveCmd);
      const unitPath = getSystemdUnitPath();
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, unitContent);
      logger.info(`   Unit 已写入: ${unitPath}`);
    }

    // Register and start
    registerAndStartService();
    verifyStartup();
  })();
}

function commandStop(): void {
  // Idempotency: not running and not installed
  const state = getServiceState();
  if (!state.running && !isServiceRegistered()) {
    logger.info("3router is not running");
    return;
  }

  logger.info("正在停止 3router daemon...");

  if (isMacOS()) {
    const uid = getUid();
    try {
      execSync(`launchctl bootout gui/${uid}/${LAUNCH_LABEL}`, { stdio: "inherit" });
    } catch {
      // Service may already be unloaded
    }
    const plistPath = getPlistPath();
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      logger.info(`   已删除: ${plistPath}`);
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
    const unitPath = getSystemdUnitPath();
    if (existsSync(unitPath)) {
      rmSync(unitPath);
      execSync("systemctl --user daemon-reload", { stdio: "inherit" });
      logger.info(`   已删除: ${unitPath}`);
    }
  }

  logger.info("✅ 3router daemon 已停止");
}

function commandStatus(): void {
  logger.info(`3router v${VERSION}`);

  const state = getServiceState();
  if (state.running) {
    logger.info(`Status: running (PID ${state.pid || "unknown"})`);

    try {
      const config = readConfig();
      logger.info(`Port:   ${config.port}`);
    } catch {
      // Config may not be readable
    }
  } else {
    logger.info("Status: stopped");
  }

  logger.info(`Config: ${getConfigPath()}`);
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
    logger.error("错误: 无法读取配置文件，跳过启动验证");
    return;
  }

  logger.info("正在验证服务启动...");
  waitForPort(port, 15000)
    .then(() => {
      logger.info(`✅ 3router daemon 已启动，端口: ${port}`);
    })
    .catch((err: Error) => {
      logger.error(`❌ ${err.message}`);
      logger.error("   请检查日志:");
      if (isMacOS()) {
        logger.error(`   cat ${getLogsDir()}/stderr.log`);
      } else {
        logger.error("   journalctl --user -u 3router -n 20");
      }
      process.exit(1);
    });
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0] || "serve";

if ((command === "start" || command === "stop") && !isMacOS() && !isLinux()) {
  logger.error("错误: daemon 模式仅支持 macOS 和 Linux");
  process.exit(1);
}

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
    logger.error(`未知命令: ${command}`);
    logger.error(`可用命令: serve, start, stop, status`);
    process.exit(1);
}
