# 安全责任划分

本文档说明 `enterprise-kb` 的安全边界，以及各部分由谁负责。

## 范围

本应用是一个 Express/TypeScript 服务：提供静态界面，用 JWT 验证用户身份，数据存放在 SQLite 里，上传的文档存放在磁盘上，并调用兼容 OpenAI 接口的大模型服务。

## 需要保护的资产

- SQLite 里的用户账号和密码哈希。
- JWT 签名密钥。
- API 密钥的哈希（`api_keys` 表）；密钥明文只在创建时返回一次。
- 知识库信息、对话和消息。
- `STORAGE_PATH` 下上传的文档。
- `DB_PATH` 下的 SQLite 数据库。
- 大模型的 API 密钥和服务地址。
- 管理员账号密码。
- 运行日志和运维数据。

## 信任边界

| 边界 | 入口 | 主要防护措施 | 负责人 |
| --- | --- | --- | --- |
| 公网 HTTP → Express | `src/server.ts` 里的路由 | 安全响应头、CORS 策略、JSON 大小限制、认证中间件 | 后端负责人 |
| 匿名用户 → 已登录用户 | `/api/auth/login` | 密码校验、登录频率限制、签发 JWT | 后端负责人 |
| 普通用户 → 管理员操作 | `/api/admin/*`、模型配置 | `requireAdmin` | 后端负责人 |
| API 密钥持有者（脚本、AI 工具） | 任何 `requireAuth` 路由上的 `Authorization: Bearer ekb_…`、`POST /mcp` | `requireAuth` 对密钥做哈希并以密钥主人的身份执行；`isApiKeyAllowed` 只允许 `GET`、两个问答接口和 `/mcp`；`requireAdmin` 和 `/api/me/api-keys` 拒绝密钥 | 后端负责人 |
| MCP 客户端 | `POST /mcp`（`src/mcp.ts`） | 认证同上；`Origin` 必须是本站或 `CORS_ORIGIN` 里的来源；每次调用工具都重新检查 `canUserAccessKb`；`ask_knowledge_base` 与网页共用每个用户的问答频率限制 | 后端负责人 |
| 用户 → 知识库数据 | `/api/kbs/*`、对话、文档 | 通过数据库辅助函数检查所有者、成员和公开状态 | 后端负责人 |
| 浏览器 → 上传的文件 | 文档预览路由 | 路由上的权限检查，按存储文件名查找文件 | 后端负责人 |
| 应用 → SQLite | `src/db.ts` | 参数化查询、外键、WAL | 后端负责人 |
| 应用 → 本地存储 | `STORAGE_PATH` | 由服务端生成文件名、扩展名白名单、每个知识库单独目录 | 后端负责人 |
| 服务器文件夹 → 知识库（文件夹同步） | `PATCH /api/kbs/:id/sync-source`、`POST /api/kbs/:id/sync` | 只有管理员能设置同步文件夹；真实路径不能与 `STORAGE_PATH` 重叠，设置了 `SYNC_ALLOWED_ROOTS` 时必须在其中；每次同步都重新校验 | 后端负责人 |
| 应用 → 大模型服务商 | `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` | 环境变量配置和请求限制 | 平台负责人 |
| 大模型工具调用 → 本地文件 | `src/toolAdapter.ts`、`src/toolScope.ts`、`src/tools.ts` | `ToolScope`：路径参数和 Glob 模式（解析符号链接之后）必须落在用户有权访问的知识库目录里 | 后端负责人 |
| 主机 / 容器运行环境 | Docker、`.env`、数据卷 | 容器以非 root 用户运行、挂载持久化数据卷、妥善保管密钥 | 平台负责人 |
| CI | `.github/workflows/ci.yml` | `npm ci`、编译、测试、依赖审计 | 仓库负责人 |

## 现有防护措施

