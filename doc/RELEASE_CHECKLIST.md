# OpenClaw Cortex Memory Release Checklist

## 1) 本地一键门禁

在仓库根目录执行：

```bash
npm run release:check
```

通过标准：

- 命令退出码为 `0`
- 输出包含 `[Release Pipeline] All checks passed.`

## 2) GitHub Actions 门禁

提交 PR 或推送到 `main/master/develop` 后自动触发：

- `Version Gate`：`npm run check:version`
- `Typecheck`：`npm run typecheck`
- `Build`：`npm run build`
- `Regression Tests`：`npm run test:all`
- `Package Dry Run`：`npm pack --dry-run`

发布前必须确认 CI 全绿。

## 3) 发布前人工核验

按顺序执行并逐项打勾：

- [ ] `openclaw.plugin.json` 与 `package.json` 版本一致
- [ ] `npm run test:all` 通过
- [ ] `npm pack --dry-run` 产物包含 `dist/index.js` 与 `dist/openclaw.plugin.json`
- [ ] README 与 SKILL 的安装来源说明已更新（ClawHub 显式 + npm 回退）
- [ ] 若涉及模型链路改动，`test:model` 通过并检查降级逻辑无阻断

## 4) 发布命令（npm）

```bash
npm publish --access public
```

发布后回归：

- [ ] 使用 `openclaw plugins install` 实测安装
- [ ] `openclaw plugins enable openclaw-cortex-memory` 可用
- [ ] `search_memory`、`store_event`、`diagnostics` 工具可调用
