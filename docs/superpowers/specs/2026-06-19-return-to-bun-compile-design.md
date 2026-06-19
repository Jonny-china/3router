# 设计：回到 Bun + 日志系统 + `--compile` 多平台分发（方案 B）

**日期**：2026-06-19
**状态**：待 review
**作者**：Jonny Chen

## 背景与动机

### 流式断连 bug 的根因指向 node:http 转换链
当前 `3router` 用 `bun run src/cli.ts serve` 跑（前台），经 `localhost:9191` 代理 Claude Code 请求到上游（阿里云百炼 token-plan）。使用中反复出现 `Connection closed mid-response`（长响应中断）。

systematic-debugging Phase 1 调查发现：
- 代码无显式超时 / AbortSignal
- `proxy.ts` 透传 `fetch(upstreamRes.body)`，`server.ts` 用 `Readable.fromWeb(body).pipe(res)` 转发——**这条 `node:http` → web stream → node stream 的转换链是主要嫌疑点**
- 关键证据：commit `755d9b3`（Bun→Node 迁移）自曝「修复流式响应中客户端断开导致 Promise 永久挂起的 bug」——证明 `node:http` 路径历来有流式稳定性问题

### 用户诉求
1. 回到 Bun（`Bun.serve` 用原生 web stream，去掉转换链，根治流式 bug）
2. 完整日志系统（落盘 + 诊断埋点，定位未来问题）
3. `--compile` 成 standalone 二进制（零依赖部署）
4. **保留 `npm i -g 3router` 安装方式**（不放弃 npm 生态）

## 目标

| 目标 | 方案 |
|---|---|
| 根治流式断连 | `Bun.serve` 替换 `node:http`，删 `~80 行` 转换层 |
| 完整日志 | consola + 文件 reporter + 诊断埋点 + 按大小轮转 |
| 零依赖二进制 | `bun build --compile` 多平台 |
| npm 安装可用 | **方案 B：npm 主包 + 平台子包**（esbuild 风格），仓库保持私有 |

## 架构总览

```
代码层：    Bun.serve（原生流式）+ consola logger
构建层：    bun build --compile --target=<platform>（矩阵：mac/linux/windows × arm64/x64）
分发层：    npm 主包(3router) + 平台子包(@3router/*) + GitHub Release 备份
CI 层：     release.yml — 构建矩阵 → 发平台子包 → 发主包 → 上传 Release
```

---

## A. 代码回切 Bun.serve

### A1. `src/server.ts`（核心重写）
- `createServer` + `incomingToRequest`（Node req → web Request）+ `sendResponse`（含 `Readable.fromWeb().pipe(res)`）**整段删除**——这是断连 bug 的主要嫌疑点
- 改用 `Bun.serve({ port, hostname: "0.0.0.0", fetch, static })`：
  - `fetch(req)`：`/v1/` → `buildProxyHandler()(req)`，`/api/` → `handleApiRoute(req)`，其余 → 静态资源
  - `static`：预映射 `dist-web`（前端构建产物，embed 后用 `Bun.file`）
- 返回值直接是 web `Response`，**原生流式，无转换层**

### A2. `src/proxy.ts`（基本不动）
- handler 已返回 web `Response`，Bun.serve 直接透传
- 保留：fetch 转发、`buildUpstreamRequest`、路由匹配、image cache tee 逻辑
- 加诊断埋点（见 B2）

### A3. `src/config.ts` + 静态资源
- `fs/promises` → `Bun.file` / `Bun.write`（配置读写、静态资源响应）
- `config.example.json` + `dist-web/` 通过 `--compile` 的 import attribute embed 进二进制
- `config.json`（用户实际配置）仍从 `~/.3router/` 读，首次运行从 embed 的 example 复制

