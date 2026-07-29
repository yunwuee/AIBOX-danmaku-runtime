# Contributing

## Upstream updates

不要手工修改 `generated/upstream/` 后把它当作长期补丁。优先修改 `config/runtime-policy.json`、`stubs/` 或确定性的同步转换，然后重新运行：

```powershell
npm run sync:upstream
npm run check
```

Pull Request 必须说明：

- 对应的上游 commit。
- 新增或移除的模块和 npm 包。
- 对 Windows、Android、iOS `nodejs-mobile 18.20.4` 的影响。
- 是否改变本地路由、安全边界或默认弹幕来源。
- 构建、测试和 ZIP 校验结果。

不得加入自定义远程 JavaScript 执行、任意请求头、管理后台、Redis、正向代理、原生 addon 或未经三端验证的 WASM。
