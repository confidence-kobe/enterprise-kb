# Enterprise KB — 技术文档

> 版本：v1.0.0 · 最后更新：2026-06-26

---

## 目录

1. [项目概述与核心亮点](#1-项目概述与核心亮点)
2. [技术栈全景](#2-技术栈全景)
3. [系统架构](#3-系统架构)
4. [数据库设计](#4-数据库设计)
5. [认证与权限体系](#5-认证与权限体系)
6. [文档管道：上传 → 分块 → 索引](#6-文档管道上传--分块--索引)
7. [混合检索算法](#7-混合检索算法)
8. [LLM 对话引擎](#8-llm-对话引擎)
9. [对话历史管理](#9-对话历史管理)
10. [文件夹同步机制](#10-文件夹同步机制)
11. [审计日志](#11-审计日志)
12. [前端设计系统](#12-前端设计系统)
13. [安全加固](#13-安全加固)
14. [测试体系](#14-测试体系)
15. [部署与运维](#15-部署与运维)

---

## 1. 项目概述与核心亮点

Enterprise KB 是一套面向企业内部的**本地知识库问答系统**。用户将文档上传（或从本地目录同步）到知识库，系统自动建立全文检索索引，之后通过自然语言向 LLM 提问，LLM 利用工具调用自主检索知识库并给出有来源标注的回答。

### 核心亮点

| 亮点 | 说明 |
|------|------|
| **零外部依赖检索** | 基于 SQLite FTS5，无需 Elasticsearch / Milvus 等额外服务 |
| **结构感知分块** | 按 Markdown / 中文标题切块，标题随块携带，保留语义上下文 |
| **四级混合召回** | 严格 AND → 宽松 OR → 文件名匹配 → 子串回退，覆盖各种查询风格 |
| **流式工具调用** | SSE 实时推送每个 token 和工具执行过程，体感延迟极低 |
| **可信历史裁剪** | 服务端按轮次 + 字符预算选择历史，防止 context 超限 |
| **LLM 无关** | 对接任意 OpenAI 兼容接口：Ollama、MiniMax、OpenAI、本地模型 |
| **本地文件夹同步** | 增量镜像本地目录，文件变更自动重建索引 |
| **审计日志** | 所有写操作落库，管理员可查看完整操作溯源 |
| **生产安全校验** | 启动时强制拒绝弱密码 / 弱 JWT Secret |
| **零运维数据库** | SQLite WAL 模式，单文件，无需单独数据库服务 |

---

## 2. 技术栈全景

### 运行时与语言

| 层 | 技术 | 版本 | 选择原因 |
|----|------|------|---------|
| 运行时 | Node.js | 20+ | 原生 ESM、内置 fetch、稳定 LTS |
| 语言 | TypeScript | 5.7 | 静态类型防止运行时错误，IDE 补全 |
| 框架 | Express | 5.0 | 成熟、生态最广；v5 原生支持 async 路由 |
| 数据库 | better-sqlite3 | 11 | 同步 API，无回调地狱；SQLite FTS5 内置全文检索 |
| 文件上传 | multer | 2.1 | 流式写盘，无内存缓冲 |
| LLM 客户端 | openai SDK | 4.77 | 统一调用所有 OpenAI 兼容接口 |
| PDF 解析 | pdf-parse | 1.1 | 纯 JS，无系统依赖 |
| 认证 | jsonwebtoken + bcryptjs | 9 / 2 | JWT 无状态 + bcrypt 密码哈希 |
| 跨域 | cors | 2.8 | 白名单配置，按需开启 |

### 前端

| 技术 | 说明 |
|------|------|
| 纯原生 JS (Vanilla) | 无框架，无构建步骤，直接由 Express 静态服务 |
| marked.js (CDN) | Markdown 渲染 |
| DOMPurify (CDN) | XSS 净化，防止 LLM 输出注入脚本 |
| CSS 设计系统 | Inter 字体，Linear 侧边栏美学，Vercel 卡片风格，深色模式 |
| Server-Sent Events | 流式接收 LLM token 和工具调用事件 |

### 工具链

| 工具 | 用途 |
|------|------|
| tsx | 开发期直接运行 TypeScript，无需预编译 |
| vitest | 单元测试，兼容 ESM |
| supertest | HTTP 集成测试 |
| dotenv | .env 环境变量注入 |
| npm audit | CI 依赖漏洞门禁（moderate 级别） |

---

## 3. 系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────┐
│                     Browser                         │
│  login.html   index.html (chat.js)   manage.html   │
│                   ↕ HTTP / SSE                      │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              Express 5  (src/server.ts)             │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │  Auth    │  │  REST    │  │   SSE /ask 路由   │  │
│  │Middleware│  │  Routes  │  │  (流式 LLM 对话)  │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│        │              │               │             │
│        ▼              ▼               ▼             │
│  ┌──────────────────────────────────────────────┐   │
│  │           src/db.ts (数据访问层)              │   │
│  │  Users · KBs · Documents · Conversations     │   │
│  │  Messages · AuditEvents · FTS5 Index         │   │
│  └──────────────────────────────────────────────┘   │
│                       │                             │
│              ┌─────────────────┐                    │
│              │  SQLite (WAL)   │                    │
│              │  data/*.db      │                    │
│              └─────────────────┘                    │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │         src/executor.ts (LLM 引擎)            │   │
│  │  ReasoningStreamFilter · ToolCall 累积循环    │   │
│  └──────────────────────────────────────────────┘   │
│                       │                             │
│              ┌──────────────────┐                   │
│              │ OpenAI 兼容接口  │                   │
│              │ Ollama/MiniMax/  │                   │
│              │ OpenAI/其他      │                   │
│              └──────────────────┘                   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  storage/kb_<id>/  (文件存储)                 │   │
│  │  上传文件 · PDF转文本 · 同步镜像文件          │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 请求流（一次问答）

```
用户输入问题
      │
      ▼
POST /api/kbs/:id/ask
      │
      ├─ JWT 校验 (requireAuth)
      ├─ KB 访问权限检查
      ├─ 从 DB 加载对话历史 → buildTrustedHistory() 裁剪
      │
      ▼
SSE 流建立 (text/event-stream)
      │
      ▼
LLMExecutor.run(question, tools, history, abortSignal)
      │
      ├─ 循环 (最多 MAX_TURNS 轮)
      │     │
      │     ├─ 调用 LLM API (stream: true)
      │     ├─ ReasoningStreamFilter 过滤 <think> 块
      │     ├─ 实时推送 {type:'text'} 事件给浏览器
      │     ├─ 累积工具调用 chunks
      │     │
      │     ├─ finish_reason === 'stop' → 退出循环
      │     │
      │     └─ 执行工具调用
      │           ├─ SearchDocs → FTS5 混合检索
      │           ├─ Read → 读取文件
      │           ├─ Glob → 文件名模式扫描
      │           ├─ Grep → 正则内容搜索
      │           └─ KBStats → 知识库统计
      │
      ▼
结果持久化 (messages 表)
      │
      ▼
推送 {type:'done'} 事件，关闭 SSE
```

---

## 4. 数据库设计

### ER 图

```
users
  id · username · password_hash · role · created_at
    │
    ├──────────────────────────────────┐
    │                                  │
    ▼                                  ▼
knowledge_bases                    conversations
  id · name · description             id · kb_id · user_id
  storage_path · owner_id             title · is_pinned
  is_public                           created_at · updated_at
  sync_source_path · sync_last_at         │
  sync_last_result                        ▼
    │                               messages
    │    kb_access                    id · conversation_id
    ├──► kb_id + user_id (M:N)        role · content
    │                                 tool_calls · tool_call_id
    ▼                                 seq · created_at
documents
  id · kb_id · filename
  original_name · size
  source_type (upload/text/sync)
  source_path · source_mtime
  index_version · index_status
  index_error · indexed_at

doc_fts (FTS5 虚拟表)
  content · original_name
  file_path · kb_id
  doc_id · chunk_line

audit_events
  id · user_id · username · action
  entity_type · entity_id · kb_id
  detail · ip · created_at
```

### 关键设计决策

**为什么用 SQLite 而非 PostgreSQL？**
企业内部部署场景要求零运维——不需要单独数据库服务、不需要 DBA、备份即复制单文件。WAL 模式支持并发读，对知识库系统的并发量完全够用。

**FTS5 虚拟表设计**
`doc_fts` 使用 `unicode61` tokenizer（支持中文字符边界），`UNINDEXED` 字段（`original_name`、`file_path`、`kb_id`、`doc_id`、`chunk_line`）不参与全文索引但可随结果返回，避免二次 JOIN。

**幂等迁移策略**
新增列用 `ALTER TABLE ... ADD COLUMN` 包裹在 `try/catch` 中。已存在则静默忽略，无需版本管理工具。适合单进程单文件的部署特征。

**WAL 模式**
```sql
PRAGMA journal_mode = WAL;   -- 读写并发，写入不阻塞读取
PRAGMA foreign_keys = ON;    -- 级联删除保证孤儿数据不产生
```

---

## 5. 认证与权限体系

### JWT 无状态认证

```
登录流程：
  POST /api/auth/login
    → 校验用户名密码 (bcrypt.compare)
    → 签发 JWT (HS256, 24h 有效期)
    → 返回 token

后续请求：
  Authorization: Bearer <token>
    → requireAuth 中间件验证签名 + 过期时间
    → 注入 req.user = { userId, username, role }
```

**为什么选 JWT 而非 Session？**
无状态设计使服务重启不影响已登录用户，无需 Redis / 数据库 Session 存储，适合单实例本地部署。

### 三层权限模型

```
角色层
  admin  → 所有操作（含用户管理、审计日志、全局配置）
  user   → 只能操作自己可访问的知识库

知识库层（canUserAccessKb）
  公开 KB (is_public=1)  → 任意已登录用户
  私有 KB                → owner_id = 当前用户
                        OR kb_access 表中有授权记录

中间件层
  requireAuth   → JWT 有效即通过
  requireAdmin  → role === 'admin'
```

### 登录限速

用 in-memory `Map<ip, {count, resetAt}>` 实现，窗口期（默认 15 分钟）内最多 10 次失败，超限返回 429。选择内存实现而非数据库的原因：重启自动清零符合预期，攻击者重启后需重新尝试；单实例部署无需跨进程共享状态。

---

## 6. 文档管道：上传 → 分块 → 索引

### 管道流程

```
用户上传文件 / 文字创建 / 文件夹同步
         │
         ▼
   文件扩展名白名单校验
   (.txt .md .pdf .ts .js .py .go ... 共 17 种)
         │
         ▼
   写入 storage/kb_<id>/<uuid><ext>
         │
         ▼
   createDoc() 写入 documents 表
   index_status = 'pending'
         │
         ▼
   加入后台索引队列 (内存数组)
         │
         ▼
   ┌── PDF? ──┐
   │          │
  是         否
   │          │
   ▼          ▼
pdf-parse   fs.readFile(utf-8)
提取文本          │
   │          │
   └────┬─────┘
        │
        ▼
   chunkDocument(text)   ← src/documentChunker.ts
        │
        ▼
   indexDocContent()     ← src/db.ts
   写入 doc_fts 虚拟表
   index_status = 'ready'
```

### 结构感知分块算法（src/documentChunker.ts）

**问题背景**
直接将整篇文档塞进 FTS5 会丢失位置信息，也无法做 snippet 定位。均匀切块（每 N 字符一块）会切断语义单元。

**实现原理**
```
识别分割点：
  Markdown 标题 (# / ## / ### ...)
  中文章节标题 (第一章 / 一、/ （一）...)

按分割点将文档切成若干段落，每段不超过 maxChars（默认 1200）字符。
  若单段超出 → 再次细分，保留 overlapLines 行重叠避免边界截断语义。

每个 chunk 携带：
  { content, heading, startLine }
  content  = "# 标题\n\n正文..."   ← 标题随块携带，LLM 可获知上下文
  heading  = '安装说明'
  startLine = 42                   ← 用于在源文件中定位
```

**为什么标题随块携带？**
LLM 读到片段时能知道所属章节，回答不会脱离上下文。纯内容块缺失标题会导致 LLM 混淆"这段话是关于什么的"。

---

## 7. 混合检索算法

### 四级召回漏斗

```
Query: "部署 配置 端口"
          │
          ▼
  ① 严格 FTS5 AND
     MATCH '"部署" AND "配置" AND "端口"'
     BM25 排序，取前 candidateLimit 条
          │
          ▼ (若严格 AND 结果不足)
  ② 宽松 FTS5 OR
     MATCH '"部署" OR "配置" OR "端口"'
     补充不包含全部词的候选
          │
          ▼ (始终执行)
  ③ 子串 LIKE 扫描
     content LIKE '%部署%'
     OR original_name LIKE '%部署%'
     兜底覆盖分词未命中的情况
          │
          ▼
  候选集合合并（de-duplicate by doc_id:chunk_line）
          │
          ▼
  ④ 多维打分 scoreCandidate()
     +80  严格 AND 命中
     +35  宽松 OR 命中
     +20  子串命中
     +240 文件名完全匹配
     +160 文件名包含短语
     +120 内容包含完整短语
     +45  文件名包含单词
     +12  内容包含单词
     +15  BM25 排名靠前加成
          │
          ▼
  取分数最高的 limit 条，生成 snippet
```

**Snippet 生成**
找到第一个匹配词位置，取前 120 字符 + 匹配词（加 `>>>高亮<<<` 标记）+ 后 240 字符，供 LLM 和用户快速定位。

**为什么不用纯向量检索？**
1. 向量检索需要 Embedding 模型，增加本地部署复杂度
2. BM25 + 子串对关键词精确匹配优于语义向量
3. 企业内文档多为结构化技术文档，精确词匹配比语义相似更重要
4. 四级漏斗在无精确匹配时自动降级，召回率有保障

---

## 8. LLM 对话引擎

### LLMExecutor 工具调用循环

```
src/executor.ts — LLMExecutor.run()

while (turns < maxTurns):
  │
  ├─ 调用 OpenAI API (stream: true)
  │
  ├─ for chunk in stream:
  │     ├─ delta.content → ReasoningStreamFilter.push()
  │     │     ├─ 遇到 <think> → 进入 inThink 模式，丢弃内容
  │     │     ├─ 遇到 </think> → 退出 inThink，恢复输出
  │     │     └─ 正常文本 → 原样返回
  │     │
  │     └─ delta.tool_calls → 按 index 累积
  │           name: mergeStreamedToolName() 处理分片名称
  │           arguments: 字符串拼接
  │
  ├─ finish_reason === 'stop' → break
  ├─ 无工具调用 → break
  │
  └─ for toolCall in accumulated:
        ├─ 解析 JSON arguments
        ├─ 找到对应 LLMTool
        ├─ tool.execute(params, kbPath)
        ├─ onEvent({ type:'tool_result', ... })  → SSE 推送
        └─ 构造 role:'tool' message 加入对话

return { response, turns, messages }
```

### ReasoningStreamFilter

部分思考型模型（如 DeepSeek-R1、QwQ）在流式输出中穿插 `<think>...</think>` 推理块，这些内容不应展示给用户。

```
状态机：
  inThink = false (默认)
    收到 "<think>" → inThink = true，丢弃后续
    收到 "</think>" → inThink = false，恢复输出

  边界处理：
    "<thi" + "nk>" 跨 chunk 分片 → buffer 保留最多 6 字符
    判断是否是标签的不完整前缀 (partialOpeningTagLength)
    是 → 暂存，等待下一个 chunk
    否 → 立即输出
```

### 工具集

| 工具 | 实现来源 | 功能 |
|------|---------|------|
| SearchDocs | src/tools.ts | FTS5 混合全文检索，首选检索工具 |
| Read | claude-tools-kit | 按路径读取文件（支持 offset/limit） |
| Glob | claude-tools-kit | 文件名模式扫描（**/*.md 等） |
| Grep | claude-tools-kit | 正则内容搜索，支持多种输出模式 |
| KBStats | src/tools.ts | 统计知识库文件数量、行数、大小 |

Glob / Grep / Read 来自 vendored `claude-tools-kit`（从 Claude Code 主项目提取），保证与 Claude Code 内置工具行为一致。

### 系统提示词策略（src/prompt.ts）

```
检索工作流指导：
  1. 优先 SearchDocs，一次定位
  2. 找到路径后用 Read 精读全文
  3. SearchDocs 无结果时降级到 Glob/Grep
  4. 最多 3 轮检索，避免无效循环

回答规范：
  - 必须标注来源文件名:行号
  - 知识库无内容时明确说"未找到"，不猜测
  - 只能读取文件，不能修改

边界限制：
  - 只在 kbPath 目录内操作
  - 不访问外部网络
```

---

## 9. 对话历史管理

### 问题背景

每轮对话结束后，完整的 user/assistant/tool 消息序列都持久化到 `messages` 表。下次提问时需要将历史注入 LLM，但：
- 历史过长会超出模型 context window
- 截断不当会切断工具调用与结果的配对，导致 API 报错

### buildTrustedHistory（src/conversationHistory.ts）

```
输入：messages 表中的所有历史行（按 seq 排序）

步骤：
  1. 按"以 user 消息开头"将历史分组成"轮次"
     跳过开头的孤儿 tool/assistant 消息

  2. 从最新轮次开始向前，累积消息直到：
     - 已用消息数 ≥ maxMessages (默认 40)
     - 已用字符数 ≥ maxChars   (默认 40000)

  3. 若最新一轮本身超出字符预算（极长工具结果）：
     保留该轮但裁剪超大内容
     content = head(2000字符) + '\n[earlier content omitted]\n' + tail(500字符)

  4. 返回：
     { messages, totalMessages, truncated }
     truncated = true 表示历史有被丢弃，前端显示提示
```

**为什么按轮次而非按消息数截断？**
工具调用产生 `assistant(tool_calls)` + `tool(result)` 消息对，必须成对出现，否则 OpenAI API 返回 400。按轮次边界截断保证消息序列的完整性。

---

## 10. 文件夹同步机制

### 同步流程

```
管理员配置 sync_source_path（本地目录绝对路径）
                │
                ▼
        POST /api/kbs/:id/sync
                │
        scanSyncDirectory(root)
                │
                ├─ 递归遍历目录
                ├─ 跳过隐藏目录、node_modules、dist 等
                ├─ 跳过不支持的扩展名
                ├─ 跳过 > 50MB 的单文件
                ├─ 跳过符号链接（安全）
                └─ 累计文件数 > SYNC_MAX_FILES (1000)
                   或总大小 > SYNC_MAX_TOTAL_MB (500MB) → 截止

                │
                ▼
        对比 documents 表中 source_type='sync' 的现有记录
                │
          ┌─────┴──────────────────┐
          │                        │
      新文件（不在 DB）        已有文件（在 DB）
          │                        │
          ▼                        ▼
      createDoc()          source_mtime 或 source_size 变化？
      加入索引队列              是 → updateDocFromSync()
                                      重置 index_status='pending'
                                      加入索引队列
                               否 → 跳过（增量）
          │
          ▼
      删除 DB 中有记录但源目录已不存在的文件
                │
                ▼
        返回 SyncSummary { added, updated, removed, skipped, errors }
```

**路径安全**
`isPathInside(parent, child)` 用 `path.relative()` 检验 child 是否在 parent 内，防止路径穿越攻击。`normalizeSourcePath()` 解析所有 `../` 后再比较。

---

## 11. 审计日志

所有写操作在路由层调用 `createAuditEvent()` 落库：

| 操作类型 | entity_type |
|---------|------------|
| 用户登录/登出 | auth |
| 创建/删除用户 | user |
| 创建/删除/修改知识库 | kb |
| 上传/删除文档 | document |
| 文件夹同步 | sync |
| 切换 LLM 模型 | config |

每条记录存储：`user_id`、`username`、`action`、`entity_type`、`entity_id`、`kb_id`、`detail`（JSON，限 4000 字符）、`ip`。

管理员通过 `GET /api/admin/audit-events` 查询，支持按 `action`、`username`、`kb_id` 过滤，分页返回。

---

## 12. 前端设计系统

### 架构选型

**为什么不用 React/Vue？**
- 系统由 Express 统一服务静态文件，无需构建流水线
- 功能相对固定，无需组件复用的复杂度
- 纯 Vanilla JS + CSS 变量实现 < 300KB（含所有页面），加载极快
- 服务器端无 Node 构建进程，降低部署复杂度

### CSS 设计令牌（style.css v21）

```css
:root {
  /* 色彩系统 */
  --bg, --surface, --border     /* 背景层次 */
  --text, --muted, --light      /* 文字层次 */
  --accent, --accent-d, --accent-lt  /* 强调色 */

  /* 侧边栏（始终深色） */
  --sb-bg: #0d1321;
  --sb-accent: #60a5fa;

  /* 语义组件令牌 */
  --tool-bg, --tool-border, --tool-accent  /* 工具调用区块 */
  --code-bg, --code-text                   /* 代码块 */
  --ref-bg, --ref-border, --ref-text       /* 来源引用 */

  /* 阴影梯度（5 级） */
  --sh-xs, --sh-sm, --sh, --sh-lg, --sh-xl

  /* 圆角梯度（4 级） */
  --r-sm(6px), --r(8px), --r-lg(12px), --r-xl(16px)
}
```

深色模式通过 `html[data-theme="dark"]` 覆写同名令牌，无需 class 切换逻辑。

### SSE 流式渲染

```javascript
// chat.js — readSSE()

switch (ev.type) {
  case 'text':
    // 实时追加 Markdown，流式渲染
    responseText.dataset.raw += ev.text
    renderMd(responseText, raw, /* streaming= */ true)
    break

  case 'tool_call':
    // 插入可折叠工具调用块
    addToolCall(toolsLog, ev.name, ev.input)
    break

  case 'tool_result':
    // 在工具调用块内填入结果预览（前 5 行）
    lastToolBody.textContent = preview
    lastToolBody.className = ev.isError ? 'tool-err' : 'tool-ok'
    break

  case 'done':
    // 最终渲染、持久化历史、更新侧边栏
    renderMd(responseText, raw, /* streaming= */ false)
    break
}
```

### 安全的 Markdown 渲染

```javascript
// 主路径：marked + DOMPurify
html = DOMPurify.sanitize(marked.parse(raw), {
  ALLOWED_TAGS: ['p','br','strong','em','code','pre',
                 'blockquote','h1'~'h6','ul','ol','li',
                 'table','thead','tbody','tr','th','td',
                 'a','span','details','summary','hr'],
  ALLOWED_ATTR: ['href','class','target','rel'],
  ALLOW_DATA_ATTR: false,
})

// 降级路径（CDN 未加载）：手写正则 + escHtml()
```

`escHtml()` 先对原始字符串 HTML 实体编码，再做正则替换，防止用户输入或 LLM 输出中的 `<script>` 等注入。

---

## 13. 安全加固

### 生产启动校验

```typescript
// src/server.ts — validateRuntimeConfig()

if (IS_PRODUCTION) {
  // JWT_SECRET：长度 ≥ 32，不等于任何已知示例值
  if (!jwtSecret || jwtSecret.length < 32
      || jwtSecret === DEFAULT_JWT_SECRET
      || jwtSecret === EXAMPLE_JWT_SECRET) {
    throw new Error('JWT_SECRET must be set...')
  }

  // ADMIN_PASSWORD：不得为默认值或示例值
  if (!process.env.ADMIN_PASSWORD
      || process.env.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD
      || process.env.ADMIN_PASSWORD === EXAMPLE_ADMIN_PASSWORD) {
    throw new Error('ADMIN_PASSWORD must be changed...')
  }
}
```

**为什么同时拦截两个弱密码值？**
`.env.example` 中的 `change-this-admin-password` 有时会被开发者直接复制使用而忘记修改，必须在 `IS_PRODUCTION` 时拦截两个已知弱值。

### HTTP 安全响应头

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### 文件上传防护

- 扩展名白名单（17 种），拒绝 .exe / .sh / .php 等
- 单文件限制 50MB，总同步目录限制 500MB
- multer `diskStorage` 直接写盘，不经过内存 Buffer
- 文件名由服务端生成（`uuid + ext`），忽略用户提交的 filename

### 密码存储

```typescript
bcrypt.hashSync(password, 10)  // cost factor 10
```

bcrypt 内置 salt，每次哈希值不同，防止彩虹表攻击。

### 依赖漏洞门禁

`npm run check` 脚本包含：
```bash
npm audit --omit=dev --audit-level=moderate
```
CI 强制通过才能合并，所有 moderate 及以上漏洞必须修复。

---

## 14. 测试体系

### 测试文件

| 文件 | 覆盖模块 | 用例数 |
|------|---------|--------|
| test/server.test.ts | 完整 REST API（认证、用户、KB、文档、权限、对话） | 7 |
| test/executor.test.ts | ReasoningStreamFilter、mergeStreamedToolName | 3 |
| test/documentChunker.test.ts | chunkDocument（标题携带、CRLF、空章节） | 3 |
| test/conversationHistory.test.ts | buildTrustedHistory（轮次裁剪、内容截断） | 2 |

### 集成测试策略（server.test.ts）

```typescript
// 每个 describe 块：
beforeAll(async () => {
  // 使用临时 DB 路径 + 临时 storage 路径
  // 启动真实 Express 应用
  server = app.listen(0)  // 随机端口
})

afterAll(async () => {
  server.close()
  // 清理临时文件
})
```

测试直接命中真实 Express 路由 → 真实 SQLite → 真实文件系统，不 mock 数据层，避免 mock 与真实行为不一致。

### 端到端 Smoke Test（scripts/full-smoke.mjs）

```
① 健康检查 /healthz
② 管理员登录，获取 token
③ 创建普通用户
④ 创建知识库
⑤ 上传文档
⑥ 权限测试（普通用户无法访问未授权 KB）
⑦ 授权访问
⑧ 创建对话（跳过真实 LLM 调用）
⑨ 清理（删除 KB、用户）
```

---

## 15. 部署与运维

### 快速启动

```bash
npm ci
cp .env.example .env
# 编辑 .env 设置 JWT_SECRET、ADMIN_PASSWORD、LLM_BASE_URL
npm run dev      # 开发：tsx 直接运行 TypeScript
npm run build    # 生产：编译到 dist/
npm start        # 生产：运行 dist/server.js
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8080 | 监听端口 |
| `JWT_SECRET` | — | 必须修改，≥ 32 字符随机字符串 |
| `JWT_EXPIRES_IN` | 24h | Token 有效期 |
| `ADMIN_USERNAME` | admin | 初始管理员用户名 |
| `ADMIN_PASSWORD` | — | 必须修改，不能是示例值 |
| `LLM_BASE_URL` | localhost:11434/v1 | OpenAI 兼容接口 |
| `LLM_API_KEY` | ollama | API Key |
| `LLM_MODEL` | qwen2.5:7b | 模型名 |
| `LLM_MAX_TURNS` | 8 | 单次问答最多工具调用轮次 |
| `HISTORY_MAX_MESSAGES` | 40 | 历史最多消息数 |
| `HISTORY_MAX_CHARS` | 40000 | 历史最多字符数 |
| `SYNC_MAX_FILES` | 1000 | 单次同步最多文件数 |
| `SYNC_MAX_TOTAL_MB` | 500 | 单次同步最大总大小 |
| `STORAGE_PATH` | ./storage | 文件存储目录 |
| `DB_PATH` | ./data/enterprise-kb.db | SQLite 文件路径 |
| `TRUST_PROXY` | false | 是否信任反向代理 X-Forwarded-For |

### Docker Compose 部署

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      NODE_ENV: production
      JWT_SECRET: ${JWT_SECRET}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      LLM_BASE_URL: ${LLM_BASE_URL}
    volumes:
      - enterprise_kb_data:/app/data
      - enterprise_kb_storage:/app/storage

volumes:
  enterprise_kb_data:
  enterprise_kb_storage:
```

### 健康检查端点

| 端点 | 说明 |
|------|------|
| `GET /healthz` | 进程存活检查，始终返回 200 |
| `GET /readyz` | 就绪检查，包含 LLM 接口连通性验证 |

### 备份

SQLite 单文件备份只需复制 `data/enterprise-kb.db`（WAL 模式下热备用 `.backup` pragma 或直接 cp 均可）。上传文件在 `storage/` 目录，同步备份即可。

### CI 流水线

```yaml
# .github/workflows/ci.yml
- run: npm ci
- run: npm run check
# check = build + vitest + npm audit --omit=dev --audit-level=moderate
```

---

## 附录：项目文件结构

```
enterprise-kb/
├── src/
│   ├── server.ts            # Express 主服务，所有路由（1487 行）
│   ├── db.ts                # 数据访问层，SQLite 操作（874 行）
│   ├── auth.ts              # JWT 签发/验证，bcrypt 密码（84 行）
│   ├── executor.ts          # LLM 工具调用循环（261 行）
│   ├── tools.ts             # 工具定义，SearchDocs/KBStats（178 行）
│   ├── toolAdapter.ts       # claude-tools-kit 适配器（69 行）
│   ├── prompt.ts            # 系统提示词构建（46 行）
│   ├── documentChunker.ts   # 结构感知文本分块（119 行）
│   └── conversationHistory.ts # 历史裁剪算法（96 行）
├── public/
│   ├── index.html           # 主聊天页（304 行）
│   ├── chat.js              # 聊天前端逻辑（1457 行）
│   ├── manage.html          # 管理页（417 行）
│   ├── manage.js            # 管理前端逻辑（1254 行）
│   ├── login.html           # 登录页（112 行）
│   └── style.css            # 设计系统（2390 行）
├── test/
│   ├── server.test.ts       # API 集成测试
│   ├── executor.test.ts     # 流式过滤器单元测试
│   ├── documentChunker.test.ts
│   └── conversationHistory.test.ts
├── scripts/
│   ├── codex-smoke.mjs      # 轻量健康检查
│   └── full-smoke.mjs       # 完整 E2E smoke test
├── packages/
│   └── claude-tools-kit/    # vendored 工具包（Glob/Grep/Read）
├── .github/workflows/
│   └── ci.yml               # GitHub Actions CI
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── DEPLOYMENT.md
├── RELEASE.md
└── SECURITY_OWNERSHIP.md
```

---

*Enterprise KB v1.0.0 — 从数据库到前端，完整自研，适合企业内网私有化部署。*
