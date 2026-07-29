# Security policy

## Supported releases

只有 GitHub Releases 中标记为稳定版、且其 ZIP 与 `release-manifest.json` SHA-256 一致的版本受支持。不要从 `main` 分支源码 ZIP、Actions 临时产物或第三方镜像直接安装运行时。

## Supply-chain controls

- 自动同步上游只能创建候选 Pull Request，不能直接发布。
- 上游源码在只读权限作业中解析和构建。
- 带仓库写权限的作业不执行候选运行时，只复制严格白名单路径。
- 发布基于已合并的受信任 tag，重新运行完整构建和验证。
- ZIP 禁止绝对路径、`..`、符号链接和超限解压体积。
- 运行时只注册固定本地路由，不获得宿主监听端口或进程控制权。

## Reporting a vulnerability

请通过 GitHub Security Advisories 私下报告漏洞。报告中可以包含运行时版本、上游 commit、错误阶段和复现步骤，但不要提交用户 Token、Cookie、完整搜索内容或私人服务地址。