### A4. `src/cli.ts`（daemon 管理）
- `node:child_process` 的 `execSync`（launchctl/systemd）**保留**（Bun 兼容）
- daemon 的 `serveCmd`：从 `node dist/cli.js serve` → **二进制直接 `3router serve`**
- plist/systemd 的 `ExecStart` 指向已安装的二进制路径（shim 解析后的平台子包二进制）
- `bin/3router` 运行时探测（bun/node fallback）**删除**——统一 Bun

---

## B. 日志系统：consola

### B1. `src/logger.ts`（新建）
- `consola` 实例 + 自定义 file reporter（写 `~/.3router/logs/3router.log`，JSON 行）
- 级别：`LOG_LEVEL` 环境变量控制（默认 info=4，可开 debug=5）
- 复用现有 `getLogsDir()` = `~/.3router/logs/`

### B2. 诊断埋点（完整诊断级，每请求一条带 `requestId` 的事件链）

| 事件 | 字段 | 诊断价值 |
|---|---|---|
| `request.start` | method, path, 匹配 upstream+model, requestId | 请求来了、路由到哪 |
| `upstream.fetch` | 耗时, status, content-type(stream?) | 上游响应是否正常 |
| **`stream.end`** | 字节数, **结束原因(done\|error\|abort)**, 耗时 | **断连核心证据** |
| `client.disconnect` | 时机 | 客户端是否中途断开 |
| `proxy.error` | 错误 + 堆栈 | 错误诊断 |

`stream.end` 结束原因通过 Bun.serve 的 `Response.body` 流的 done/error 事件捕获。

### B3. 落盘 + 按大小轮转（之前选定）
- consola 无内置轮转，用 ~30 行自写逻辑：写入前检查文件大小，>10MB 时滚动 `.log`→`.1`→`.2`...保留 5 个（50MB 上限）
- 格式：文件 JSON（机器可读 + grep），控制台 consola 默认美化

### B4. 替换现有 `console.log/error`
- 覆盖 `server.ts`（启动/配置）、`proxy.ts`（请求/流式/错误）、`config.ts`（配置加载）、`cli.ts`（daemon 生命周期）共 20+ 处

---

## C. 构建与分发：方案 B（平台子包，esbuild 风格）

### C1. npm 包结构
```
3router (主包)                          ← 用户安装这个
├── package.json (bin → shim, optionalDependencies 列所有平台子包)
├── bin/3router (shim: 定位平台子包二进制并 spawn 执行)
└── install.js (postinstall 校验二进制存在)

@3router/darwin-arm64                   ← 平台子包（各含一个 --compile 二进制）
@3router/darwin-x64
@3router/linux-x64
@3router/linux-arm64
@3router/win32-x64
└── 3router (二进制, ~59MB)
```
npm 安装时按 `process.platform` + `process.arch` 自动只装一个平台子包（`optionalDependencies` + `os`/`cpu` 字段）。

### C2. shim 逻辑（`bin/3router`）
```js
const platform = `${process.platform}-${process.arch}`;     // darwin-arm64
const pkg = `@3router/${platform}`;
const binPath = require.resolve(`${pkg}/3router`);           // 子包二进制路径
spawn(binPath, process.argv.slice(2), { stdio: "inherit" });  // 透传参数
```

### C3. 构建命令
```bash
# 每个平台一个（CI matrix）
bun build src/cli.ts --compile --minify --sourcemap \
  --target=bun-darwin-arm64 --outfile packages/darwin-arm64/3router
```

### C4. 命名（scope 决策，待定）
- **推荐 `@3router/*`**（scope，esbuild/sharp 风格，干净）——需在 npm 创建 `3router` organization
- 备选：无 scope（`3router-darwin-arm64`，不需 org，但冗长）
- → **需用户决定是否创建 npm org**

---

## D. CI：`release.yml` 重写

从「OIDC 发单个 npm 包」改为「多平台矩阵构建 + 发多个 npm 包 + 上传 Release」：

