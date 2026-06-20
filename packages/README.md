# packages/ — 平台子包（方案 B 分发）

每个子目录是一个 npm 平台子包（esbuild/sharp 风格），仅含一个 `bun build --compile` 产出的独立二进制：

| 目录 | npm 包名 | 目标 |
|---|---|---|
| `darwin-arm64/` | `@3router/darwin-arm64` | macOS Apple Silicon |
| `darwin-x64/` | `@3router/darwin-x64` | macOS Intel |
| `linux-x64/` | `@3router/linux-x64` | Linux x64 |
| `linux-arm64/` | `@3router/linux-arm64` | Linux arm64 |
| `win32-x64/` | `@3router/win32-x64` | Windows x64 |

## 工作方式

- 主包 `3router` 的 `optionalDependencies` 列出全部 5 个子包；npm 安装时按 `os` + `cpu` 字段**只装匹配当前平台的那一个**。
- 主包 `bin/3router`（shim）运行时 `require.resolve("@3router/<platform>")` 定位二进制并 spawn 执行，透传参数。
- 二进制文件不入库（见 `.gitignore`），由 CI 在发版时 `bun build --compile` 构建并随子包发布。

## 本地构建

```bash
# 当前平台（dev 验证）
bun run build:compile

# 指定平台（CI 用）
bun run build:compile -- --target=bun-darwin-arm64
```

## 请勿单独安装子包

`npm i @3router/darwin-arm64` 单独装没有意义（只是个二进制）。请装主包：

```bash
npm i -g 3router
```
