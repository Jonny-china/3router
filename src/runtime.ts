/** 运行时与启动命令构造。从 cli.ts 抽出以便单测（cli.ts 是带副作用的入口脚本，不可直接 import）。 */

export interface RuntimeInfo {
  execPath: string;
  cliEntry: string;
}

/**
 * 构造服务启动命令。
 * - 编译二进制（bun build --compile）：入口即自身可执行文件，直接执行即可，无 run 子命令。
 *   编译后 import.meta.url 为 "$bunfs/..." 虚拟路径，无法用 bun run 重新加载，也无法作为 argv 解析，
 *   靠 $bunfs 标志识别编译态。
 * - 开发模式（bun run）：`bun run <entry> <action>`。
 */
export function buildRuntimeCommand(runtime: RuntimeInfo, action: string): string[] {
  if (runtime.cliEntry.includes("$bunfs")) {
    return [runtime.execPath, action];
  }
  return [runtime.execPath, "run", runtime.cliEntry, action];
}
