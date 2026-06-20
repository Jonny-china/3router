# 贡献指南

感谢你对 3router 的关注！欢迎提交 Issue、Pull Request 或参与讨论。本文说明本地开发流程与代码规范。

## 环境要求

- [Bun](https://bun.sh/) —— **开发必需**：热重载源码（`bun run dev`）、运行测试（`bun test`）、编译二进制（`bun build --compile`）
- [pnpm](https://pnpm.io/) —— 依赖管理与 Web 前端构建
- [Node.js](https://nodejs.org/) `>= 20` —— 发布后的 shim 入口（`bin/3router`）与 CI OIDC 发布需要

## 本地开发

```bash
git clone git@github.com:Jonny-china/3router.git
cd 3router
pnpm install
cd web && pnpm install && cd ..   # 安装前端依赖

cp config.example.json config.json   # 复制配置模板（首次）
# 在 config.json 中填入你的 API 密钥（请勿提交真实密钥）
```

启动开发（热重载）：

```bash
bun run dev            # 终端 1：后端（bun run --watch src/cli.ts serve）
cd web && pnpm dev     # 终端 2：前端（vite，5173）
```

前端 `http://localhost:5173` 会将 `/api`、`/v1` 代理到后端。在 Claude Code 中设置 `ANTHROPIC_BASE_URL=http://localhost:9191` 即可接入本地代理。

## 构建二进制

```bash
pnpm build        # 构建前端（单文件化）+ 编译当前平台二进制到 packages/<platform>/3router
```

产出独立可执行文件（含 embed 的 config 模板 + 前端 SPA），可在无 Node/Bun 环境运行。详见 [packages/README.md](packages/README.md)。

交叉编译指定平台：

```bash
bun run build:compile -- --target=bun-linux-x64
```

## 代码质量门禁

提交前请确保以下检查全部通过（CI 会强制执行）：

| 检查项 | 命令 | 说明 |
|--------|------|------|
| Lint | `pnpm lint` | 运行 oxlint（`src/` 与 `web/src/`） |
| 格式化 | `pnpm format` | 使用 oxfmt 统一代码风格 |
| 格式校验 | `pnpm format:check` | 仅检查不修改 |
| 类型检查 | `pnpm typecheck` | TypeScript 静态检查（`tsc --noEmit`） |
| 测试 | `pnpm test` | 运行 Bun 测试套件 |

> 建议在编辑器中保存时自动运行 lint/format，避免在 PR 阶段返工。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式，描述用中文或英文均可：

```
<type>: <description>

<可选 body>
```

常用 type：

| type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 Bug |
| `refactor` | 重构（不改变行为） |
| `perf` | 性能优化 |
| `docs` | 文档变更 |
| `test` | 新增/修改测试 |
| `chore` | 构建、工具、依赖等杂项 |
| `ci` | CI 配置变更 |

示例：

```
feat: 支持按 token 数量的路由条件
fix: 修复流式响应在多 upstream 下的截断问题
docs: 补充守护进程部署示例
```

## Pull Request 流程

1. 从 `main` 切出新分支：`feat/<简述>`、`fix/<简述>` 等
2. 保持每个 PR 聚焦单一目的，便于 Review
3. 确保本地质量门禁全部通过
4. 如涉及新功能，请补充对应的测试
5. 在 PR 描述中说明改动动机与影响范围
6. 等待 Review，根据反馈迭代

## 安全须知

- **永远不要提交真实的 API 密钥。** `config.json` 已在 `.gitignore` 中忽略，请使用 `config.example.json` 作为模板
- 如发现安全漏洞，请勿在公开 Issue 中讨论，私下联系维护者
- 提交前确认 `git diff` 不包含任何 `apiKey`、`token`、`.env` 等敏感内容

## 项目结构

```
3router/
├── src/                      # 后端（TypeScript，Bun.serve + consola 日志）
│   ├── cli.ts                # CLI 入口与守护进程命令
│   ├── server.ts             # Bun.serve HTTP 服务器 + 静态资源（embeddedFiles）
│   ├── proxy.ts              # 代理核心 + 流式诊断埋点（stream.end）
│   ├── router.ts             # 路由规则匹配
│   ├── config.ts             # 配置加载（模板 import attribute embed）
│   ├── logger.ts             # consola 日志 + 落盘轮转
│   ├── paths.ts              # 路径解析（~/.3router）
│   └── ...
├── web/                      # 前端管理面板（React + Vite，单文件构建）
├── bin/3router               # npm 入口 shim（定位平台子包二进制并 spawn）
├── install.js                # postinstall 校验二进制
├── scripts/build-compile.ts  # 多平台 --compile 编译脚本
├── packages/                 # 平台子包（@3router/<platform>，各含一个二进制）
└── docs/superpowers/         # 设计文档与实施计划
```

再次感谢你的贡献！🎉