- JWT 认证集中在 `src/auth.ts`。
- `requireAuth` 每次请求都重新读取用户：已删除的用户被拒绝；角色以数据库为准（不信任 Token 里的角色）；Token 里的 `tv` 与 `users.token_version` 不一致时被拒绝。修改密码和修改角色都会让 `token_version` 加一，所以旧 Token 立即失效。
- 仅限管理员的路由使用 `requireAdmin`。
- API 密钥（`ekb_` + 192 位随机数）只保存 SHA-256 哈希，以密钥主人当前的角色和知识库权限执行。通过路由白名单（`src/auth.ts` 里的 `isApiKeyAllowed`）限制为只读：`GET`/`HEAD`、`POST /api/kbs/:id/ask`、`POST /api/ask` 和 `POST /mcp`。即使密钥属于管理员，管理员接口和密钥管理接口也会拒绝它，所以泄露的密钥不能再创建密钥或修改数据。修改密码不会让密钥失效（密钥与 `token_version` 无关）；要停用密钥，在 API 接入 标签页吊销，管理员也可以通过 `/api/admin/api-keys` 吊销。删除用户会同时删除其密钥。
- `/mcp` 只提供只读工具。每次调用工具都重新检查知识库权限，所以密钥主人无权读取的知识库不会出现在结果里。
- 知识库权限检查使用 `canUserAccessKb`、所有者检查或管理员检查。
- 写入文档（上传、新建或编辑文本文档）需要通过 `canUserWriteKb`：所有者、明确添加的成员或管理员。公开状态只开放查看和问答。上传权限在 multer 写入文件之前检查。
- 文本文档的历史版本保存在数据库里（`doc_versions` 表），不在 `STORAGE_PATH` 下，所以大模型工具和检索都看不到旧内容。能读取知识库的人都能查看版本列表和内容；恢复版本需要通过 `canUserWriteKb`，并记入审计日志。删除文档时一并删除其版本。
- 登录尝试按 IP 和用户名限制频率。
- 生产环境启动时拒绝过弱或默认的 `JWT_SECRET`。
- 生产环境启动时拒绝默认的 `ADMIN_PASSWORD`。
- 上传文件大小限制为 50 MB。
- 上传扩展名使用白名单。网页上传还接受图片（`.png`、`.jpg`、`.jpeg`、`.webp`、`.bmp`）用于 OCR；文件夹同步不接受图片。
- PDF 和 Office 文件在工作线程里解析，有超时（`EXTRACT_TIMEOUT_SECONDS`，默认 120 秒）和内存上限。格式错误或恶意构造的文件只会让它自己建索引失败，不会卡住或拖垮服务器进程。OCR（扫描版 PDF 页面和图片）在同样的工作线程里运行，时间上限为 `EXTRACT_TIMEOUT_SECONDS` 加每页 60 秒，每个 PDF 最多识别 `OCR_MAX_PAGES` 页。Tesseract 在本地运行，使用随包提供的语言数据，不发起任何网络请求；它只把语言文件写到系统临时目录下的一个文件夹里。
- SQL 调用全部使用预编译语句。
- 大模型工具（Read/Grep/Glob/KBStats/SearchDocs）被限制在 `ToolScope` 内：单个知识库问答时只能访问这一个知识库，跨知识库问答时只能访问用户有权访问的知识库（`listKbsForUser`）。这个边界在 `assertParamsInScope` 里强制执行，因为 claude-tools-kit 的 `plan` 模式不检查 `allowedDirectories`。
- Express 设置了安全响应头。
- `.env`、`data/`、`storage/`、数据库文件、日志以及依赖和构建产物都不纳入 git 管理。
- Docker 运行时使用 `node` 用户，数据和文档通过数据卷持久化。
- 备份（`npm run backup`、自动备份，或管理控制台里的 立即备份）包含完整的数据库（包括密码哈希）和所有文档。备份接口（`GET`/`POST /api/admin/backups`）仅限管理员，只返回备份名称和数量，从不返回文件路径，也不提供下载或恢复。`BACKUP_DIR` 和所有异地副本都要像线上数据一样保护。`BACKUP_DIR` 不能放在 `STORAGE_PATH` 里面，否则大模型工具可能读到它。
- CI 运行编译、接口测试、浏览器测试和依赖审计。

