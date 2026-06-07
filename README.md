# 3router

本地 Claude Code API 代理，支持智能路由 —— 根据消息内容将请求路由到不同的上游服务/模型。

## 快速开始

```bash
pnpm install
cp config.example.json config.json
# 在 config.json 中填入你的 API 密钥
bun run dev
```

在 Claude Code 配置中设置 `ANTHROPIC_BASE_URL=http://localhost:9191`。

## 开发

```bash
# 终端 1：后端
bun run dev

# 终端 2：前端
cd web && pnpm dev
```

前端地址：http://localhost:5173（将 /api 代理到后端）

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

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动后端并监听文件变更 |
| `pnpm build` | 构建前端生产版本 |
| `pnpm start` | 启动生产服务器 |
| `pnpm test` | 运行所有测试 |
| `pnpm lint` | 运行 oxlint |
| `pnpm format` | 使用 oxfmt 格式化代码 |
