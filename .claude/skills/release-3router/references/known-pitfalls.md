# 3router 发布已知坑库

每次发布前过一遍。每个坑记录：症状、根因、为何本地没暴露、修复、预检、历史。

## 坑 1：pnpm-lock.yaml 未同步

**症状**：CI `pnpm install --frozen-lockfile` 失败，错误含 "lockfile out of date" / "specifiers don't match" / 缺失依赖。

**根因**：改了 package.json 的依赖字段（dependencies/devDependencies/optionalDependencies，包括 optionalDependencies 版本号变更）后没重算 lockfile。CI 用 `--frozen-lockfile` 严格匹配，specifiers 不一致直接失败，不会自动修复。

**为何本地没暴露**：本地 `pnpm install`（无 `--frozen`）会静默更新 lockfile，掩盖了不一致。只有带 `--frozen-lockfile` 才暴露。

**修复**：改完 package.json 依赖后 `pnpm install --lockfile-only` 重算 lockfile，提交 lockfile。

**预检**：`pnpm install --frozen-lockfile --no-optional` 必须通过。

**历史**：0.2.2 同步 package.json（optionalDependencies 0.2.2 + 移除 tsdown）时未更新 lockfile，CI 失败，被迫手动发布。0.2.3 commit `89980e5` 修复。

## 坑 2：子包缺 repository 字段（npm provenance E422）

**症状**：CI「发布平台子包到 npm（OIDC）」步骤失败：
```
npm error 422 - Error verifying sigstore provenance bundle:
Failed to validate repository information: package.json: "repository.url" is "",
expected to match "https://github.com/Jonny-china/3router" from provenance
```
5 个平台 build job 全部失败，publish-main 被 skipped。注意：build/编译/打包/上传 Release 资产全成功，**只有最后 npm publish 子包失败**。

**根因**：npm OIDC 发布启用 sigstore provenance（来源证明），强制每个发布包的 `repository.url` 匹配 provenance 声明的 GitHub 仓库。子包 `packages/*/package.json` 缺 repository 字段 → url 为空 → E422。

**为何本地没暴露**：provenance 验证只在 CI OIDC 发布时发生，本地 `npm publish` 不强制 provenance。这是本地预演的根本盲区。

**为何手动发布没暴露**：手动 `npm publish` 默认不启用 provenance，所以 0.2.2 手动发时子包 repository 缺失被掩盖——坑潜伏到首次走 CI 才爆发。

**修复**：每个子包 package.json 加 repository 字段（url 与主包一致，npm 规范化后匹配 `https://github.com/Jonny-china/3router`）：
```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/Jonny-china/3router.git",
  "directory": "packages/<platform>"
}
```

**预检**：5 个子包（darwin-arm64/darwin-x64/linux-x64/linux-arm64/win32-x64）都有 repository 字段。

**历史**：0.2.2 新建子包（commit `2c6c28b`）时漏 repository；0.2.3 首次走 CI 子包发布暴露，commit `0cac84f` 修复。

## 坑 3：publish-main 回写 main non-fast-forward

**症状**：CI publish-main 的 `git push origin HEAD:main` 失败：non-fast-forward。

**根因**：tag 创建到 publish-main 回写之间，main 若有新 commit（如其他推送、依赖 bot 提交），bot 的 release commit 直接 push 会 non-fast-forward 失败。

**修复**：release.yml publish-main 回写前加 `git pull --rebase origin main`。

**预检**：确认 release.yml publish-main 回写步骤含 `git pull --rebase origin main`（当前已修，在 git commit 与 git push 之间）。

**历史**：0.2.3 commit `4549160` 修复。

## 坑 4：编译先于根 version bump → 二进制内联旧版本号

**症状**：发布 X.Y.Z 后，`npx 3router status`（或任意子命令）输出 `3router v<上一版本>`，但 npm 上包元数据是 X.Y.Z。`strings` 平台二进制可见内联的是旧版本字符串（实测 `@3router/darwin-arm64@0.2.3` 的二进制：6×`0.2.2`、0×`0.2.3`）。

**根因**：`cli.ts` 经 import attribute（`import pkg from "../package.json" with { type: "json" }`）把**根** package.json 的 `version` 内联进 `--compile` 二进制，版本号在编译那一刻冻死。release.yml build job 原顺序是「先编译二进制 → 后写子包版本号」，而**根** package.json 的 version bump 在更后面的 publish-main job（`needs: build`）。build job 检出代码时，main 上根 package.json 还是上一 release commit 留下的旧版本号，编译出的二进制内联旧版本，之后才 bump + 发布。结果：npm 上 `@3router/<plat>@X.Y.Z` 的包元数据是新版本，里面二进制却报上一版本号。

**为何本地没暴露**：本地预演 `bun scripts/build-compile.ts` 时，根 package.json 已是当前开发版本（与目标版本一致或已手动 bump），编译内联正确。CI 的「检出上一 release 的 package.json → 编译 → 后续才 bump」时序本地无法复现。

**修复**：build job 在「编译二进制」**之前**加一步写根 package.json 版本号：
```yaml
- name: 写主包版本号（编译前，确保 --compile 二进制内联正确版本）
  run: npm version ${{ steps.ver.outputs.version }} --no-git-tag-version --allow-same-version
```
矩阵 5 平台各跑一次是幂等的（`--allow-same-version`），无副作用。子包版本号写入（原步骤）与 publish-main 的根 bump 保留（后者此时为 no-op，双重保险）。

**预检**：
- release.yml build job「编译二进制」步骤之前有「写主包版本号」步骤。
- 编译后验证内联版本：`strings packages/darwin-arm64/3router | rg -o '0\.[0-9]+\.[0-9]+' | sort -u` 应只含目标版本。

