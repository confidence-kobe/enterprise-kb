# Enterprise KB 部署检查清单

## 运行要求

- Node.js 22.19 或更新版本。版本过旧时，服务器和备份命令会拒绝启动。
- 可写的 SQLite 数据目录。
- 可写的文档存储目录。
- 兼容 OpenAI 接口的大模型服务。使用 Ollama 时填 `http://localhost:11434/v1`。

## 配置

把 `.env.example` 复制为 `.env`，填入生产环境的值：

- 运行环境里设置 `NODE_ENV=production`。
- `JWT_SECRET`：随机字符串，至少 32 个字符。
- `ADMIN_PASSWORD`：初始管理员密码，不要用默认值。
- `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`LLM_MAX_TURNS`。
- `HISTORY_MAX_MESSAGES`、`HISTORY_MAX_CHARS`：限制发给模型的历史对话长度。
- `STORAGE_PATH`、`DB_PATH`。
- `CORS_ORIGIN`：只有界面和接口不在同一个域名下时才需要。
- `SYNC_ALLOWED_ROOTS`：把本地文件夹同步限制在指定的服务器目录里（例如 `/srv/shared-docs`）。只有管理员能设置知识库的同步文件夹；知识库所有者可以对管理员配置好的文件夹执行同步。
- `HTTPS_PROXY` / `NO_PROXY`：服务器需要通过公司代理访问大模型或向量接口时设置。代理地址里的账号密码不会出现在日志中。

生产环境下，`JWT_SECRET` 或 `ADMIN_PASSWORD` 仍是示例值或默认值时，服务器拒绝启动。

## 发布前验证

```bash
npm ci
npm run check
```

`npm run check` 会运行 TypeScript 编译、Vitest 接口测试和生产依赖安全审计。

## 启动

```bash
npm start
```

界面和接口由同一个 Express 服务器提供。健康检查接口：

- `GET /healthz`：进程是否存活。
- `GET /readyz`：进程是否就绪，以及大模型服务是否可达。

## Docker

构建镜像：

```bash
docker build -t enterprise-kb:local .
```

用 Docker Compose 运行：

```bash
JWT_SECRET="replace-with-a-random-string-at-least-32-chars" \
ADMIN_PASSWORD="replace-with-a-strong-admin-password" \
docker compose up --build
```

Windows PowerShell：

```powershell
$env:JWT_SECRET="replace-with-a-random-string-at-least-32-chars"
$env:ADMIN_PASSWORD="replace-with-a-strong-admin-password"
docker compose up --build
```

Compose 把 SQLite 数据和文档保存在两个命名数据卷里：

- `enterprise_kb_data`
- `enterprise_kb_storage`

## 备份与恢复

应用的所有数据都在两个地方：SQLite 数据库（`DB_PATH`）和文档文件夹（`STORAGE_PATH`）。备份会把两者都复制一份。

**自动备份。** 设置 `BACKUP_INTERVAL_HOURS=24`，服务器运行期间每天备份一次。如果最近没有备份，启动约一分钟后会先备份一次；备份失败一小时后重试。`.env.example` 和 `docker-compose.yml` 默认开启；不设置这个变量或设为 `0` 时关闭。备份在后台线程里进行，复制文档期间应用照常响应。

**在网页上操作。** 管理员在 管理控制台 → 设置 里能看到备份计划、上次结果和备份列表，点 立即备份 可以马上备份一次。每次手动备份都会记入审计日志（`backup.create`）。

**用命令行操作。** 如果从源码运行，先执行 `npm run build`。

```bash
npm run backup          # 把数据库和文档备份到 BACKUP_DIR（默认 ./backups）
npm run backup:list     # 列出已有备份
```

- 服务器运行时也可以安全备份（使用 SQLite 的在线备份接口），备份完成后会检查副本的完整性。
- 每份备份是一个 `backup-<UTC 时间>/` 文件夹，里面有 `enterprise-kb.db`、`storage/` 和 `manifest.json`。
- 只保留最新的 `BACKUP_KEEP` 份（默认 7 份）。每份都是文档的完整副本，所以要预留约 `BACKUP_KEEP` × `STORAGE_PATH` 大小的磁盘空间。
- 备份和数据在同一台机器上。**请定期把备份文件夹复制到别处**（另一块硬盘、NAS 或对象存储）。

如果想用 cron 在固定时间备份，而不用内置的定时备份，把 `BACKUP_INTERVAL_HOURS` 设为 `0`，然后添加：

```cron
30 2 * * * cd /opt/enterprise-kb && npm run backup >> backups/backup.log 2>&1
```

恢复（先停止服务器；`/healthz` 还有响应时命令会拒绝执行）：

```bash
npm run restore -- backup-20261001-020000          # 只预览
npm run restore -- backup-20261001-020000 --yes    # 执行恢复
```

当前的数据库和文档文件夹会被改名为 `*.before-restore-<时间>`，不会删除。确认恢复后的应用正常，再把它们删掉。

Docker（备份保存在数据卷内的 `/app/data/backups`）：

```bash
docker compose exec enterprise-kb npm run backup
docker compose cp enterprise-kb:/app/data/backups ./kb-backups      # 复制到服务器之外

