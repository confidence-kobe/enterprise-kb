# 代码导读

这份文档帮助你读懂 Enterprise KB 的代码：从哪里开始读、一次提问在代码里经过了哪些地方、为什么这样设计，以及目前已知的局限。

功能和接口的完整说明见 [TECHNICAL.md](TECHNICAL.md)，部署见 [DEPLOYMENT.md](DEPLOYMENT.md)。本文只讲"怎么读代码"和"怎么理解这些取舍"。

> 文中引用代码时写的是"文件 + 函数名"，而不是行号：行号会随修改变化，函数名不会。在编辑器里按函数名搜索即可跳转。

---

## 一、先建立整体印象

整个系统是**一个 Node.js 进程**，同时提供网页和接口，数据存在**一个 SQLite 文件**和**一个文档目录**里。没有 Redis、没有消息队列、没有向量数据库、没有前端构建步骤。

```
浏览器 / AI 工具
      │  HTTP、SSE
      ▼
src/server.ts      所有路由、后台队列、启动流程（最大的文件）
      │
      ├─ src/auth.ts            登录 Token 和 API 密钥的认证
      ├─ src/db.ts              所有 SQL：建表迁移、增删改查、全文检索、向量
      ├─ src/executor.ts        和大模型对话：流式输出 + 工具调用循环
      │     └─ src/tools.ts、toolAdapter.ts、toolScope.ts   给大模型用的工具及访问范围
      ├─ src/mcp.ts             MCP 协议（让 AI 工具调用知识库）
      ├─ src/documentChunker.ts 文档分块
      ├─ src/extractWorker.ts 等 在工作线程里提取 PDF/Office 文字、OCR
      └─ src/backup*.ts         备份与恢复

public/            前端：index.html + chat.js（问答页）、manage.html + manage.js（管理台）
```

**一句话概括核心思路**：上传的文档被切成小段存进 SQLite 的全文索引；提问时，大模型不是一次性拿到所有资料，而是像人一样"先搜、再读、再回答"，通过工具调用自己去检索和阅读，最后标注出处。

---

## 二、推荐的阅读顺序

按这个顺序读，每一步都建立在上一步的基础上。括号里是大致的阅读量。

### 第 1 步：数据长什么样（30 分钟）

读 `src/db.ts` 开头的**类型定义**和 `initDb()`。

- 看懂有哪些表：用户、知识库、成员、文档、对话、消息、审计、反馈、版本、密钥、知识缺口
- 注意 `initDb()` 里的迁移写法：每一步都可以重复执行，新安装和老版本升级走同一段代码
- TECHNICAL.md 的"数据库设计"一节有表结构总览，可以对照着看

### 第 2 步：谁能访问什么（30 分钟）

读 `src/auth.ts` 全文，再看 `src/db.ts` 里的 `canUserAccessKb()`、`canUserWriteKb()`。

- 登录 Token 为什么还要每次查数据库（`token_version`）
- API 密钥为什么用白名单限制能调用的接口（`isApiKeyAllowed()`）
- 读权限和写权限的区别：公开知识库只开放读

### 第 3 步：文档是怎么入库的（1 小时）

读 `src/server.ts` 里"后台索引队列与 OCR 队列"这一节，从上到下：

1. `enqueueDocIndex()`：所有入库操作（上传、新建、同步、启动补建）的入口
2. `processDocIndexJob()`：按文件类型分流，PDF 和 Office 在工作线程里提取文字
3. `processOcrJob()`：扫描页和图片的文字识别
4. `finishDocIndex()`：写索引、生成向量和摘要

然后读 `src/documentChunker.ts`（怎么切段）和 `src/db.ts` 的 `indexDocContentInBatches()`（为什么分批写）。

### 第 4 步：怎么检索（1 小时）

读 `src/db.ts` 的"FTS5 全文检索"一节：`searchDocContent()` → `scoreCandidate()` → `makeSnippet()`。

- 四路召回：严格 AND、宽松 OR、子串匹配、可选的向量
- 打分权重：文件名命中 > 整句命中 > 单个词命中
- 配合 TECHNICAL.md 的"混合检索算法"一节看

### 第 5 步：一次提问的完整过程（1 小时）

这是最核心的一条链路，详细见下一节"三、跟踪一次提问"。

### 第 6 步：前端（按需）

