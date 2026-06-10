# 3router CLI + NPM Package + Daemon Design

## Overview

将 3router 从本地开发项目转变为可全局安装的 npm 包，提供 `3router` CLI 命令，支持通过平台原生服务管理（launchd/systemd）实现 daemon 后台运行。

## Goals

- 用户可通过 `npm install -g 3router` 全局安装
- 提供 `3router` CLI 命令，支持前台和 daemon 两种运行模式
- Daemon 使用平台原生服务管理，支持开机自启和崩溃重启
- 无需安装 Bun 运行时，编译产物用 Node.js 即可运行

## Non-Goals

- 不引入 pm2 等第三方进程管理
- 不支持 Windows 服务（后续按需添加）
- 不做自动更新机制

## Architecture

### Package Structure

```
3router/                          # npm 包根目录
├── bin/
│   └── 3router                   # #!/usr/bin/env node shebang 入口
├── dist-node/                    # bun build --target=node 编译产物
│   ├── server.js                 # HTTP 服务器
│   └── cli.js                    # CLI 命令路由
├── dist-web/                     # web 前端构建产物（从 web/dist 复制）
│   ├── index.html
│   └── assets/
├── services/
│   ├── launchd.plist.tmpl        # macOS launchd plist 模板
│   └── systemd.service.tmpl      # Linux systemd user service 模板
├── config.example.json
└── package.json
```

### Build Pipeline

1. `cd web && pnpm build` → `web/dist/`
2. `bun build src/server.ts src/cli.ts --target=node --outdir=dist-node/`
3. 复制 `web/dist/` → `dist-web/`
4. `npm publish`

### CLI Commands

| Command | Description |
|---------|-------------|
| `3router` | 前台启动服务器（等同 `3router serve`） |
| `3router serve` | 前台启动服务器 |
| `3router start` | 注册平台服务并启动 daemon |
| `3router stop` | 停止并卸载平台服务 |
| `3router status` | 显示运行状态、端口、PID、日志路径 |

### Daemon Management

#### macOS (launchd)

- Plist 路径：`~/Library/LaunchAgents/com.3router.plist`
- 命令：`launchctl load` / `launchctl unload`
- 特性：开机自启（`RunAtLoad: true`）、崩溃重启（`KeepAlive: true`）
- 日志：`~/.3router/logs/stdout.log`、`~/.3router/logs/stderr.log`

#### Linux (systemd user)

- Service 路径：`~/.config/systemd/user/3router.service`
- 命令：`systemctl --user start/stop/enable/disable 3router`
- 特性：`Restart=on-failure`、`WantedBy=default.target`
- 日志：`journalctl --user -u 3router`

### Configuration

- 配置文件路径：`~/.3router/config.json`
- 首次运行时检测配置文件是否存在，不存在则从 `config.example.json` 复制默认模板并提示用户编辑
- 服务模板中的路径变量在 `start` 时动态替换（`{{BIN_PATH}}`、`{{CONFIG_PATH}}`、`{{LOG_DIR}}` 等）

### Status Output

```
3router v0.2.0
Status: running (PID 12345)
Port: 9191
Config: ~/.3router/config.json
Logs: ~/.3router/logs/
Uptime: 3h 22m
```

## Implementation Notes

- `bin/3router` 仅做最小化参数解析，路由到 `dist-node/cli.js`
- `cli.js` 内嵌服务模板字符串，不依赖外部文件读取
- Web 静态资源路径通过 `__dirname` 相对定位，兼容全局安装后的目录结构
- Node.js 最低版本要求：18+