**历史**：0.2.3 首次暴露——`@3router/darwin-arm64@0.2.3` 的二进制 strings 内联 6×`0.2.2`、0×`0.2.3`，而包元数据是 0.2.3。`npx 3router status` 恒报 v0.2.2（重装无效，二进制已定型）。

## 坑 5：CI 发版回写 package.json 但不同步 lockfile（坑 1 的结构性根因）

**症状**：每次发版后，main 上 `package.json` 的 `version` + `optionalDependencies` 已 bump 到新版本，但 `pnpm-lock.yaml` 仍记旧版本。下次发版前预检 `pnpm install --frozen-lockfile` 失败：`ERR_PNPM_OUTDATED_LOCKFILE ... @3router/* (lockfile: <旧>, manifest: <新>)`。

**根因**：release.yml build/publish job 用 `--frozen-lockfile`（严格匹配，禁止改 lockfile），CI 内 bump package.json version + optionalDependencies 后**不会**重新生成 lockfile。publish-main 把 bump 后的 package.json 回写 main，但 lockfile 没跟着回写。于是每次发版后 lockfile 落后一个版本——这是坑 1 每次发版必然重现的**结构性根因**（坑 1 是手动改依赖后疏忽，坑 5 是 CI 流程必然）。

**为何本地没暴露**：本地预演时 lockfile 与当前 package.json 已由开发者 `pnpm install` 同步过；CI 的「bump package.json → frozen install（不改 lockfile）→ 回写 package.json 而非 lockfile」时序本地不发生。

**修复（根本，待实施）**：release.yml 在 bump package.json 之后加 `pnpm install --lockfile-only` 重新生成 lockfile，并把 lockfile 纳入 publish-main 回写。或 publish-main 回写步骤连 lockfile 一起 commit。彻底修前靠预检同步兜底（见下）。

**预检（兜底，当前必做）**：每次发版前 `pnpm install --lockfile-only` 同步 lockfile 并提交，再 `pnpm install --frozen-lockfile --no-optional` 验证通过。

**历史**：0.2.4 发版预检重现——lockfile `@3router/*` 0.2.2 vs manifest 0.2.3，手动 `pnpm install --lockfile-only` 同步后才过。坑 1 的 0.2.2/0.2.3 记录实为同一结构性问题的多次表现。

## 本地预演盲区（根本性认识）

本地能验证的：依赖安装、前端构建、二进制编译、typecheck。
本地**无法**验证的：
- **npm publish provenance**：需 CI OIDC 环境与 npm 侧 trusted publisher 配置
- **5 平台交叉编译**：本地只编当前平台（darwin-arm64），其余 4 平台靠 `bun build --compile --target` 交叉编译，CI 才跑
- **OIDC trusted publisher 绑定**：npm 侧「包 ↔ GitHub repo/workflow」的绑定
- **编译时序（version bump vs compile）**：本地根 package.json 已是目标版本，编译内联正确；CI 检出上一 release 的 package.json 再编译才暴露（坑 4）

因此**本地预演全过 ≠ CI 必成功**。预检清单（尤其子包 repository、lockfile）是补盲区的手段。每次发版都要过清单，不能因为「上次成功」就跳过——新加的子包/新改的依赖可能引入新问题。

## 失败定位速查

CI 失败时按失败步骤定位（不要猜，先读 log）：
```bash
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {name, databaseId}'
gh run view --job <job-id> --log-failed | tail -40
```

| 失败步骤 | 大概率根因 | 修复方向 |
|---|---|---|
| 安装依赖（pnpm install） | lockfile 未同步（坑 1） | `pnpm install --lockfile-only`，提交 lockfile |
| 构建前端（build:web） | web 依赖/源码 | 看 build 错误，本地 `pnpm build:web` 复现 |
| 编译二进制（build-compile） | embed / import attribute / 源码 | 看 compile 错误，本地 `bun scripts/build-compile.ts` 复现 |
| 上传到 GitHub Release | 资产路径/权限 | 罕见，看 action-gh-release 报错 |
| 发布平台子包（npm publish） | provenance repository（坑 2）/ OIDC 配置 | 子包 repository 字段；确认 trusted publisher |
| publish-main: git push | non-fast-forward（坑 3）/ 版本号 | `git pull --rebase`；确认 npm 上该版本未发布 |
| publish-main: npm publish | 主包 repository / 版本已存在 | 确认版本号未用过、主包有 repository |

失败修复后：删除失败 Release 与 tag（`gh release delete vX.Y.Z --yes --cleanup-tag`），提交修复到 main 推送，重新创建 Release 触发 CI。前提：npm 上该版本未发布过（否则版本号已占用，需递增 patch 或用 dist-tag）。

## 手动发布 fallback（下策）

仅当 CI 反复失败且无法及时修复时。手动发布绕过 CI、不触发 provenance（掩盖坑 2）、不验证 workflow、不创建 GitHub Release、不回写 main。事后应补建 Release 并尽快修复 CI 回归自动化。

```bash
# 1. 本地完整构建
pnpm build

# 2. 写版本号（主包 + 5 子包）
npm version X.Y.Z --no-git-tag-version
for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
  (cd packages/$p && npm version X.Y.Z --no-git-tag-version)
done

# 3. 同步主包 package.json 的 optionalDependencies 全部指向 X.Y.Z
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));for(const k of Object.keys(p.optionalDependencies||{}))p.optionalDependencies[k]='X.Y.Z';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"

# 4. 发布（需 npm login，非 OIDC；逐个包发布）
npm publish --access public
for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
  (cd packages/$p && npm publish --access public)
done

# 5. 补建 GitHub Release 保持记录完整
gh release create vX.Y.Z --target <commit> --title "X.Y.Z" --notes "..."
```
