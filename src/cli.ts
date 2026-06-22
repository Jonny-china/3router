import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 版本号单一来源：编译时经 import attribute（type:"json"）从 package.json 内联进二进制，
// 避免硬编码与 package.json 脱钩（此前 cli.ts "0.2.0" ≠ package.json "0.2.1"）。
import pkg from "../package.json" with { type: "json" };
import { readConfig, initConfig } from "./config";
import { logger } from "./logger";
import { getLogsDir, getConfigPath } from "./paths";
import { buildRuntimeCommand, type RuntimeInfo } from "./runtime";
import { resolveHost, startServer } from "./server";
import {
  LAUNCH_LABEL,
  SYSTEMD_UNIT_NAME,
  generatePlistContent,
  generateSystemdUnitContent,
  isPortInUse,
  waitForPort,
} from "./service";

const VERSION = pkg.version;

// --- Utility ---

// buildRuntimeCommand 与 RuntimeInfo 抽到 ./runtime 便于单测（cli.ts 是带副作用的入口脚本）。
function detectRuntime(): RuntimeInfo {
  // server.ts 硬依赖 Bun（Bun.serve / embeddedFiles），在 Node 下模块加载即失败，
  // 故不再保留 node 兜底分支——运行时只可能是 Bun。
  return {
    execPath: process.execPath,
    cliEntry: fileURLToPath(import.meta.url),
  };
}

// --- Subprocess helpers (Bun-native, 数组 argv 不经 shell) ---

/** 捕获 stdout、忽略 stderr；失败抛错（与原 execSync 行为一致，便于调用方 try/catch）。 */
function captureOutput(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
  if (!result.success) throw new Error(`命令执行失败: ${cmd.join(" ")}`);
  return (result.stdout?.toString() ?? "").trim();
}

/** 继承 stdio（用户可见输出）；不抛错（调用方静默容忍失败）。 */
function runInherit(cmd: string[]): void {
  Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
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
    cachedUid = captureOutput(["id", "-u"]);
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
      const output = captureOutput(["launchctl", "print", `gui/${getUid()}/${LAUNCH_LABEL}`]);
      const match = output.match(/pid = (\d+)/);
      return { running: true, pid: match?.[1] ?? null };
    } catch {
      return { running: false, pid: null };
    }
  }
  if (isLinux()) {
    try {
      const active = captureOutput(["systemctl", "--user", "is-active", "3router"]);
      if (active !== "active") {
        return { running: false, pid: null };
      }
      const pid = captureOutput([
        "systemctl",
        "--user",
        "show",
        "3router",
        "--property=MainPID",
        "--value",
      ]);
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
      const portBusy = await isPortInUse(config.port, resolveHost(config));
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
    runInherit(["launchctl", "bootout", `gui/${uid}/${LAUNCH_LABEL}`]);
    const plistPath = getPlistPath();
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      logger.info(`   已删除: ${plistPath}`);
    }
  } else {
    runInherit(["systemctl", "--user", "stop", "3router"]);
    runInherit(["systemctl", "--user", "disable", "3router"]);
    const unitPath = getSystemdUnitPath();
    if (existsSync(unitPath)) {
      rmSync(unitPath);
      runInherit(["systemctl", "--user", "daemon-reload"]);
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
    // bootstrap 加载 plist，RunAtLoad=true 使 launchd 立即拉起进程，无需再 kickstart。
    // 首次注册时进程尚未运行，kickstart 会触发一次 kill→重启，端口抖动导致
    // verifyStartup 的 waitForPort 在 15s 窗口内误判超时（进程实际已健康启动）。
    // 数组 argv 形态天然解决 plistPath 含空格时的路径转义问题。
    runInherit(["launchctl", "bootstrap", `gui/${uid}`, plistPath]);
  } else {
    runInherit(["systemctl", "--user", "daemon-reload"]);
    runInherit(["systemctl", "--user", "enable", "3router"]);
    runInherit(["systemctl", "--user", "start", "3router"]);
  }
}

function startService(): void {
  if (isMacOS()) {
    const uid = getUid();
    runInherit(["launchctl", "kickstart", `gui/${uid}/${LAUNCH_LABEL}`]);
  } else {
    runInherit(["systemctl", "--user", "start", "3router"]);
  }
}

function verifyStartup(): void {
  let port: number;
  let host: string;
  try {
    const config = readConfig();
    port = config.port;
    host = resolveHost(config);
  } catch {
    logger.error("错误: 无法读取配置文件，跳过启动验证");
    return;
  }

  logger.info("正在验证服务启动...");
  waitForPort(port, 15000, host)
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
