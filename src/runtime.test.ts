import { describe, expect, it } from "bun:test";
import { buildRuntimeCommand } from "./runtime";

describe("buildRuntimeCommand", () => {
  it("编译二进制（$bunfs 入口）：返回 [execPath, action]", () => {
    expect(
      buildRuntimeCommand({ execPath: "/usr/local/bin/3router", cliEntry: "$bunfs/src/cli.ts" }, "serve"),
    ).toEqual(["/usr/local/bin/3router", "serve"]);
  });

  it("开发模式（bun run 入口）：返回 [execPath, run, entry, action]", () => {
    expect(
      buildRuntimeCommand({ execPath: "/usr/bin/bun", cliEntry: "/proj/src/cli.ts" }, "serve"),
    ).toEqual(["/usr/bin/bun", "run", "/proj/src/cli.ts", "serve"]);
  });

  it("action 透传（start）", () => {
    expect(
      buildRuntimeCommand({ execPath: "/usr/bin/bun", cliEntry: "/proj/src/cli.ts" }, "start"),
    ).toEqual(["/usr/bin/bun", "run", "/proj/src/cli.ts", "start"]);
  });
});
