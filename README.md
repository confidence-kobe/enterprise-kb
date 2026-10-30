# Enterprise KB 企业知识库

Enterprise KB 是一个基于 Node.js/TypeScript 的企业知识库应用：多用户登录、SQLite 存储、文档管理，支持任何兼容 OpenAI 接口的大模型。

检索时按文档结构切分段落，再综合严格全文检索、宽松关键词召回、文件名匹配和子串兜底进行排序。上传的文件和本地文件夹同步任务都由后台队列解析和建索引，大 PDF 不会卡住其他文档的入库。管理员可以在审计日志里查看登录、用户、知识库、文档、同步和配置的变更记录。

## 技术栈

- Node.js 22.19 及以上（CI 和 Docker 使用 Node 22）
- TypeScript
- Express 5
- SQLite（`better-sqlite3`）
- 静态前端，位于 `public/`
- 支持兼容 OpenAI 接口的大模型服务

## 快速开始

安装依赖：

```bash
npm ci
```

创建本地配置：

```bash
cp .env.example .env
```

以开发模式启动：

```bash
npm run dev
```

默认访问地址：

```text
http://localhost:8080
```

如果 `8080` 端口被占用（Windows PowerShell）：

```powershell
$env:PORT="8081"
npm run dev
```

## 常用命令

```bash
npm run build
npm run test
npm run check
npm run codex:smoke
npm run smoke:full
npm run backup
npm run test:e2e
npm start
```

- `npm run build`：把 TypeScript 编译到 `dist/`。
- `npm run test`：运行 Vitest 接口测试。
- `npm run check`：编译、测试，再做生产依赖的安全审计。
- `npm run codex:smoke`：检查运行中应用的健康检查接口。
- `npm run smoke:full`：完整走一遍登录、用户、知识库、文档、权限、对话和一次真实的模型回答，结束后清理临时数据。
- `npm run backup` / `npm run backup:list` / `npm run restore -- <备份名> --yes`：备份或恢复数据库和文档，详见 `DEPLOYMENT.md`。
- `npm run test:e2e`：先编译，再运行 `e2e/` 里的 Playwright 浏览器测试。测试会启动一个模拟模型和一个使用临时数据库的服务器。第一次运行前先执行 `npx playwright install chromium`。
- `npm start`：运行 `dist/server.js`。

对非默认端口做健康检查：

```powershell
$env:CODEX_APP_URL="http://localhost:8081"
npm run codex:smoke
```

## 环境变量

以 `.env.example` 为模板。重要的变量：

- `PORT`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_MAX_TURNS`
- `HISTORY_MAX_MESSAGES`
- `HISTORY_MAX_CHARS`
- `SYNC_MAX_FILES`
- `SYNC_MAX_TOTAL_MB`
- `BACKUP_DIR`、`BACKUP_KEEP`、`BACKUP_INTERVAL_HOURS`（备份位置、保留份数、自动备份间隔；默认 `./backups`、7、不自动备份）
- `EXTRACT_TIMEOUT_SECONDS`（默认 120；解析超过这个时间的 PDF/Office 文件标记为失败）
- `OCR_ENABLED`、`OCR_MAX_PAGES`（默认开启、100；内置 OCR 识别扫描版 PDF 和上传的照片，见 `DEPLOYMENT.md`）
- `SYNC_ALLOWED_ROOTS`（可选；用逗号分隔的文件夹列表，同步来源必须在其中。只有管理员能设置同步文件夹。）
- `STORAGE_PATH`
- `DB_PATH`
- `CORS_ORIGIN`
- `TRUST_PROXY`
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（可选；调用大模型和向量接口时使用的出站代理）

生产环境下，`JWT_SECRET` 和 `ADMIN_PASSWORD` 太弱或仍是默认值时，服务器拒绝启动。

## Docker

构建镜像：

```bash
docker build -t enterprise-kb:local .
```

用 Compose 运行：

```powershell
$env:JWT_SECRET="replace-with-a-random-string-at-least-32-chars"
$env:ADMIN_PASSWORD="replace-with-a-strong-admin-password"
docker compose up --build
```

Compose 配置把 SQLite 数据和上传的文档保存在 Docker 数据卷里。

## 持续集成

GitHub Actions 的 CI 配置在：

```text
.github/workflows/ci.yml
```

它会运行：

```bash
npm ci
npm run check
```

## API 与 MCP

每个用户都可以在管理控制台的 **API 接入** 标签页创建 API 密钥。密钥能访问的知识库和它的主人一样，但只能读取和提问。调用普通接口时放在请求头 `Authorization: Bearer ekb_…` 里，例如 `GET /api/kbs` 或 `POST /api/kbs/:id/ask`。

同一个密钥也能让 AI 工具通过 MCP（Model Context Protocol）连接知识库，服务地址是 `<你的站点>/mcp`。Claude Code 的配置方法：

```bash
claude mcp add --transport http enterprise-kb https://kb.example.com/mcp \
  --header "Authorization: Bearer ekb_..."
```

提供的工具：`list_knowledge_bases`（列出知识库）、`search_documents`（检索文档）、`read_document`（读取文档）和 `ask_knowledge_base`（向知识库提问）。API 接入标签页里还有 JSON 配置（适用于 Cursor 等客户端）和 curl 测试命令。

## 发布

基于 tag 的发布流程和发布包内容见 [RELEASE.md](RELEASE.md)。

## 安全

安全责任划分见 [SECURITY_OWNERSHIP.md](SECURITY_OWNERSHIP.md)。

关键规则：

- 不要把 `.env` 提交到仓库。
- 生产环境的 `JWT_SECRET` 和 `ADMIN_PASSWORD` 必须足够强。
- 保留 `requireAuth`、`requireAdmin` 和知识库访问权限的检查。
- `data/` 和 `storage/` 是敏感的运行数据。

## 部署

部署检查清单见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 技术文档

- [GUIDE.md](GUIDE.md)：代码导读，推荐的阅读顺序、一次提问在代码里的完整路径、设计取舍和已知局限。第一次读代码从这里开始。
- [TECHNICAL.md](TECHNICAL.md)：架构、数据库、检索算法、OCR、MCP 等实现细节。
