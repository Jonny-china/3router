# 3router CLI + NPM Package + Daemon Design

## Overview

将 3router 从本地开发项目转变为可全局安装的 npm 包，提供 `3router` CLI 命令，支持通过平台原生服务管理（launchd/systemd）实现 daemon 后台运行。

## Goals

- 用户可通过 `npm install -g 3router` 全局安装（需预装 Bun 运行时）
- 提供 `3router` CLI 命令，支持前台和 daemon 两种运行模式
- Daemon 使用平台原生服务管理，支持开机自启和崩溃重启
- 保持 Bun 运行时，不编译为 Node.js

## Non-Goals

- 不引入 pm2 等第三方进程管理
- 不支持 Windows 服务（后续按需添加）
- 不支持容器部署（s6-overlay 等）
- 不支持多实例 / profiles
- 不做自动更新机制
- 不做优雅重启（graceful drain）
- 不做应用层日志轮转

## Architecture

### 运行时与分发

- **运行时**：Bun。service 文件中直接调用 `bun run`，不做编译
- **分发**：npm 发布。`bin/3router` 入口检测 Bun 是否已安装，未安装则打印安装提示并退出
- **前置检测**：CLI 入口首先执行 Bun 可用性检查，失败时给出明确的 `curl -fsSL https://bun.sh/install | bash` 安装指引

### Package Structure

```
3router/                          # npm 包根目录
├── bin/
│   └── 3router                   # #!/usr/bin/env node shebang 入口（Bun 检测 + 路由到 CLI）
├── src/
│   ├── server.ts                 # HTTP 服务器（前台 + daemon 共用入口）
│   └── cli.ts                    # CLI 命令路由
├── dist-web/                     # web 前端构建产物（从 web/dist 复制）
│   ├── index.html
│   └── assets/
├── config.example.json
└── package.json
```

> 无 `dist-node/` 编译产物目录——保持 Bun 直接运行 TypeScript 源码。
> 无 `services/` 模板目录——service 文件内容内嵌在 `cli.ts` 中，`start` 时动态生成。

### Build Pipeline

1. `cd web && pnpm build` → `web/dist/`
2. 复制 `web/dist/` → `dist-web/`
3. `npm publish`

> 后端无编译步骤。Bun 直接执行 `src/server.ts` 和 `src/cli.ts`。

### CLI Commands

| Command | Description |
|---------|-------------|
| `3router` | 前台启动服务器（等同 `3router serve`） |
| `3router serve` | 前台启动服务器 |
| `3router start` | 生成 service 文件 + 注册平台服务 + 启动 daemon（一步到位） |
| `3router stop` | 停止服务 + 卸载平台服务 + 删除 service 文件（一步到位） |
| `3router status` | 显示运行状态、端口、PID、配置路径、日志路径 |

### Daemon Management

#### 核心设计原则

- **单实例**：一个 3router 进程、一份配置、一个端口。端口即互斥锁
- **统一入口**：`serve` 是前台运行命令，service 文件中也调用 `serve`。开发和 daemon 共用同一条执行路径
- **进程互斥**：端口探测优先——启动前检查目标端口是否被占用，已占用则报错退出
- **停机策略**：直接 SIGTERM，不做 drain。launchd/systemd 的 KeepAlive/Restart 保证服务自动恢复。SSE 流断开后客户端会重连
- **重启验证**：start/restart 后轮询端口（最长 15s），确认服务已启动。超时则报错

#### 幂等性

- `start`：检测到服务已运行 → 打印 `"3router is already running (PID 12345)"` 并退出，不重复安装
- `stop`：检测到服务未运行 → 打印 `"3router is not running"` 并退出
- `start`：检测到已安装但未运行 → 直接启动，不重新生成 service 文件

#### macOS (launchd)

- **Label**：`com.3router.daemon`
- **Plist 路径**：`~/Library/LaunchAgents/com.3router.daemon.plist`
- **操作命令**：
  - 注册：`launchctl bootstrap gui/{uid} {plistPath}`
  - 启动：`launchctl kickstart gui/{uid}/com.3router.daemon`
  - 停止：`launchctl bootout gui/{uid}/com.3router.daemon`
- **Plist 属性**：
  - `RunAtLoad: true` — 开机自启
  - `KeepAlive: true` — 崩溃自动重启
  - `ThrottleInterval: 1` — 最小重启间隔
  - `ProgramArguments: ["bun", "run", "{serverPath}", "serve"]`
  - `StandardOutPath: ~/.3router/logs/stdout.log`
  - `StandardErrorPath: ~/.3router/logs/stderr.log`
  - `EnvironmentVariables: { "HOME": "~" }`

#### Linux (systemd user)

- **Unit 名称**：`3router.service`
- **Unit 路径**：`~/.config/systemd/user/3router.service`
- **操作命令**：
  - 安装：`systemctl --user daemon-reload && systemctl --user enable 3router && systemctl --user start 3router`
  - 停止：`systemctl --user stop 3router && systemctl --user disable 3router`
- **Unit 属性**：
  - `Type=simple`
  - `Restart=on-failure`
  - `RestartSec=3`
  - `ExecStart=bun run {serverPath} serve`
  - `WantedBy=default.target`
- **日志**：`journalctl --user -u 3router`

### Configuration

- **配置文件路径**：`~/.3router/config.json`
- **初始化策略**：首次 `start` 时检测配置文件是否存在
  - 不存在 → 从内嵌的 `config.example.json` 模板生成默认配置到 `~/.3router/config.json`
  - 打印提示：`"Config initialized at ~/.3router/config.json — please edit to add your API key"`
  - 已存在 → 直接使用，不覆盖
- **Service 文件中的路径**：`start` 时动态解析 `bun` 路径和 `server.ts` 路径，写入 service 文件，不使用模板变量

### Status Output

```
3router v0.2.0
Status: running (PID 12345)
Port:   9191
Config: ~/.3router/config.json
Logs:   ~/.3router/logs/
```

停止时：

```
3router v0.2.0
Status: stopped
Config: ~/.3router/config.json
```

### 日志策略

- **macOS**：launchd 的 `StandardOutPath` / `StandardErrorPath` 写入 `~/.3router/logs/`
- **Linux**：systemd journal，通过 `journalctl --user -u 3router` 查看
- **不做应用层轮转**：依赖操作系统的 logrotate 或用户手动管理

## Implementation Notes

- `bin/3router` 做 Bun 前置检测 + 最小化参数解析，路由到 `src/cli.ts`
- `cli.ts` 内嵌 service 文件模板字符串（launchd plist XML + systemd unit 格式），不依赖外部模板文件
- Web 静态资源路径通过 `__dirname` 相对定位，兼容全局安装后的目录结构
- 端口探测用 `net.createServer()` 尝试 bind，失败即端口被占用
- 重启后端口轮询间隔 500ms，最长 15s（30 次尝试）
- Bun 运行时要求：`>= 1.0`
