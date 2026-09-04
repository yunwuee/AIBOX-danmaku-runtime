# AIBOX Danmaku Runtime

[![CI](https://github.com/yunwuee/AIBOX-danmaku-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/yunwuee/AIBOX-danmaku-runtime/actions/workflows/ci.yml)
[![Upstream Watch](https://github.com/yunwuee/AIBOX-danmaku-runtime/actions/workflows/sync-upstream.yml/badge.svg)](https://github.com/yunwuee/AIBOX-danmaku-runtime/actions/workflows/sync-upstream.yml)

AIBOX Danmaku Runtime 是供 AIBOX 内置 Node/Fastify 引擎加载的弹幕运行时。它从 [`huangxd-/danmu_api`](https://github.com/huangxd-/danmu_api) 机械选择所需源码，替换移动端不兼容或不应暴露的能力，最后生成一个三端共用、固定哈希、可回滚的纯 JavaScript ZIP。

## 设计边界

- 不调用 `listen()`，不启动第二个 HTTP 服务。
- 只向宿主注册 `/internal/danmaku` 下的固定 GET 路由。
- 不包含管理后台、部署接口、环境变量编辑接口或请求日志接口。
- 不启动 `5321` 正向代理，不连接 Redis。
- 不包含 WASM 咪咕实现、原生 addon 或运行时 `npm install`。
- 显式使用 `node-fetch`，兼容禁用原生 `fetch` 的 iOS `nodejs-mobile`。
- 产物构建目标为 Node `18.20.4`，同时在 Node 20/22 做兼容检查。
- 上游更新会自动同步、执行 Node 18/20/22 兼容检查，并在检查全部通过后由机器人提交主分支、递增补丁版本、打 Tag 和发布稳定资产；任一步失败都会停止，不会提交或发布。

## 宿主接口

运行时导出 CommonJS API：

```js
const { registerDanmakuRuntime } = require('./runtime.bundle.cjs');

await registerDanmakuRuntime({
  fastify,
  prefix: '/internal/danmaku',
  logger: fastify.log,
});
```

注册的路由：

```text
GET /internal/danmaku/health
GET /internal/danmaku/info
GET /internal/danmaku/api/v2/search/anime
GET /internal/danmaku/api/v2/search/episodes
GET /internal/danmaku/api/v2/comment/:id?format=json
```

运行时不拥有端口、进程或服务器生命周期；启动、停止、更新、回滚和健康检查全部由 AIBOX 主程序负责。

## 本地构建

需要 Git、Node.js `18.20.4` 以上版本：

```powershell
npm ci
npm run sync:upstream
npm run check
```

离线或审计已有上游工作区：

```powershell
node scripts/sync-upstream.mjs --source D:\path\to\danmu_api
npm run check
```

生成文件：

```text
dist/
├─ runtime.bundle.cjs
├─ runtime.bundle.cjs.LEGAL.txt
├─ manifest.json
├─ LICENSE
└─ THIRD_PARTY_NOTICES.md

artifacts/
├─ aibox-danmaku-runtime-<version>.zip
├─ release-manifest.json
└─ SHA256SUMS
```

## 自动跟踪上游

`.github/workflows/sync-upstream.yml` 每天检查一次上游 `main`：

1. 在只有 `contents: read` 权限的作业中拉取上游。
2. 从两个固定入口解析 ESM 依赖闭包。
3. 仅复制依赖图可达的普通文件，并应用 `config/runtime-policy.json` 替换策略。
4. 拒绝非字面量动态导入、未批准 npm 包、未批准 Node 内置模块、符号链接、路径逃逸和超限文件。
5. 生成同步报告和候选构建，但不在该作业中执行上游运行时代码。
6. 独立验证作业在 Node 18、20、22 上重新应用同步产物，并完成构建、Fastify 注入测试、ZIP 安全检查和哈希验证。
7. 三个版本矩阵全部通过后，机器人把允许路径提交到 `main`，自动递增补丁版本并创建对应的 `v*` tag。
8. 机器人触发发布工作流，重新构建并发布 ZIP、清单和 SHA-256 校验文件；失败时不会产生稳定 Release。

被替换的模块及原因会同时记录在：

- `config/runtime-policy.json`
- `upstream.lock.json`
- `reports/upstream-sync.md`
- `generated/upstream/AIBOX_UPSTREAM.json`

## 发布

正常的上游更新不需要手工合并或发布：

```text
上游更新 → 自动同步 → Node 18/20/22 检查 → 自动提交 main → 自动 Tag → 自动 Release
```

如果发布工作流因网络或 GitHub 临时故障失败，可手动重试对应 Tag：

```powershell
gh workflow run release.yml --ref v0.1.3 -f tag=v0.1.3
```

发布工作流会重新在 Node `18.20.4` 构建并验证，然后上传 ZIP、`release-manifest.json` 和 `SHA256SUMS`。AIBOX 客户端必须同时校验 HTTPS、版本兼容、文件大小和 SHA-256；未来会增加 Ed25519 清单签名。

## 许可证

本仓库按上游根许可证使用 GNU Affero General Public License v3.0。每次发布都必须同时保留所选源码、自动裁剪脚本、修改说明、许可证和对应上游 commit。详见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
