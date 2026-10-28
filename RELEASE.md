# 发布流程

本仓库通过 tag 发布版本。

## 版本号

- 发布前先更新 `package.json` 里的版本号。
- tag 使用语义化版本：`v1.0.0`、`v1.0.1`、`v1.1.0`、`v2.0.0`。
- 在 `CHANGELOG.md` 里记录用户能感知到的变化。

## 发布步骤

1. 更新 `package.json` 和 `CHANGELOG.md`。
2. 在本地运行常规验证：

```bash
npm run check
npm run test:e2e
```

3. 检查上一个版本的数据库能否顺利升级。这一步先用上一个版本写入数据，再用当前版本在同一份数据上启动，验证登录、文档、检索、对话和反馈都正常：

```bash
git worktree add ../kb-prev v1.3.0          # 上一个发布的 tag
(cd ../kb-prev && npm ci && npm run build)
npm run build && npm run upgrade:check -- ../kb-prev
git worktree remove ../kb-prev
```

4. 提交发布相关的改动。
5. 创建并推送 tag：

```bash
git tag v1.0.1
git push origin v1.0.1
```

6. GitHub Actions 会构建发布包，并根据 tag 发布 GitHub Release。发布说明取自 `CHANGELOG.md` 里对应版本的章节（例如 `## [1.3.0] - …`）。章节标题必须保持这个格式，缺少该章节时发布流程会失败。

## 发布包内容

发布流程生成的压缩包包含：

- `dist/` 里编译好的服务端代码
- `public/`
- 含升级说明的 `CHANGELOG.md`
- 随项目提供的 `packages/claude-tools-kit/dist/`
- 运行和部署所需的元数据

## 注意事项

- 没在本地跑过检查，不要打 tag 发布。
- 发布说明要简短，面向用户。
