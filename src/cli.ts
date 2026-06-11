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