`public/chat.js` 和 `public/manage.js` 开头都有文件结构说明。重点看 chat.js 的 `readSSE()`（怎么接收流式回答）和 `renderMd()`（怎么安全地渲染 Markdown、怎么把出处变成链接）。

### 第 7 步：其余功能（按兴趣）

| 想了解 | 读这里 |
|---|---|
| 对话历史怎么裁剪 | `src/conversationHistory.ts`（文件开头有说明） |
| MCP 协议 | `src/mcp.ts`，配合 `src/server.ts` 的"MCP 服务"一节 |
| 文件夹同步 | `src/server.ts` 的 `scanSyncDirectory()`、`syncKnowledgeBase()` |
| 版本历史 | `src/server.ts` 的"编辑现有文本文档"一节，`src/db.ts` 的"文本文档历史版本" |
| 备份 | `src/backup.ts`、`src/backupScheduler.ts` |
| 大模型能用哪些工具、能访问什么 | `src/tools.ts`、`src/toolScope.ts` |

---

## 三、跟踪一次提问

用户在网页上问"年假有几天？"，代码依次经过：

```
① 浏览器  public/chat.js  sendQuestion()
     POST /api/kbs/3/ask  { question, conversationId }
          │
② 服务端  src/server.ts  app.post('/api/kbs/:id/ask', requireAuth, qaRateLimit, …)
     requireAuth          验证 Token，从数据库读出最新的用户信息
     qaRateLimit          每个用户每分钟最多 20 次
     canUserAccessKb      有没有权限读这个知识库
     buildTrustedHistory  从数据库取这段对话的历史并裁剪
     开启 SSE 响应
          │
③ 大模型循环  src/executor.ts  LLMExecutor.run()
     第 1 轮：把系统提示词（src/prompt.ts）+ 历史 + 问题发给大模型
              大模型回复：调用工具 SearchDocs("年假")
              → src/tools.ts → src/db.ts searchDocContent()
              → 返回"员工手册.md 第 42 行附近：……年假 5 天……"
     第 2 轮：大模型回复：调用工具 Read("员工手册.md", 从第 40 行读)
              → claude-tools-kit 的 Read，受 toolScope 限制只能读这个知识库
     第 3 轮：大模型给出最终回答："年假为 5 天（`员工手册.md:42`）"
     每一步都通过 onEvent → SSE 实时推给浏览器
          │
④ 服务端收尾  保存新消息、给新对话起标题、记审计日志 qa.ask，发送 done 事件
          │
⑤ 浏览器  readSSE()  逐个处理 text / tool_call / tool_result / done 事件
          renderMd()  渲染回答，把 `员工手册.md:42` 变成可点击的出处
          点击出处 → openSrcPreview() → GET …/preview?line=42 → 高亮第 42 行
```

**自己动手验证**：

- 运行 `npm run test:e2e`。其中"answers a question and records a thumbs-down reason"和"opens the cited line when a source with a Chinese file name is clicked"两个测试走的是 ①②④⑤：模拟大模型（`e2e/mock-llm.mjs`）不调用工具，直接给出带出处的回答。
- 第 ③ 步的真实工具调用，要连上真实的大模型才能看到：启动服务后运行 `npm run smoke:full`，它会发起一次真实提问，并检查确实调用了工具；也可以直接在网页上提问，展开回答上方的工具调用块查看每一步。

---

## 四、设计取舍：为什么这样做

读代码时常会疑惑"为什么不用某某"。下面是主要的取舍，以及换来了什么、付出了什么。

