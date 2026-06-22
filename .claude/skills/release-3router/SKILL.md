---
name: release-3router
description: 发布 3router 新版本到 npm + GitHub Release 的完整流程，含发布前预检、已知坑库、CI 监控与发布后验证。当用户要求发布、发版、打 release、publish 新版本、升版本号、出 0.x.x 时使用此 skill——即使是看似简单的发版，也务必先过预检清单，避免重蹈 lockfile 未同步、子包缺 repository 致 npm provenance E422、回写 main non-fast-forward 等已知坑。仅适用于 3router 项目（bun build --compile 多平台二进制 + optionalDependencies 方案 B 分发架构）。
---

# 发布 3router 新版本

3router 采用「创建 GitHub Release vX.Y.Z → 触发 `.github/workflows/release.yml` 自动构建发布」模式。CI 从 tag 提取版本号，自动写入 package.json + 同步 optionalDependencies，构建 5 平台二进制，发布主包 `3router` + 5 个 `@3router/*` 子包到 npm（OIDC trusted publisher），并回写版本号到 main。

**版本号无需手动改 package.json**（CI 会写），但发布前必须确认代码、lockfile、子包元数据都经得起 CI 的严格检查——这正是历次发版踩坑的地方。

## 为什么有这个 skill

发布多次踩坑，共性是「本地预演能过但 CI 暴露」或「手动发能过但 CI 暴露」：

- lockfile 未同步 → CI `--frozen-lockfile` 失败（0.2.2）
- 子包缺 `repository` → npm OIDC provenance E422（0.2.3 首次暴露）
- publish-main 回写 main non-fast-forward（0.2.3 修复）
- 编译先于根 version bump → 二进制内联旧版本号，`npx 3router` 报旧版本（0.2.3 暴露）
- CI 发版回写 package.json 但不同步 lockfile → 每次发版后 lockfile 落后，下次预检 frozen 失败（0.2.4 重现，坑 1 的结构性根因）

本 skill 把预检清单和坑库固化下来。**发布前务必读完 `references/known-pitfalls.md`**——里面有每个坑的根因、为何本地没暴露、修复方式，以及本地预演的根本盲区。

## 发布流程

### 0. 前置确认

- 在 main 分支且工作树干净（`git status` clean）
- 本地与远程 main 同步（`git fetch origin main && git status`，不领先/落后）
- 确认版本号跳跃合理，对应改动已合入 main
- 列出新版内容用于写 release notes：
  ```bash
  git log v<上一版>..HEAD --oneline   # 例：git log v0.2.3..HEAD --oneline
  ```

### 1. 发布前预检（本地预演 CI 关键步骤）

**这是最关键的一步**——本地把 CI 会跑的步骤全跑一遍，能在触发 CI 前拦截大部分失败。逐项执行，任一失败则先修再发。

构建链路预演（与 release.yml build job 一致）：
```bash
pnpm install --frozen-lockfile --no-optional          # CI build job 用 --no-optional
(cd web && pnpm install --frozen-lockfile)            # web 依赖
pnpm build:web && pnpm build:copy-web                 # 前端单文件化
bun scripts/build-compile.ts --target=bun-darwin-arm64 # 编译当前平台验证（不编全平台，省时）
pnpm typecheck                                        # prepublishOnly 调用
```

已知坑专项核对（详见 `references/known-pitfalls.md`）：
- [ ] 若改过 package.json 依赖字段，已 `pnpm install --lockfile-only` 同步 lockfile，且上面 `--frozen-lockfile` 通过
- [ ] 每次发版前 `pnpm install --lockfile-only` 同步 lockfile 并提交（坑 5：CI 发版回写 package.json 但不回写 lockfile，结构性落后）
- [ ] 5 个子包 `packages/*/package.json` 都有 `repository` 字段，url = `git+https://github.com/Jonny-china/3router.git`
- [ ] release.yml publish-main 回写步骤含 `git pull --rebase origin main`（已修，确认未回退即可）
- [ ] release.yml build job「编译二进制」前有「写主包版本号」步骤（坑 4，防 `--compile` 二进制内联旧版本号）

预演产生的二进制（`packages/*/3router`）被 .gitignore 忽略，不影响工作树；可 `rm -f packages/*/3router packages/*/3router.exe` 清理。

### 2. 触发发布

```bash
gh release create vX.Y.Z \
  --target <commit-sha> \
  --title "X.Y.Z" \
  --notes "..."   # 基于 git log v<上一版>..HEAD 撰写
```

- tag 必须是 `vX.Y.Z` 格式（release.yml 会校验，非法直接 fail）
- target 指向要发布的 commit（通常 main HEAD）
- 创建 Release 即触发 CI（`on: release: published`），无需单独打 tag

### 3. 监控 CI

CI 跑 build（5 平台矩阵）+ publish-main，约 2-4 分钟。后台监控到终态（覆盖 success/failure/cancelled/timed_out 全部终态，避免 silent on crash）：
```bash
RUN=$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
# 轮询 .status 到 completed
```

**失败时不要猜——读日志定位**（systematic-debugging）：
```bash
gh run view $RUN --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {name, databaseId}'
gh run view --job <job-id> --log-failed | tail -40
```
按失败步骤查 `references/known-pitfalls.md` 的「失败定位速查」表。

### 4. 发布后验证（evidence-based，不能只凭 CI success）

```bash
# 1. Release 资产（应有 5 个平台二进制：darwin/linux tar.gz + win32 zip）
gh release view vX.Y.Z --json assets --jq '.assets[].name'
# 2. main 回写 commit（应有 bot 的 chore: release X.Y.Z [skip ci]）
git fetch origin main -q && git log origin/main --oneline -3
# 3. npm 主包 + 5 子包（registry 同步可能延迟几十秒，必要时轮询等待）
npm view 3router@X.Y.Z version
for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do npm view @3router/$p@X.Y.Z version; done
```

最后 `git pull origin main --rebase` 同步本地（CI 回写了版本号到 package.json + optionalDependencies）。

## 手动发布 fallback（下策）

仅当 CI 反复失败且无法及时修复时才用（0.2.2 当时就因 CI 失败手动发）。手动发布绕过 CI 自动化、不触发 provenance（会掩盖子包 repository 类问题）、不验证 workflow，是退路而非正路——先尽力修 CI。步骤见 `references/known-pitfalls.md`「手动发布 fallback」。

## 关键提醒

- 0.2.2 是手动发的，GitHub 上**没有 v0.2.2 Release**——不要据此判断流程是否正常
- 每个待发布的 npm 包（主包 + 全部子包）都必须有匹配 GitHub 仓库的 `repository.url`，否则 CI OIDC provenance 必失败
- 改过 package.json 的依赖字段，必须同步 `pnpm-lock.yaml`
- 本地预演有根本盲区：能验证 build/compile，**无法验证 npm publish provenance**（需 CI OIDC 环境）——所以预检清单是补盲区的唯一手段

详细坑库与根因分析见 `references/known-pitfalls.md`。
