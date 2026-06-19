import { homedir } from "node:os";
import { join } from "node:path";

/** 项目数据根目录，可用 THREEROUTER_HOME 环境变量自定义 */
export function getBasePath(): string {
  return process.env.THREEROUTER_HOME || join(homedir(), ".3router");
}

/** 日志目录 */
export function getLogsDir(): string {
  return join(getBasePath(), "logs");
}

/** 用户配置文件路径 */
export function getConfigPath(): string {
  return join(getBasePath(), "config.json");
}
