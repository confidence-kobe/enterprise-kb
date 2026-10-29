# AGENTS.md

## 项目概况

本仓库是 `enterprise-kb`，一个基于 Node.js/TypeScript 的企业知识库应用。

- 运行环境：Node.js 22.19 及以上
- 服务端：Express 5
- 数据库：SQLite（`better-sqlite3`）
- 界面：`public/` 里的静态文件
- 源码：`src/` 里的 TypeScript
- 编译输出：`dist/`
- 本地包：`packages/claude-tools-kit`

## 语言约定

使用者是中文用户，以下内容一律用简体中文：

- 代码注释和文档（README、CHANGELOG、DEPLOYMENT 等）
- 界面文字、接口返回的错误信息、启动和运行日志
- 提交信息、PR 标题和描述

代码标识符、命令、接口路径、环境变量名保持英文原样。`CHANGELOG.md` 的版本标题必须保持 `## [x.y.z] - 日期` 格式，发布流程靠它提取发布说明。

## 常用命令

在仓库根目录运行：

```bash
npm run dev
npm run build
npm run test
npm run check
npm run codex:smoke
npm start
```

命令说明：

- `npm run dev`：用 `tsx` 运行 TypeScript 服务端。
- `npm run build`：把 TypeScript 编译到 `dist/`。
- `npm run test`：运行 Vitest 接口测试。
- `npm run check`：运行 TypeScript 编译、Vitest 测试和生产依赖安全审计。
- `npm run codex:smoke`：检查运行中应用的首页和健康检查接口。
- `npm start`：运行编译好的 `dist/server.js`。

## 本地运行

应用默认地址：

```text
http://localhost:8080
```

如果 `8080` 端口被占用，换一个端口运行：

```powershell
$env:PORT="8081"; npm run dev
```

健康检查接口：

```text
GET /healthz
GET /readyz
```

接口和静态界面由同一个 Express 服务器提供。

## 环境变量

以 `.env.example` 为模板创建 `.env`。

关键变量：

- `PORT`
- `JWT_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `STORAGE_PATH`
- `DB_PATH`
- `CORS_ORIGIN`
- `TRUST_PROXY`

生产环境不得使用默认或示例的 `JWT_SECRET` 和 `ADMIN_PASSWORD`。

## 文件和目录

优先修改：

- `src/`
- `public/`
- `packages/claude-tools-kit/`
- `.env.example`
- `DEPLOYMENT.md`
- `README.md`
- `SECURITY_OWNERSHIP.md`
- `Dockerfile`
- `docker-compose.yml`
- `.github/pull_request_template.md`
- `.github/dependabot.yml`
- `CODEOWNERS`
- `package.json`
- `tsconfig.json`

除非明确要求，不要手动修改：

- `dist/`（除非任务包括重新生成编译产物）
- `node_modules/`
- `data/`
- `storage/`
- `.env` 里的密钥
- `server.log`

## 验证规则

完成代码修改前，至少运行最基本的验证：

```bash
npm run build
```

修改了接口、认证或路由时，运行：

```bash
npm run test
```

涉及发布或安全的修改，运行：

```bash
npm run check
```

GitHub Actions 的 CI 定义在 `.github/workflows/ci.yml`，先运行 `npm ci`，再运行 `npm run check`。

GitHub 工作流规范文件：

- `.github/pull_request_template.md`
- `.github/dependabot.yml`
- `.github/workflows/release.yml`
- `CODEOWNERS`

Docker 部署文件是 `Dockerfile`、`.dockerignore` 和 `docker-compose.yml`。修改 Docker 相关文件后至少验证：

```bash
docker build -t enterprise-kb:local .
```

修改前端时，还要运行浏览器测试（先 `npm run build`）：

```bash
npm run test:e2e
```

修改前端或路由时，启动应用并在浏览器里验证：

```bash
npm run dev
```

如果应用运行在非默认端口，冒烟检查前设置 `CODEX_APP_URL`：

```powershell
$env:CODEX_APP_URL="http://localhost:8081"; npm run codex:smoke
```

然后检查：

```text
http://localhost:8080
http://localhost:8080/healthz
http://localhost:8080/readyz
```

查看浏览器控制台有没有报错，确认页面不是空白。

## 发布流程

- 版本 tag 遵循语义化版本，例如 `v1.0.1`。
- 打 tag 前先更新 `CHANGELOG.md`。
- `RELEASE.md` 里有发布检查清单和发布包内容。
- 推送 tag 会触发 `.github/workflows/release.yml`，发布 GitHub Release 和发布包。

## 安全注意事项

- `.env` 含有密钥，不要把其中的值打印或复制到对话里。
- 保持 `requireAuth`、`requireAdmin` 以及知识库所有者/成员检查完整有效。
- 文件上传和文档预览要保留防路径穿越的保护。
- 保留生产环境启动时对弱 `JWT_SECRET` 和 `ADMIN_PASSWORD` 的检查。
- 不要放宽 `npm run check` 里的 `npm audit --omit=dev --audit-level=moderate`。
- 修改认证、权限、上传、部署或存储边界时，同步更新 `SECURITY_OWNERSHIP.md`。

## Codex 工作习惯

- 修改前先阅读相关文件。
- 修改范围严格限定在用户的要求之内。
- 优先沿用项目已有的写法，不引入新的抽象。
- 用 `rg` 搜索。
- 手动修改用 `apply_patch`。
- 不要撤销用户的改动。
- 修改了前端可见的内容后，如果有本地服务器，在浏览器里验证。
- 最后总结改动内容和验证结果。