docker compose stop enterprise-kb
docker compose run --rm --no-deps enterprise-kb npm run restore -- backup-20261001-020000 --yes
docker compose start enterprise-kb
```

## 扫描件识别（OCR）

- 扫描版 PDF 和上传的照片（JPG、PNG、WebP、BMP）用内置 OCR（Tesseract，中文 + 英文）识别，识别后和其他文档一样可以检索。这类文档在文档列表里带 **OCR** 标签，可以预览查看识别出的文字。
- OCR 在本服务器的后台线程里运行，不会发送给大模型服务商，运行时也不下载任何东西：语言数据随 npm 包一起安装（约 5 MB）。
- 只识别几乎没有文字（少于 20 个字）的 PDF 页面，普通 PDF 不会变慢。4 核服务器上每页扫描件约需 1–2 秒。扫描件在单独的队列里识别，不影响其他上传。
- `OCR_MAX_PAGES`（默认 100）限制每个 PDF 最多识别多少页扫描页。`OCR_ENABLED=false` 关闭 OCR，此时扫描版 PDF 和照片会建索引失败，并提示原因。
- 清晰的印刷文字识别效果好；模糊的照片、复杂表格和手写字效果较差。
- 这个功能上线前建索引失败的扫描版 PDF（"文档没有可索引文本"）会在下次启动时自动重试。
- 文件夹同步不导入图片，所以共享文件夹里的标志、截图不会被拉进来。

## API 密钥与 MCP

- MCP 客户端连接 `https://<你的站点>/mcp`。生产环境请用 HTTPS，因为 API 密钥放在 `Authorization` 请求头里传输。
- 如果应用前面有反向代理，请把 `/mcp` 和 `/api/kbs/*/ask` 的读取超时设为至少几分钟。`ask_knowledge_base` 要等答案完整生成后才返回。
- 浏览器发往 `/mcp` 的请求必须来自本站，或来自 `CORS_ORIGIN` 里列出的域名。命令行和桌面版 MCP 客户端不发送 `Origin` 请求头，不受影响。
- 员工离职时，删除其账号会同时删除其所有密钥。只想停用某一个工具时，在 API 接入 标签页吊销对应的密钥即可。

## 运维说明

- `data/`、`storage/`、`.env`、`node_modules/` 和 `dist/` 有意不纳入 git 管理。
- `packages/claude-tools-kit` 随项目一起提供，部署时不依赖项目外的目录。
- `npm ci` 可能会显示原生模块或 SDK 依赖的维护提示。发布的硬性标准是 `npm audit --omit=dev --audit-level=moderate` 必须没有问题。
- 生产发布前请检查 `SECURITY_OWNERSHIP.md`。
