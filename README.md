# 3router

> 本地 Claude Code API 智能路由代理 —— 一套配置、按消息内容智能分流，把请求路由到最合适的上游/模型。

在本地（`http://localhost:9191`）启动一个兼容 Anthropic API 的代理，根据请求内容（是否含图片、文本等）匹配路由规则，将请求分发到不同上游服务和模型。在 Claude Code 中只需把 `ANTHROPIC_BASE_URL` 指向它即可无缝接入。

## ✨ 特性

- **智能路由** — 按消息内容（`has_image` 含图片 / `default` 默认）与优先级匹配规则，将请求路由到不同上游/模型
- **多上游支持** — 统一管理 Anthropic 官方、阿里百炼等多个上游，按场景灵活分流
- **规则引擎** — 优先级 + 条件匹配，声明式定义路由策略
- **系统守护进程** — `start` / `stop` / `status` 一键管理，支持 macOS（launchctl）与 Linux（systemd）开机自启
- **Web 管理面板** — 可视化配置上游、规则与模型（前端开发端口 `5173`，生产与后端同源 `9191`）
- **流式透传** — 原生支持 SSE 流式响应，不阻塞 Claude Code 的实时输出
- **图片上下文保留** — 智能缓存图片内容，避免多轮对话丢失视觉上下文

## npm 全局安装

```bash
npm install -g 3router
```

首次运行会自动在 `~/.3router/` 初始化配置文件：

```bash
3router            # 启动代理（首次运行自动生成 ~/.3router/config.json）
```

编辑 `~/.3router/config.json` 填入上游 API 密钥，然后在 Claude Code 中设置 `ANTHROPIC_BASE_URL=http://localhost:9191`。

> 💡 可用 `THREEROUTER_HOME` 环境变量自定义配置目录；开机自启见 [系统服务](#系统服务守护进程)。

## 快速开始

只需 Node.js `>= 20`，无需 Bun。

```bash
pnpm install
cp config.example.json config.json
# 在 config.json 中填入你的 API 密钥
pnpm build        # 构建（产出 Node 兼容的 dist/）
pnpm start        # 用 Node 启动生产服务
```

在 Claude Code 配置中设置 `ANTHROPIC_BASE_URL=http://localhost:9191`。

## 生产环境

```bash
pnpm build
pnpm start
```

所有服务统一在 http://localhost:9191 上提供。

## 路由规则

- **has_image**：包含图片内容块的消息
- **default**：其他所有消息（纯文本、助手消息）

规则按优先级匹配（数字越小，优先级越高）。

## 系统服务（守护进程）

安装后可直接使用 `3router` 命令管理本地服务（仅 macOS / Linux）：

| 命令 | 说明 |
|------|------|
| `3router serve` | 前台启动代理服务器（默认） |
| `3router start` | 注册并启动为系统服务（macOS 走 `launchctl`，Linux 走 `systemd`），开机自启 |
| `3router stop` | 停止系统服务 |
| `3router status` | 查看服务运行状态 |

> 💡 开机自启后，Claude Code 随时可用，无需手动保持终端运行。
