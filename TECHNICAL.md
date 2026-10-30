# Enterprise KB 技术文档

> 版本：v1.3.0 · 最后更新：2026-10-29

---

## 目录

1. [项目概述与核心亮点](#1-项目概述与核心亮点)
2. [技术栈全景](#2-技术栈全景)
3. [系统架构](#3-系统架构)
4. [数据库设计](#4-数据库设计)
5. [认证与权限体系](#5-认证与权限体系)
6. [文档管道：上传 → 提取 → 分块 → 索引](#6-文档管道上传--提取--分块--索引)
7. [扫描件识别（OCR）](#7-扫描件识别ocr)
8. [混合检索算法](#8-混合检索算法)
9. [大模型对话引擎](#9-大模型对话引擎)
10. [对话历史管理](#10-对话历史管理)
11. [API 密钥与 MCP 服务](#11-api-密钥与-mcp-服务)
12. [文件夹同步机制](#12-文件夹同步机制)
13. [版本历史](#13-版本历史)
14. [审计日志、反馈与知识缺口](#14-审计日志反馈与知识缺口)
15. [备份与恢复](#15-备份与恢复)
16. [前端设计系统](#16-前端设计系统)
17. [安全加固](#17-安全加固)
18. [测试体系](#18-测试体系)
19. [部署与运维](#19-部署与运维)

---

## 1. 项目概述与核心亮点

Enterprise KB 是一套面向企业内部的**本地知识库问答系统**。用户把文档上传（或从服务器目录同步）到知识库，系统自动建立全文检索索引；之后用自然语言提问，大模型通过工具调用自主检索知识库，给出标注了出处的回答。

### 核心亮点

| 亮点 | 说明 |
|------|------|
| **零外部依赖检索** | 基于 SQLite FTS5（trigram 分词），不需要 Elasticsearch、Milvus 等额外服务 |
| **结构感知分块** | 按 Markdown 和中文章节标题切块，标题随块携带，保留语义上下文 |
| **四级混合召回** | 严格 AND → 宽松 OR → 文件名匹配 → 子串兜底，可选叠加向量相似度 |
| **扫描件可检索** | 内置 Tesseract OCR（中文 + 英文），离线识别扫描版 PDF 和照片 |
| **流式工具调用** | SSE 实时推送每个字和工具执行过程 |
| **出处可点击** | 回答里的 `文件名:行号` 可点击，直接打开原文并定位到对应行 |
| **AI 工具接入** | 只读 API 密钥 + MCP 服务，Claude Code、Cursor 等可直接查询知识库 |
| **重活不卡服务** | PDF/Office 提取、OCR、备份都在工作线程里运行 |
| **大模型无关** | 对接任意兼容 OpenAI 接口的服务：Ollama、MiniMax、OpenAI 等 |
| **可审计** | 登录、用户、知识库、文档、同步、配置、问答操作全部记录 |
| **数据安全** | 生产环境拒绝弱密钥；自动备份；改密或改角色后旧 Token 立即失效 |
| **零运维数据库** | SQLite WAL 模式，单文件，不需要单独的数据库服务 |

---

## 2. 技术栈全景

### 运行时与语言

| 层 | 技术 | 版本 | 选择原因 |
|----|------|------|---------|
| 运行时 | Node.js | 22.19+ | 当前 LTS；undici 8 和 openai 7 需要 Node 22 |
| 语言 | TypeScript | 7（原生编译器） | 静态类型；原生编译器一次编译约 1.7 秒 |
| 框架 | Express | 5.3 | 成熟、生态最广；v5 原生支持 async 路由 |
| 数据库 | better-sqlite3 | 12 | 同步 API；SQLite FTS5 内置全文检索 |
| 文件上传 | multer | 2.5 | 流式写盘，不占内存 |
| 大模型客户端 | openai SDK | 7 | 统一调用所有兼容 OpenAI 的接口 |
| HTTP 客户端 | undici | 8 | 支持 `HTTPS_PROXY`/`NO_PROXY`，HTTPS 时自动用 HTTP/2 |
| PDF 解析 | pdf-parse | 2（基于新版 pdf.js） | 纯 JS；也用来把扫描页渲染成图片 |
| Office 解析 | mammoth、officeparser、exceljs | 1 / 8 / 4 | Word、PowerPoint、Excel |
| OCR | tesseract.js | 7 | 本地运行，语言数据随 npm 包安装 |
| 认证 | jsonwebtoken + bcryptjs | 9 / 3 | JWT + bcrypt 密码哈希 |

### 前端

| 技术 | 说明 |
|------|------|
| 原生 JS（Vanilla） | 没有框架，没有构建步骤，由 Express 直接提供静态文件 |
| marked 18 | Markdown 渲染，由服务器本地提供（`/vendor/marked.min.js`） |
| DOMPurify 3 | 净化 HTML，防止大模型输出注入脚本 |
| p5.js 2 | 登录页的流场背景动画 |
| Inter 字体 | 本地提供，内网环境不需要访问 CDN |
| Server-Sent Events | 流式接收大模型输出和工具调用事件 |

### 工具链

| 工具 | 用途 |
|------|------|
| tsx | 开发时直接运行 TypeScript |
| vitest 5 | 单元测试和接口测试 |
| supertest | HTTP 集成测试 |
| Playwright | 浏览器端到端测试 |
| dotenv | 加载 `.env` |
| npm audit | CI 依赖漏洞门禁（moderate 级别） |

---

## 3. 系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────┐
│  浏览器                         AI 工具 / 内部系统   │
│  login.html  index.html  manage.html   Claude Code  │
│       ↕ HTTP / SSE（登录 Token）   ↕ API 密钥 / MCP │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              Express 5（src/server.ts）              │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌───────┐  │
│  │ 认证中间件│  │ REST 路由 │  │ SSE 问答│  │ /mcp  │  │
│  │ auth.ts  │  │          │  │        │  │mcp.ts │  │
│  └──────────┘  └──────────┘  └────────┘  └───────┘  │
│        │              │             │          │    │
│        ▼              ▼             ▼          ▼    │
│  ┌──────────────────────────────────────────────┐   │
│  │           src/db.ts（数据访问层）             │   │
│  │  用户 · 知识库 · 文档 · 对话 · 审计 · 密钥     │   │
│  │  FTS5 全文索引 · 向量 · 版本 · 知识缺口        │   │
│  └──────────────────────────────────────────────┘   │
│                       │                             │
│              ┌─────────────────┐                    │
│              │  SQLite（WAL）   │                    │
│              └─────────────────┘                    │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  后台队列 + 工作线程                           │   │
│  │  索引队列 · OCR 队列 · 文字提取 · 自动备份      │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  src/executor.ts（大模型引擎）                 │   │
│  │  流式输出 · 工具调用循环 · 过滤 <think>        │   │
│  └──────────────────────────────────────────────┘   │
│                       │                             │
│              ┌──────────────────┐                   │
│              │ 兼容 OpenAI 的接口 │                   │
│              └──────────────────┘                   │
│                                                     │
│  storage/kb_<id>/  上传文件 · 提取出的文字 · 同步文件 │
└─────────────────────────────────────────────────────┘
```

### 请求流（一次问答）

```
用户输入问题
      │
      ▼
POST /api/kbs/:id/ask
      │
      ├─ 认证（requireAuth：登录 Token 或 API 密钥）
      ├─ 知识库访问权限检查
      ├─ 问答频率限制（每个用户）
      ├─ 从数据库加载对话历史 → buildTrustedHistory() 裁剪
      │
      ▼
建立 SSE 流（text/event-stream）
      │
      ▼
LLMExecutor.run(question, tools, history, abortSignal)
      │
      ├─ 循环（最多 LLM_MAX_TURNS 轮）
      │     ├─ 调用大模型接口（stream: true）
      │     ├─ ReasoningStreamFilter 过滤 <think> 块
      │     ├─ 实时推送 {type:'text'} 事件
      │     ├─ 累积工具调用分片
      │     ├─ 没有工具调用 → 结束循环
      │     └─ 执行工具调用（都限制在 ToolScope 内）
      │           ├─ SearchDocs → 混合检索
      │           ├─ Read → 按行读取文件
      │           ├─ Glob → 文件名模式匹配
      │           ├─ Grep → 正则搜索内容
      │           └─ KBStats → 知识库统计
      │
      ▼
保存消息（messages 表），回答"未找到相关内容"时计入知识缺口
      │
      ▼
推送 {type:'done'}，关闭 SSE
```

---

## 4. 数据库设计

### 表结构

```
users                 id · username · password_hash · role · token_version · created_at
knowledge_bases       id · name · description · storage_path · owner_id · is_public
                      system_prompt · sync_source_path · sync_last_at · sync_last_result
kb_access             kb_id + user_id（成员，多对多）
documents             id · kb_id · filename · original_name · size · uploaded_at
                      source_type（upload/text/sync）· source_path · source_mtime · source_size
                      index_version · index_status · index_error · indexed_at
                      summary · ocr_pages
conversations         id · kb_id · user_id · title · is_pinned · created_at · updated_at
messages              id · conversation_id · role · content · tool_calls · tool_call_id · seq
response_feedback     id · conversation_id · user_id · rating · 差评原因与问答快照 · created_at
doc_versions          id · doc_id · title · content · size · user_id · username · note · created_at
gap_events            id · kb_id（可为空）· user_id · question · source · channel · created_at
api_keys              id · user_id · name · prefix · key_hash · created_at · expires_at · last_used_at
audit_events          id · user_id · username · action · entity_type · entity_id · kb_id · detail · ip
system_config         key · value（例如当前选用的模型）

doc_fts               FTS5 虚拟表（trigram 分词），存放文档分块的全文索引
doc_chunks            doc_fts 分块与文档的映射，删除和重建索引时按文档快速定位
doc_chunk_vectors     分块向量（只在配置了 EMBEDDING_MODEL 时写入）
```

### 关键设计决策

**为什么用 SQLite 而不是 PostgreSQL？**
企业内部部署要求零运维：不需要单独的数据库服务和 DBA，备份用 SQLite 的在线备份接口即可。WAL 模式支持并发读，对知识库系统的并发量完全够用。

**FTS5 使用 trigram 分词**
`unicode61` 分词器对中文按单字切分，检索效果差。改用 `trigram` 后，3 个字及以上的中文词可以直接走索引；2 个字的词由 `LIKE` 子串匹配兜底，并先按知识库缩小扫描范围。从旧版本升级时会自动重建索引。

**幂等迁移**
新增列用 `ALTER TABLE ... ADD COLUMN` 包在 `try/catch` 里，已存在就忽略；新表用 `CREATE TABLE IF NOT EXISTS`。不需要迁移工具，适合单进程、单文件的部署方式。每次发布前用 `npm run upgrade:check` 验证上一个版本的数据能直接升级。

**WAL 模式**
```sql
PRAGMA journal_mode = WAL;   -- 读写并发，写入不阻塞读取
PRAGMA foreign_keys = ON;    -- 级联删除，不留孤儿数据
```

---

## 5. 认证与权限体系

### 登录与 Token

```
登录：
  POST /api/auth/login
    → 校验用户名和密码（bcrypt.compare）
    → 签发 JWT（HS256，默认 24 小时有效），载荷里带 token_version（tv）
    → 返回 token

后续请求：
  Authorization: Bearer <token>
    → requireAuth 验证签名和过期时间
    → 每次都从数据库重新读取用户：
        用户已删除               → 401
        tv ≠ users.token_version → 401（已改密或改角色）
        角色以数据库为准，不信任 Token 里的角色
    → 注入 req.user = { userId, username, role, tv }
```

**为什么每次请求都查数据库？**
纯无状态的 JWT 在改密、降级或删除用户后仍然有效，直到过期。用 `token_version` 让这些操作立即生效，代价只是一次按主键的 SQLite 查询。

### 三层权限模型

```
角色层
  admin  → 所有操作（用户管理、审计日志、备份、全局配置、所有人的 API 密钥）
  user   → 只能操作自己可访问的知识库

知识库层
  读取（canUserAccessKb）：公开知识库、所有者、成员、管理员
  写入（canUserWriteKb）：所有者、成员、管理员（公开状态只开放查看和问答）
  同步文件夹：只有管理员能设置

中间件层
  requireAuth   → 登录 Token 或 API 密钥有效即通过
  requireAdmin  → role === 'admin'，并且拒绝 API 密钥
```

### 登录限速

用内存里的 `Map<"IP:用户名", {count, resetAt}>` 实现：时间窗口（`LOGIN_RATE_WINDOW_MS`，默认 15 分钟）内最多 `LOGIN_RATE_MAX`（默认 10）次，超出返回 429 和"登录尝试次数过多，请稍后再试。"。单实例部署不需要跨进程共享状态，重启清零也符合预期。

---

## 6. 文档管道：上传 → 提取 → 分块 → 索引

### 管道流程

```
网页上传 / 在线新建文本 / 文件夹同步
         │
         ▼
   权限检查（在写入文件之前）
   扩展名白名单：文本、Markdown、PDF、代码、Office（.docx .xlsx .pptx 等）
   网页上传额外接受图片（.png .jpg .jpeg .webp .bmp）
         │
         ▼
   写入 storage/kb_<id>/<服务端生成的文件名>
   createDoc() → documents 表，index_status = 'pending'
         │
         ▼
   加入后台索引队列
         │
         ▼
   ┌──────── 文件类型 ─────────┐
   │            │              │
 PDF       Office          文本/图片
   │            │              │
   ▼            ▼              │
 工作线程里提取文字（runInWorker）│
 超时 EXTRACT_TIMEOUT_SECONDS    │
   │            │              │
   └────┬───────┘              │
        │  扫描页 / 图片 → 加入 OCR 队列（见第 7 节）
        ▼
   chunkDocument(text)   ← src/documentChunker.ts
        │
        ▼
   分批写入 doc_fts / doc_chunks，批次之间让出事件循环
   index_status = 'ready'
        │
        ▼（可选）生成分块向量、文档摘要
```

**为什么在工作线程里提取？**
一个 2,000 页的 PDF 在主线程解析会让服务器卡住约 6.5 秒，所有请求（包括流式回答）都会停下。放进工作线程后，主线程最长停顿约 13 毫秒；格式错误或恶意构造的文件只会让它自己失败。

**为什么分批写入索引？**
一个 50 MB 的文本文件一次性写入会阻塞约 4 秒。分批写入、批次之间让出事件循环后，最长停顿约 0.2 秒。建索引过程中文档被删除或编辑时，剩下的批次直接丢弃。

### 结构感知分块（src/documentChunker.ts）

**问题背景**
整篇文档放进 FTS5 会丢失位置信息，也无法定位片段。按固定字数切块会切断语义单元。

**实现原理**
```
识别分割点：
  Markdown 标题（# / ## / ### ...）
  中文章节标题（第一章 / 第二节 / 第三部分 ...）
  编号标题（1.2 / 1.2.3 ...）

按分割点切成若干段，每段不超过 maxChars（默认 1200）个字符。
  单段超长 → 再细分，保留 overlapLines（默认 2）行重叠，避免在边界截断语义。

每个分块携带：
  content   = "# 标题\n\n正文..."   ← 标题随块携带
  heading   = '安装说明'
  startLine = 42                   ← 行号从 0 开始，对外显示时加 1
```

**为什么标题要随块携带？**
大模型读到片段时能知道它属于哪一章，回答不会脱离上下文。

---

## 7. 扫描件识别（OCR）

```
PDF 提取完文字（每页分开）
      │
      ▼
isScannedPageText(页面文字)：去掉空白后少于 20 个字 → 扫描页
      │
      ├─ 没有扫描页 → 正常建索引
      │
      └─ 有扫描页 → 加入 OCR 队列（与普通索引队列分开）
              │
              ▼
        工作线程里：
          pdf-parse 把扫描页渲染成约 200 dpi 的图片（宽 1654 像素）
          tesseract.js 识别（语言 eng+chi_sim，LSTM 引擎）
          cleanOcrText() 去掉汉字和中文标点旁边多余的空格
              │
              ▼
        识别结果与文字页合并，建索引；documents.ocr_pages 记录识别页数
```

- **离线**：语言数据来自 `@tesseract.js-data/eng` 和 `@tesseract.js-data/chi_sim`（4.0.0_best_int），首次使用时复制到系统临时目录，不联网。
- **为什么 200 dpi**：实测比 300 dpi 识别得更准，也更快。
- **为什么英文在前**：tesseract.js 7 在 `chi_sim+eng` 顺序下会把语言名读错并报错。
- **为什么要清理空格**：Tesseract 会在每个字之间插空格（"住宿 标准 为 每 晚"），不清理就检索不到"住宿标准"。英文单词之间的空格保留。
- **为什么单独排队**：扫描件每页约 1–2 秒，单独排队后其他上传不用等。
- 限制：每个 PDF 最多识别 `OCR_MAX_PAGES`（默认 100）页；`OCR_ENABLED=false` 关闭。

---

## 8. 混合检索算法

### 四级召回漏斗

```
查询："部署 配置 端口"
          │
          ▼
  ① 严格 FTS5 AND
     MATCH '"部署" AND "配置" AND "端口"'
     按 BM25 排序，取前 candidateLimit 条
          │
          ▼（严格 AND 结果不够时）
  ② 宽松 FTS5 OR
     MATCH '"部署" OR "配置" OR "端口"'
          │
          ▼（始终执行）
  ③ 子串 LIKE 扫描
     content LIKE '%部署%' OR original_name LIKE '%部署%'
     兜底 2 字词和分词没命中的情况
          │
          ▼（可选：配置了 EMBEDDING_MODEL）
  ③' 向量相似度：向量命中但全文没命中的分块也加入候选
          │
          ▼
  候选合并（按 doc_id:chunk_line 去重）
          │
          ▼
  ④ 打分 scoreCandidate()
     +80  严格 AND 命中
     +35  宽松 OR 命中
     +20  子串命中
     +240 文件名与查询完全相同
     +160 文件名包含整个查询
     +120 内容包含整个查询
     +45  文件名包含某个词
     +12  内容包含某个词
     +0~15 BM25 排名加成
     有向量时：最终分 = 全文分 × 0.5 + 向量相似度（0~100）× 0.5
          │
          ▼
  取分数最高的 limit 条，生成片段
```

**片段生成**
找到第一个命中词，取它前面 120 个字、后面 240 个字，命中词用 `>>>…<<<` 标出，方便大模型和用户快速定位。

**为什么向量检索是可选的？**
1. 向量需要 Embedding 模型，增加部署复杂度
2. 企业文档里精确的词（制度名称、编号、术语）往往比语义相似更重要，BM25 + 子串匹配更可靠
3. 四级漏斗没有精确匹配时会自动放宽，召回率有保障
4. 需要语义检索时，设置 `EMBEDDING_MODEL` 即可叠加

---

## 9. 大模型对话引擎

### LLMExecutor 工具调用循环

```
src/executor.ts — LLMExecutor.run()

while (turns < maxTurns):
  │
  ├─ 调用大模型接口（stream: true，通过 undici 的 fetch，遵守出站代理设置）
  │
  ├─ 逐个处理流式分片：
  │     ├─ delta.content → ReasoningStreamFilter.push()
  │     │     ├─ 遇到 <think> → 进入思考模式，丢弃内容
  │     │     ├─ 遇到 </think> → 退出思考模式，恢复输出
  │     │     └─ 普通文字 → 原样输出
  │     └─ delta.tool_calls → 按 index 累积
  │           name：mergeStreamedToolName() 处理被拆开的名称
  │           arguments：字符串拼接
  │
  ├─ 没有工具调用 → 结束
  │
  └─ 逐个执行工具调用：
        ├─ 解析 JSON 参数（解析失败按空参数处理）
        ├─ tool.execute(params, scope)
        ├─ onEvent({ type:'tool_result', ... }) → SSE 推送
        └─ 构造 role:'tool' 消息加入对话

return { response, turns, messages }
```

### ReasoningStreamFilter

部分推理模型（如 DeepSeek-R1、QwQ）会在输出里穿插 `<think>...</think>` 推理过程，这些内容不展示给用户。标签可能被拆在两个分片里（`<thi` + `nk>`），所以最多缓存 6 个字符，判断是不是标签的开头，是就等下一个分片，不是就立即输出。

### 工具集

| 工具 | 来源 | 功能 |
|------|------|------|
| SearchDocs | src/tools.ts | 混合全文检索，首选的检索工具；行号从 1 开始 |
| Read | claude-tools-kit | 按行读取文件（支持 offset/limit） |
| Glob | claude-tools-kit | 文件名模式匹配（`**/*.md` 等） |
| Grep | claude-tools-kit | 正则搜索内容 |
| KBStats | src/tools.ts | 统计知识库的文件数、行数和大小 |

所有工具都限制在 `ToolScope` 内（src/toolScope.ts）：单个知识库问答只能访问这一个知识库，跨知识库问答只能访问用户有权访问的知识库。路径参数和 Glob 模式在解析符号链接之后检查。

### 系统提示词（src/prompt.ts）

```
检索流程：
  1. 先用 SearchDocs 定位
  2. 找到文件后用 Read 精读
  3. SearchDocs 没有结果时改用 Glob/Grep
  4. 控制检索轮次，避免无效循环

回答规范：
  - 必须用原始文件名和 Read 的行号标注出处（文件名:行号）
  - 知识库里没有相关内容时明确回答"未找到相关内容"，不猜测
  - 只能读取，不能修改文件

每个知识库还可以设置自己的系统提示词，作为"补充指令"追加在后面。
```

---

## 10. 对话历史管理

### 问题背景

每轮对话结束后，完整的 user/assistant/tool 消息都保存到 `messages` 表。下次提问时要把历史交给大模型，但：
- 历史太长会超出模型的上下文窗口
- 截断不当会拆开工具调用和结果的配对，导致接口报错
- 客户端传来的历史不可信，可能被篡改

### buildTrustedHistory（src/conversationHistory.ts）

```
输入：数据库里该对话的所有消息（按 seq 排序），不使用客户端传来的历史

步骤：
  1. 以 user 消息为起点，把历史分成"轮次"，跳过开头不完整的消息
  2. 从最新一轮往前累积，直到：
     - 消息数达到 maxMessages（HISTORY_MAX_MESSAGES，默认 40）
     - 字符数达到 maxChars（HISTORY_MAX_CHARS，默认 40000）
  3. 如果最新一轮本身就超出字符预算（工具结果特别长）：
     保留这一轮，但把超长内容裁成开头 2000 字 + 省略提示 + 结尾 500 字
  4. 返回 { messages, totalMessages, truncated }
     truncated = true 时，回答下方显示"已使用最近上下文"
```

**为什么按轮次截断？**
`assistant(tool_calls)` 和 `tool(result)` 必须成对出现，否则 OpenAI 兼容接口会返回 400。按轮次边界截断能保证消息序列完整。

---

## 11. API 密钥与 MCP 服务

### API 密钥

```
创建：POST /api/me/api-keys
  明文 = "ekb_" + 24 字节随机数（base64url）
  只保存 SHA-256 哈希和前缀，明文只在创建时返回一次
  可选 30/90/365 天过期，每人最多 20 个

使用：Authorization: Bearer ekb_…
  requireAuth 识别 ekb_ 前缀 → 计算哈希查表 → 以密钥主人的身份和当前权限执行
  isApiKeyAllowed(method, path) 白名单：
    GET / HEAD
    POST /api/kbs/:id/ask、POST /api/ask
    POST /mcp
  其他请求一律 403；requireAdmin 和 /api/me/api-keys 拒绝任何密钥
```

用密钥执行的操作在审计日志里记为 `via: 'api_key'` 并带上密钥前缀。管理员可以在 `/api/admin/api-keys` 查看和吊销所有人的密钥。

### MCP 服务（src/mcp.ts）

- 传输：Streamable HTTP 无状态模式，只接受 `POST /mcp`（GET/DELETE 返回 405）。
- 协议版本：2025-11-25、2025-06-18、2025-03-26、2024-11-05。
- 方法：`initialize`、`ping`、`tools/list`、`tools/call`。
- 浏览器请求的 `Origin` 必须是本站或 `CORS_ORIGIN` 里的来源；未认证时返回 401 和 `WWW-Authenticate`。

| 工具 | 说明 |
|------|------|
| `list_knowledge_bases` | 列出可访问的知识库（kb_id、名称、描述、文档数） |
| `search_documents` | 全文检索，返回片段和出处（kb_id、doc_id、行号） |
| `read_document` | 带行号读取原文，可分段，单次最多 40,000 字符 |
| `ask_knowledge_base` | 调用内置助手回答，与网页共用问答频率限制 |

每次调用工具都重新检查知识库权限。MCP 提问回答"未找到相关内容"或检索没有结果时，记入知识缺口。

---

## 12. 文件夹同步机制

### 同步流程

```
管理员设置 sync_source_path（服务器上的目录）
  校验：真实路径不能与 STORAGE_PATH 重叠；设置了 SYNC_ALLOWED_ROOTS 时必须在其中
                │
                ▼
        POST /api/kbs/:id/sync（所有者也可以执行）
                │
        scanSyncDirectory(root)，每次都重新校验路径
                ├─ 递归遍历目录
                ├─ 跳过隐藏目录、node_modules、dist 等
                ├─ 跳过不支持的扩展名（不导入图片）
                ├─ 跳过超过 50 MB 的文件
                ├─ 跳过符号链接
                └─ 文件数超过 SYNC_MAX_FILES（1000）
                   或总大小超过 SYNC_MAX_TOTAL_MB（500 MB）→ 停止
                │
                ▼
        与 documents 表里 source_type='sync' 的记录对比
                │
          ┌─────┴──────────────────┐
      新文件                     已有文件
          │                        │
      createDoc()          修改时间或大小变了？
      加入索引队列             是 → 更新并重新建索引
                               否 → 跳过（增量）
          │
          ▼
      删除源目录里已经不存在的文件
                │
                ▼
        返回 { added, updated, removed, skipped, errors }
```

**路径安全**
`isPathInside(parent, child)` 用 `path.relative()` 判断 child 是否在 parent 里，`normalizeSourcePath()` 先解析掉所有 `../` 再比较，防止路径穿越。

---

## 13. 版本历史

- 文本文档每次保存都写入 `doc_versions` 表（内容、修改人、时间），每份文档保留最新 50 个版本。
- 版本存在数据库里，不在 `STORAGE_PATH` 下，所以大模型工具和检索看不到旧内容。
- 启用版本记录之前创建的文本文档，第一次编辑时把原始内容保存为基准版本（`note = 'baseline'`）。
- 恢复旧版本会生成一个新版本（`note = 'restore:<版本号>'`），恢复前的内容仍保留在历史里，所以恢复操作也可以撤销。
- 接口：`GET /api/kbs/:id/docs/:docId/versions[/:versionId]`、`POST …/versions/:versionId/restore`（需要写权限，审计记为 `doc.restore_version`）。

---

## 14. 审计日志、反馈与知识缺口

### 审计日志

路由层通过 `audit()`（内部调用 `createAuditEvent()`）记录：

| 类别 | entity_type | 举例 |
|------|-------------|------|
| 登录 | auth | 登录成功、失败 |
| 用户 | user | 创建、删除、改角色、重置密码 |
| 知识库 | kb / kb_member | 创建、修改、删除、系统提示词、成员变更 |
| 文档 | doc | 上传、新建、编辑、删除、恢复版本 |
| 同步 | kb | 设置同步文件夹（kb.sync_source_update）、执行同步（kb.sync_run） |
| 配置 | config | 切换模型 |
| 问答 | kb / global | 单库提问（qa.ask）、跨库提问（qa.ask_global） |
| 密钥 | api_key | 创建、吊销 |
| 备份 | backup | 手动备份 |

每条记录保存 `user_id`、`username`、`action`、`entity_type`、`entity_id`、`kb_id`、`detail`（JSON，最多 4000 字符）和 `ip`。管理员通过 `GET /api/admin/audit` 查询：`action` 传完整操作代码时精确匹配，传关键词时模糊匹配；结果带知识库名称 `kb_name`。界面上每种操作和详情字段都显示中文名称。

### 反馈

用户可以对回答点 👍/👎，点 👎 时可以选原因并补充说明，系统同时保存当时的问题和回答快照（`response_feedback` 表）。管理员在 反馈 标签页看到满意度、原因分布和被评价的问答。

### 知识缺口

把"知识库里没有、但有人在问"的问题汇总出来，按被问次数排序：

| 来源 | 记录位置 |
|------|----------|
| 网页单库提问，回答"未找到相关内容" | 对话记录 |
| 用户点 👎 并选择"没找到相关资料" | response_feedback |
| 网页跨库提问、MCP 提问回答"未找到相关内容" | gap_events（source = ai_not_found） |
| MCP 检索没有结果 | gap_events（source = search_empty，显示为 检索无结果） |

管理员接口：`GET /api/admin/gaps?days=&kbId=`（最近 7/30/90 天）。

---

## 15. 备份与恢复

```
触发：npm run backup / 自动备份（BACKUP_INTERVAL_HOURS）/ 管理控制台的 立即备份
      │
      ▼
工作线程里执行（backupWorker），不阻塞服务
  ├─ SQLite 在线备份接口 → enterprise-kb.db（包括 WAL 里还没合并的数据）
  ├─ 完整性检查（integrity_check）
  ├─ 复制 STORAGE_PATH → storage/
  └─ 写 manifest.json（版本、时间、统计）
      │
      ▼
只保留最新 BACKUP_KEEP 份（默认 7 份）
```

- 自动备份：启动约一分钟后，如果最近没有备份就先备份一次；失败一小时后重试。
- 恢复：`npm run restore -- <备份名> --yes`，服务器在运行时拒绝执行。当前数据改名为 `*.before-restore-<时间>` 保留，不删除。
- 安全：备份接口只返回备份名称和数量，不返回路径，不提供下载或恢复；`BACKUP_DIR` 不能放在 `STORAGE_PATH` 里面。

---

## 16. 前端设计系统

### 架构选型

**为什么不用 React/Vue？**
- 由 Express 直接提供静态文件，不需要构建流水线
- 功能相对固定，不需要组件化带来的复杂度
- 部署时只有一个 Node 进程，没有前端构建步骤

### 页面

| 页面 | 文件 | 内容 |
|------|------|------|
| 登录 | login.html | 登录表单，流场背景动画 |
| 问答 | index.html + chat.js | 知识库列表、对话历史、流式问答、出处预览、知识库概况 |
| 管理控制台 | manage.html + manage.js | 知识库与文档、成员、用户、审计、反馈与知识缺口、API 接入、设置与备份 |

静态资源带版本号（如 `style.css?v=40`），修改后要同步更新版本号，避免浏览器缓存旧文件。

### CSS 设计变量（style.css）

```css
:root {
  --bg, --surface, --border          /* 背景层次 */
  --text, --muted, --light           /* 文字层次 */
  --accent, --accent-d, --accent-lt  /* 强调色 */
  --sb-bg, --sb-accent               /* 侧边栏（始终深色） */
  --tool-bg, --tool-border           /* 工具调用区块 */
  --code-bg, --code-text             /* 代码块 */
  --sh-xs … --sh-xl                  /* 阴影 */
  --r-sm, --r, --r-lg, --r-xl        /* 圆角 */
}
```

深色模式通过 `html[data-theme="dark"]` 覆盖同名变量实现。

### SSE 流式渲染

```javascript
// chat.js
switch (ev.type) {
  case 'text':        // 追加文字，流式渲染 Markdown
  case 'tool_call':   // 插入可折叠的工具调用块
  case 'tool_result': // 在工具调用块里显示结果预览
  case 'done':        // 最终渲染，更新侧边栏
  case 'error':       // 显示错误
}
```

### 出处跳转

回答里的 `文件名:行号`（包括中文文件名和 `手册.md:12-15` 这样的范围）会被识别成链接。点击后打开文档预览，通过 `GET …/preview?line=N` 加载被引用行附近的内容并高亮。使用存储文件名的出处也能找到对应文档，并显示原始文件名。

### 安全的 Markdown 渲染

```javascript
html = DOMPurify.sanitize(marked.parse(raw), {
  ALLOWED_TAGS: [...],      // 段落、标题、列表、表格、代码、链接等
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
})
```

`marked` 没加载时退回到手写的正则渲染，先用 `escHtml()` 转义 HTML 再替换，防止注入。

---

## 17. 安全加固

### 生产环境启动校验

```typescript
// src/server.ts — validateRuntimeConfig()
if (IS_PRODUCTION) {
  // JWT_SECRET：至少 32 个字符，且不是任何已知的示例值
  // ADMIN_PASSWORD：不是默认值或示例值
  // 不满足就抛出中文错误并拒绝启动
}
```

`.env.example` 里的示例值有时会被直接复制使用，所以生产环境必须拦截这些已知的弱值。启动时还会检查 Node.js 版本（src/nodeVersion.ts），低于 22.19 时给出明确提示并退出。

### HTTP 安全响应头

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### 文件上传防护

- 扩展名白名单，不在白名单里的格式（如 .exe、.php）被拒绝，并告诉用户哪些文件被跳过以及原因
- 单个文件最大 50 MB，一次最多 20 个；同步目录总大小最多 500 MB
- 先检查权限再写入文件
- 文件名由服务端生成，不使用用户提交的文件名
- 预览按数据库里的存储文件名查找，不信任客户端传来的路径

### 密码存储

```typescript
bcrypt.hashSync(password, 10)  // cost factor 10，自带 salt
```

### 依赖漏洞门禁

`npm run check` 包含 `npm audit --omit=dev --audit-level=moderate`，CI 必须通过才能合并。

---

## 18. 测试体系

### 测试文件

| 文件 | 覆盖内容 | 用例数 |
|------|---------|--------|
| test/server.test.ts | 完整 REST API：认证、用户、知识库、文档、权限、对话、上传、预览、审计、备份、API 密钥、MCP 路由 | 40 |
| test/searchIndex.test.ts | 全文索引维护、迁移和清理 | 8 |
| test/toolScope.test.ts | 大模型工具的访问范围限制 | 8 |
| test/backup.test.ts | 备份、恢复、清理旧备份 | 6 |
| test/backupScheduler.test.ts | 自动备份计划 | 6 |
| test/mcp.test.ts | MCP 协议和工具 | 4 |
| test/ocr.test.ts | OCR 识别和文字清理 | 4 |
| test/extractInWorker.test.ts | 工作线程提取和超时 | 4 |
| test/proxy.test.ts | 出站代理配置 | 4 |
| test/executor.test.ts | ReasoningStreamFilter、mergeStreamedToolName | 3 |
| test/executorProxy.test.ts | 问答请求走代理 | 3 |
| test/documentChunker.test.ts | 分块（标题携带、CRLF、空章节） | 3 |
| test/knowledgeGaps.test.ts | 知识缺口汇总 | 3 |
| test/nodeVersion.test.ts | Node.js 版本检查 | 3 |
| test/pdfText.test.ts | PDF 文字提取 | 3 |
| test/conversationHistory.test.ts | 历史裁剪 | 2 |
| e2e/app.e2e.ts | 浏览器测试（Playwright） | 14 |

### 接口测试策略（server.test.ts）

测试使用临时数据库和临时存储目录，启动真实的 Express 应用，请求直接打到真实路由 → 真实 SQLite → 真实文件系统，不 mock 数据层。

### 浏览器测试（e2e/）

`npm run test:e2e` 启动一个模拟大模型（e2e/mock-llm.mjs）和一个使用临时数据库的服务器，覆盖登录、问答与 👎 原因、中文文件名的出处跳转、知识库概况、反馈与知识缺口、版本历史与恢复、照片 OCR、上传跳过提示、审计日志、只读的公开知识库、网页备份、创建 API 密钥并用 MCP 客户端连接、用户活跃度和手机布局。CI 里作为单独的任务运行。

### 其他检查脚本

| 命令 | 内容 |
|------|------|
| `npm run codex:smoke` | 检查首页、`/healthz`、`/readyz` |
| `npm run smoke:full` | 对运行中的服务完整走一遍，包括一次真实的模型回答，结束后清理数据 |
| `npm run upgrade:check` | 用上一个版本写入数据，再用当前版本启动，验证升级后数据完整 |
| `npm run bench:search` | 检索索引性能测试 |

---

## 19. 部署与运维

### 快速启动

```bash
npm ci
cp .env.example .env
# 编辑 .env，设置 JWT_SECRET、ADMIN_PASSWORD、LLM_BASE_URL 等
npm run dev      # 开发：用 tsx 直接运行 TypeScript
npm run build    # 生产：编译到 dist/
npm start        # 生产：运行 dist/server.js
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8080 | 监听端口 |
| `JWT_SECRET` | — | 生产环境必须修改，至少 32 个字符的随机字符串 |
| `JWT_EXPIRES_IN` | 24h | Token 有效期 |
| `ADMIN_USERNAME` | admin | 初始管理员用户名 |
| `ADMIN_PASSWORD` | — | 生产环境必须修改 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | 兼容 OpenAI 的大模型接口 |
| `LLM_MAX_TURNS` | 8 | 每次回答最多调用几轮工具 |
| `EMBEDDING_MODEL` | 空 | 设置后启用向量检索 |
| `HISTORY_MAX_MESSAGES` / `HISTORY_MAX_CHARS` | 40 / 40000 | 发给模型的历史上限 |
| `QA_RATE_MAX` / `QA_RATE_WINDOW_MS` | 20 / 60000 | 每个用户的问答频率限制（每分钟 20 次） |
| `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_MS` | 10 / 900000 | 登录频率限制 |
| `SYNC_MAX_FILES` / `SYNC_MAX_TOTAL_MB` | 1000 / 500 | 单次同步上限 |
| `SYNC_ALLOWED_ROOTS` | 空 | 允许同步的服务器目录 |
| `EXTRACT_TIMEOUT_SECONDS` | 120 | PDF/Office 提取超时 |
| `OCR_ENABLED` / `OCR_MAX_PAGES` | true / 100 | OCR 开关和每个 PDF 的页数上限 |
| `BACKUP_DIR` / `BACKUP_KEEP` / `BACKUP_INTERVAL_HOURS` | backups / 7 / 0 | 备份位置、保留份数、自动备份间隔 |
| `STORAGE_PATH` / `DB_PATH` | ./storage / ./data/enterprise-kb.db | 存储位置 |
| `CORS_ORIGIN` | 空 | 允许跨域的来源 |
| `TRUST_PROXY` | false | 是否信任反向代理的 X-Forwarded-For |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 空 | 出站代理 |

完整说明见 `.env.example` 和 `DEPLOYMENT.md`。

### 健康检查

| 接口 | 说明 |
|------|------|
| `GET /healthz` | 进程是否存活，始终返回 200 |
| `GET /readyz` | 是否就绪，包括大模型接口能否连通 |

### Docker

`docker-compose.yml` 把数据库和文档分别保存在 `enterprise_kb_data`、`enterprise_kb_storage` 两个命名数据卷里，容器以 `node` 用户运行，默认每天自动备份到数据卷内的 `/app/data/backups`。

### CI 与发布

- `.github/workflows/ci.yml`：`npm ci` → `npm run check`（编译 + 测试 + 依赖审计），浏览器测试作为单独的任务。
- `.github/workflows/release.yml`：推送 `v*` tag 时重新检查、打包，并从 `CHANGELOG.md` 提取对应版本的说明发布 GitHub Release。流程见 `RELEASE.md`。
- Dependabot 每周检查 npm 依赖和 GitHub Actions 的更新。

---

## 附录：项目文件结构

```
enterprise-kb/
├── src/
│   ├── server.ts             # Express 主服务和所有路由、后台队列
│   ├── db.ts                 # 数据访问层、迁移、检索
│   ├── auth.ts               # JWT、API 密钥、认证中间件
│   ├── mcp.ts                # MCP 协议处理和知识库工具
│   ├── executor.ts           # 大模型工具调用循环
│   ├── tools.ts              # SearchDocs、KBStats 工具
│   ├── toolAdapter.ts        # claude-tools-kit 适配
│   ├── toolScope.ts          # 工具访问范围限制
│   ├── prompt.ts             # 系统提示词
│   ├── documentChunker.ts    # 结构感知分块
│   ├── documentText.ts       # PDF/Office 文字提取
│   ├── pdfText.ts            # PDF 逐页提取
│   ├── ocr.ts                # OCR 识别
│   ├── runInWorker.ts        # 工作线程运行与超时
│   ├── extractWorker.ts      # 文字提取工作线程入口
│   ├── extractInWorker.ts    # 主线程调用提取的封装
│   ├── embedding.ts          # 向量生成（可选）
│   ├── conversationHistory.ts# 历史裁剪
│   ├── knowledgeGaps.ts      # 知识缺口汇总
│   ├── backup.ts             # 备份与恢复
│   ├── backupScheduler.ts    # 自动备份计划
│   ├── backupWorker.ts       # 备份工作线程入口
│   ├── backup-cli.ts         # backup / restore 命令
│   ├── proxy.ts              # 出站代理
│   └── nodeVersion.ts        # Node.js 版本检查
├── public/
│   ├── index.html · chat.js        # 问答页
│   ├── manage.html · manage.js     # 管理控制台
│   ├── login.html                  # 登录页
│   └── style.css                   # 设计系统
├── test/                     # Vitest 测试和测试用文件
├── e2e/                      # Playwright 浏览器测试和模拟大模型
├── scripts/                  # 冒烟检查、升级检查、性能测试
├── packages/claude-tools-kit/# 随项目提供的工具包（Read/Glob/Grep）
├── .github/                  # CI、发布流程、Dependabot、PR 模板
├── Dockerfile · docker-compose.yml · .env.example
├── README.md · DEPLOYMENT.md · RELEASE.md · CHANGELOG.md
├── SECURITY_OWNERSHIP.md · AGENTS.md · GUIDE.md
└── TECHNICAL.md
```

---

*Enterprise KB v1.3.0：从数据库到前端完整自研，适合企业内网私有化部署。*