## 各负责人的职责

### 后端负责人

负责：

- 认证中间件的正确性。
- 路由级别的权限控制。
- 知识库成员和所有者检查。
- 上传校验。
- 文档预览的安全性。
- 接口错误处理。
- 认证、管理员、知识库和上传流程的测试覆盖。

重要文件：

```text
src/server.ts
src/auth.ts
src/db.ts
src/tools.ts
src/toolScope.ts
src/toolAdapter.ts
test/toolScope.test.ts
test/server.test.ts
```

### 平台负责人

负责：

- 生产环境的 `.env` 配置。
- 定期更换密钥。
- Docker 或主机部署。
- SQLite 和文档存储的数据卷备份。
- 反向代理和 TLS。
- 大模型服务商的凭据。
- Sentry 或其他生产环境监控。

重要文件：

```text
.env.example
DEPLOYMENT.md
Dockerfile
docker-compose.yml
```

### 仓库负责人

负责：

- GitHub 仓库权限。
- 分支保护。
- CI 配置。
- 依赖审查。
- 发布流程。

重要文件：

```text
.github/workflows/ci.yml
package.json
package-lock.json
.gitignore
```

## 重点防范的攻击路径

### 生产环境密钥过弱

风险：

- 攻击者可以伪造 JWT，或接管默认的管理员账号。

防护措施：

- 生产环境启动时拒绝默认或过弱的 `JWT_SECRET`。
- 生产环境启动时拒绝默认的 `ADMIN_PASSWORD`。

负责人：

- 平台负责人。

### 知识库权限失效

风险：

- 用户能读取或修改别人的私有知识库、文档或对话。

防护措施：

- 保留 `canUserAccessKb` 检查。
- 保留所有者和管理员检查。
- 新增知识库相关路由之前，先补上"用户之间互相访问被拒绝"的测试。

负责人：

- 后端负责人。

### 不安全的文件上传或预览

风险：

- 路径穿越、超大文件、意外的可执行内容或数据泄露。

防护措施：

- 保留扩展名白名单。
- 保留由服务端生成的存储文件名。
- 访问文档之前先做路由级别的权限检查。
- 不信任客户端传来的路径。

负责人：

- 后端负责人。

### 大模型服务配置错误

风险：

- 请求把敏感的知识库数据发给了错误的服务商，或者模型不可用导致生产环境无法使用。

防护措施：

- `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL` 按环境分别配置。
- 不要提交 `.env`。
- 在部署检查清单里核对服务商和模型。

负责人：

- 平台负责人。

### 运行数据丢失

风险：

- 部署过程中丢失 SQLite 数据库或上传的文档。

防护措施：

- 持久化 `DB_PATH` 和 `STORAGE_PATH`。
- Docker Compose 使用命名数据卷。
- 同时备份数据库和文档目录，并开启自动备份（见 `DEPLOYMENT.md`）。

负责人：

- 平台负责人。

### API 密钥泄露

风险：

- 拿到密钥的人能读取密钥主人能读的所有内容，并通过问答消耗模型费用。

防护措施：

- 密钥不能写入、不能执行管理操作、不能创建密钥；问答按用户限制频率。
- 可设置过期时间；密钥主人和管理员能看到最近使用时间；管理员可以吊销任何密钥。
- 创建和吊销密钥会记入审计日志，用密钥执行的操作会在审计日志里记下密钥前缀。

负责人：

- 后端负责人。

## 建议的后续措施

- 接入 Sentry 或同类的生产环境错误监控。
- 把备份自动复制到另一台机器或对象存储（目前备份和数据在同一台机器上）。
- 推送版本 tag 的权限只给仓库负责人，因为推送 tag 会触发正式发布。
