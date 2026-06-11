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