```yaml
on: { release: { types: [published] } }
permissions: { contents: write, id-token: write }

jobs:
  build:
    strategy:
      matrix:
        include:
          - { target: bun-darwin-arm64, pkg: "@3router/darwin-arm64" }
          - { target: bun-darwin-x64,   pkg: "@3router/darwin-x64" }
          - { target: bun-linux-x64,    pkg: "@3router/linux-x64" }
          - { target: bun-linux-arm64,  pkg: "@3router/linux-arm64" }
          - { target: bun-windows-x64,  pkg: "@3router/win32-x64" }
    steps:
      - checkout + version from tag
      - setup bun + pnpm
      - build web (dist-web) + embed
      - bun build --compile --target=$target → packages/<platform>/3router
      - 压缩 + 上传到 GitHub Release
      - 发布平台子包到 npm（OIDC，每个子包独立 trusted publisher 配置）

  publish-main:
    needs: build
    steps:
      - 发布主包 3router（含 shim，optionalDependencies 指向已发布的子包版本）
```

**OIDC 配置复杂度**：主包 + 5 个子包 = 6 个 npm 包，每个都要配 trusted publisher（GitHub org/repo/workflow filename 一致即可，filename 都是 release.yml）。这是一次性配置成本。

---

## E. 其他

- **配置**：`~/.3router/config.json` 逻辑不变；`THREEROUTER_HOME` 自定义路径保留
- **测试**：`bun test` 保留；server smoke 测试改用 Bun.serve；新增 logger 测试（级别、轮转）
- **现有 npm 包 `3router@0.2.x`**：保留只读 + 发 `npm deprecate 3router@"<0.3.0" "迁移到二进制分发，见 README"` 引导
- **文档**：README 安装方式重写（`npm i -g` 仍可用，底层自动装平台二进制；补充直接下载 Release 的方式）；CONTRIBUTING 开发流程（dev 仍 `bun run dev`）
- **CLI 子命令**：`3router serve / start / stop / status` 不变

---

## 待定 / 风险

| 项 | 说明 | 默认建议 |
|---|---|---|
| **npm scope** | `@3router/*` 需创建 npm org；否则无 scope | 创建 org（推荐） |
| **consola 在 Bun 下实测** | 训练知识判断流行，落地前实测；不稳则 fallback 自建轻量 logger | 先实测 |
| **二进制体积 ~59MB/平台** | Bun runtime 是大头，minify 压不动 | 接受（esbuild 同量级） |
| **trusted publisher 多包配置** | 6 个包逐个配 OIDC | 一次性成本 |
| **Windows 支持** | 现在做 5 平台（含 win-x64）还是先 4 平台 | 5 平台（matrix 一次配好） |
| **dist-web embed vs 外部** | embed 进二进制（单文件，换前端要重编译）vs 外部目录（可热更） | embed（真·单文件） |

---

## 实施顺序（writing-plans 会细化为可执行步骤）

1. **代码回切**：server.ts → Bun.serve（删转换层），config/fs → Bun.file，验证流式断连是否消失
2. **日志系统**：logger.ts（consola）+ 埋点 + 轮转，替换 console
3. **构建**：package.json 改造，bun build --compile 脚本（单平台先跑通）
4. **分发**：npm 主包 + 平台子包结构、shim、scope org 创建
5. **CI**：release.yml 矩阵重写，OIDC 多包配置
6. **收尾**：deprecate 旧 npm 包、文档更新、5 平台验证

## 成功标准

- [ ] `bun run dev` 用 Bun.serve，长响应不再断连（实测 Claude Code 经 3router 长对话稳定）
- [ ] 日志落盘 `~/.3router/logs/`，断连时 `stream.end` 记录结束原因
- [ ] `npm i -g 3router` 在 mac/linux/windows 自动装对应平台二进制，`3router serve` 零依赖启动
- [ ] `bun build --compile` 产出 5 平台二进制，GitHub Release 上传成功
- [ ] CI release.yml 矩阵构建 + 多包发布全绿