| 选择 | 换来的 | 付出的代价 |
|---|---|---|
| **SQLite 单文件**，不用 PostgreSQL | 零运维，备份就是复制文件，内网离线可部署 | 只能单台服务器运行，不能多实例横向扩展 |
| **SQLite FTS5 全文检索**，不用 Elasticsearch | 不需要额外服务 | 检索功能相对简单，没有同义词、拼音等能力 |
| **向量检索可选**，在 JS 里全量计算 | 不配置 Embedding 也能用；配置后不需要向量数据库 | 分块数很多时向量检索会变慢 |
| **让大模型自己调用工具检索**，不是一次性塞资料 | 回答能精确到行号，大模型可以多次检索、交叉核对 | 一次回答要调用好几轮模型，耗时和费用都更高 |
| **后台队列放在内存里** | 实现简单，没有额外依赖 | 重启时队列丢失（启动时 `reindexExistingDocs()` 会补上） |
| **重活放进工作线程**（PDF、Office、OCR、备份） | 解析大文件时服务器照常响应 | 代码多了一层线程通信 |
| **前端不用框架、不用构建** | 改完刷新就生效，部署只有一个 Node 进程 | 两个前端文件各有约 2,000 行，全局变量多，要手动更新缓存版本号 |
| **登录 Token 每次请求都查数据库** | 改密、降级、删除用户后旧 Token 立即失效 | 每个请求多一次（很快的）主键查询 |
| **API 密钥用白名单** | 新增的写接口默认不能被密钥调用 | 新增只读的 POST 接口时要记得加进白名单 |

---

## 五、反思：已知的局限和可以改进的地方

这些不是需要马上修的 bug，而是理解项目时应该知道的边界。按影响从大到小排列。

### 1. `server.ts` 太大

一个文件约 2,400 行、68 个路由，再加上后台队列和同步逻辑。目前靠分节标题还能读，但继续加功能会越来越难维护。**可以改进**：按功能拆成多个路由文件（认证、知识库、文档、问答、管理），后台队列单独一个文件。拆分不改变行为，有完整的测试保护，风险可控。

### 2. 只能单实例运行

除了 SQLite 本身，登录限速、问答限速、索引队列也都在内存里。启动两个进程会各算各的。**目前对企业内部使用够用**；如果将来要多实例部署，这几处都要换成共享存储。

### 3. 浏览器里的 Token 存在 localStorage

如果页面出现 XSS 漏洞，脚本可以读走 Token。目前的防线是：大模型回答经过 DOMPurify 净化、用户输入都会转义。**可以改进**：增加 Content-Security-Policy 响应头（目前没有设置）作为第二道防线，或者改用 HttpOnly Cookie 保存登录状态。

### 4. 回答质量没有自动评估

现有测试保证"功能正确"：检索能搜到、权限不越界、出处能跳转。浏览器测试用的是模拟大模型，所以"回答得好不好"没有自动化的衡量。目前能看到的信号是用户的 👍/👎 和知识缺口报告。**可以改进**：整理一组典型问题和标准答案，换模型或改提示词时跑一遍对比。

### 5. 检索在超大知识库上会变慢

2 个字的中文词用 `LIKE` 子串匹配（已经限制在单个知识库内），向量检索是全量计算。几千份文档没有问题；数万份以上时，这两处会先成为瓶颈。

### 6. 一些小问题

- 同步文件夹里的 Word/Excel 文件被修改后，旧的提取文本（`.txt`）不会先删除（`syncKnowledgeBase()` 里只处理了 PDF）。正常情况下重新解析会覆盖它；只有解析失败时，预览可能还显示旧内容。
- `packages/claude-tools-kit` 只有编译后的代码，没有源码，修改它不方便。
- 测试用例的名称是英文的。

---

## 六、动手改代码时的检查清单

| 要做的事 | 记得 |
|---|---|
| 加一个数据库字段或表 | 在 `initDb()` 末尾照现有写法追加，保证可以重复执行；发布前跑 `npm run upgrade:check` |
| 改了分块或索引方式 | 把 `src/db.ts` 的 `DOC_INDEX_VERSION` 加一，旧文档会在启动时自动重建索引 |
| 加一个路由 | 加上 `requireAuth`；涉及知识库要检查读或写权限；写操作调用 `audit()` 记审计；在 `test/server.test.ts` 补测试 |
| 加一个能让 API 密钥调用的接口 | 只读的 GET 自动允许；POST 要加进 `src/auth.ts` 的 `API_KEY_POST_ROUTES` |
| 改了前端文件 | 把 HTML 里对应的 `?v=` 版本号加一；运行 `npm run test:e2e` |
| 改了认证、权限、上传或存储 | 同步更新 `SECURITY_OWNERSHIP.md` |
| 任何用户能感知的变化 | 在 `CHANGELOG.md` 的"未发布"里记一笔 |
| 提交前 | 至少 `npm run build`；改了接口跑 `npm run test`；安全相关跑 `npm run check` |

更完整的约定见 [AGENTS.md](AGENTS.md)。
