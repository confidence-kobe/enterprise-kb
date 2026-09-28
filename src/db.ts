/**
 * 数据持久化与检索层 (SQLite Storage & Search Engine)
 *
 * 核心技术架构：
 * 1. 存储引擎：采用 `better-sqlite3` 原生驱动，开启 WAL (Write-Ahead Logging) 预写日志模式，
 *    提供高并发读、事务安全写，无复杂 ORM 开销，极简轻量，高度契合企业私有化部署环境；
 * 2. 混合检索体系 (Hybrid Search)：
 *    - SQLite FTS5 虚拟表 + trigram 三元分词器，原生对 CJK 中日韩字符提供高质量全文检索；
 *    - 向量相似度表 (doc_chunk_vectors) + 余弦相似度计算，提供语义级召回；
 *    - 混合加权打分 (Hybrid Scoring)：综合 BM25 排名、词频统计、标题精确匹配、子串加分与向量距离；
 * 3. 完整业务实体：包含用户(User)、知识库(KnowledgeBase)、权限(Access)、文档(Document)、
 *    对话(Conversation)、消息(Message)、反馈评价(Feedback)、审计日志(Audit)及 MCP 访问密钥(McpApiKey)。
 */

import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import bcrypt from 'bcryptjs'
import { chunkDocument } from './documentChunker.js'

// ── 类型定义 ──────────────────────────────────────────

/**
 * 系统用户实体
 */
export interface User {
  /** 用户唯一数字 ID (主键自增) */
  id: number
  /** 唯一登录用户名 */
  username: string
  /** 经过 bcrypt 加盐哈希后的密码散列值 */
  password_hash: string
  /** 用户系统角色：admin (超级管理员) | user (普通员工) */
  role: 'admin' | 'user'
  /** 账户创建时间戳（秒级） */
  created_at: number
}

/**
 * 知识库空间实体
 */
export interface KnowledgeBase {
  /** 知识库唯一数字 ID (主键自增) */
  id: number
  /** 知识库名称 */
  name: string
  /** 知识库描述说明 */
  description: string | null
  /** 知识库文件在服务器本地的存储目录路径 */
  storage_path: string
  /** 所有者/创建者用户 ID */
  owner_id: number
  /** 是否公开可见：0 (私有/按权限可见) | 1 (全员公开) */
  is_public: number
  /** 本地文件夹同步源路径（用于文件自动同步） */
  sync_source_path: string | null
  /** 最近一次同步执行时间戳（秒级） */
  sync_last_at: number | null
  /** 最近一次同步执行结果描述或报错信息 */
  sync_last_result: string | null
  /** 知识库专有的定制系统级 Prompt */
  system_prompt: string | null
  /** 知识库创建时间戳（秒级） */
  created_at: number
}

/**
 * 文档来源方式类型
 */
export type DocumentSourceType = 'upload' | 'text' | 'sync'

/**
 * 知识库文档实体
 */
export interface Document {
  /** 文档唯一标识 ID */
  id: number
  /** 所属知识库 ID */
  kb_id: number
  /** 存储在磁盘上的物理文件名 */
  filename: string
  /** 用户上传时的原始文件名 */
  original_name: string
  /** 文件字节大小 (Bytes) */
  size: number
  /** 入库上传时间戳（秒级） */
  uploaded_at: number
  /** 文档导入来源：upload (上传) | text (文本录入) | sync (本地同步) */
  source_type: DocumentSourceType
  /** 本地同步源文件的绝对物理路径 */
  source_path: string | null
  /** 原始文件最后修改时间戳（毫秒级，用于变更比对） */
  source_mtime: number | null
  /** 原始文件字节大小（用于变更比对） */
  source_size: number | null
  /** 索引版本号（与当前 DOC_INDEX_VERSION 不一致时需重建） */
  index_version: number
  /** 索引处理状态：pending (待处理) | processing (切片向量化中) | ready (就绪) | error (失败) */
  index_status: 'pending' | 'processing' | 'ready' | 'error'
  /** 索引处理异常报错信息 */
  index_error: string | null
  /** 索引构建完成时间戳（秒级） */
  indexed_at: number | null
  /** 文档内容简述或摘要 */
  summary: string | null
  /** 全文检索切片数量统计（动态聚合） */
  chunk_count?: number
  /** 向量切片数量统计（动态聚合） */
  vec_count?: number
}

/**
 * 问答对话会话实体
 */
export interface Conversation {
  /** 会话唯一标识 ID */
  id: number
  /** 所属知识库 ID */
  kb_id: number
  /** 会话归属的用户 ID */
  user_id: number
  /** 对话标题 */
  title: string
  /** 是否置顶固定：0 (否) | 1 (是) */
  is_pinned: number
  /** 会话创建时间戳（秒级） */
  created_at: number
  /** 会话最后更新/交互时间戳（秒级） */
  updated_at: number
}

/**
 * 对话历史消息行实体
 */
export interface MessageRow {
  /** 消息唯一 ID */
  id: number
  /** 所属会话 ID */
  conversation_id: number
  /** 消息角色：user | assistant | tool */
  role: string
  /** 消息文本正文 */
  content: string | null
  /** 工具调用参数 JSON 序列化字符串 */
  tool_calls: string | null
  /** 对应工具调用的 call_id */
  tool_call_id: string | null
  /** 会话内部的时序单调递增序号 (从 0 开始) */
  seq: number
  /** 消息创建时间戳（秒级） */
  created_at: number
}

/**
 * 系统审计日志事件实体
 */
export interface AuditEvent {
  /** 审计日志唯一 ID */
  id: number
  /** 操作人用户 ID */
  user_id: number | null
  /** 操作人用户名 */
  username: string | null
  /** 操作动作编码（如 kb.create, doc.upload） */
  action: string
  /** 操作实体分类（如 kb, doc, user） */
  entity_type: string
  /** 目标实体 ID */
  entity_id: number | null
  /** 涉及的知识库 ID */
  kb_id: number | null
  /** 操作详情 JSON 字符串 */
  detail: string | null
  /** 客户端来源 IP */
  ip: string | null
  /** 事件记录时间戳（秒级） */
  created_at: number
}

// ── 数据库初始化与迁移 ────────────────────────────────────

let db: Database.Database

/**
 * 初始化 SQLite 数据库实例并执行自动增量迁移
 *
 * 核心配置与机制：
 * 1. 自动递归创建存放 `.db` 文件的物理目录；
 * 2. 开启 `journal_mode = WAL` 提升并发读写吞吐，开启外键约束 `foreign_keys = ON`；
 * 3. 幂等初始化核心业务数据表 (users, knowledge_bases, kb_access, documents, conversations, messages, audit_events)；
 * 4. 幂等执行动态 DDL 升级（自动检测缺失列并补齐，如 is_pinned, index_status, sync_source_path, reason, comment 等）；
 * 5. 全文检索升级：将历史版本的 unicode61 分词器平滑升级为 CJK 友好的 trigram 分词器；
 * 6. 创建向量存储表 `doc_chunk_vectors` 及 MCP 密钥表 `mcp_api_keys`。
 *
 * @param dbPath SQLite 数据库物理存储路径
 */
export function initDb(dbPath: string): void {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      created_at    INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      description  TEXT,
      storage_path TEXT NOT NULL,
      owner_id     INTEGER NOT NULL REFERENCES users(id),
      is_public    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS kb_access (
      kb_id   INTEGER REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (kb_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id         INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size          INTEGER DEFAULT 0,
      uploaded_at   INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id      INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL DEFAULT '新对话',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT,
      tool_calls      TEXT,
      tool_call_id    TEXT,
      seq             INTEGER NOT NULL,
      created_at      INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_user_kb
      ON conversations(user_id, kb_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_msg_conv_seq
      ON messages(conversation_id, seq);

    CREATE TABLE IF NOT EXISTS audit_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER,
      username    TEXT,
      action      TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   INTEGER,
      kb_id       INTEGER,
      detail      TEXT,
      ip          TEXT,
      created_at  INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created
      ON audit_events(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_audit_kb
      ON audit_events(kb_id, created_at DESC);
  `)

  // 幂等迁移：添加 is_pinned 对话置顶列（已存在则忽略）
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`)
  } catch { /* 列已存在 */ }

  // 幂等迁移：文档索引元数据与同步字段
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN index_version INTEGER NOT NULL DEFAULT 0`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN index_status TEXT NOT NULL DEFAULT 'ready'`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN index_error TEXT`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN indexed_at INTEGER`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE knowledge_bases ADD COLUMN sync_source_path TEXT`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE knowledge_bases ADD COLUMN sync_last_at INTEGER`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE knowledge_bases ADD COLUMN sync_last_result TEXT`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'upload'`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN source_path TEXT`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN source_mtime INTEGER`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN source_size INTEGER`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE knowledge_bases ADD COLUMN system_prompt TEXT`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`)
  } catch { /* column already exists */ }

  // 用户回答评价反馈表
  db.exec(`
    CREATE TABLE IF NOT EXISTS response_feedback (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL,
      rating      INTEGER NOT NULL CHECK(rating IN (1, -1)),
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_conv_user
    ON response_feedback(conversation_id, user_id)
  `)
  try {
    db.exec(`ALTER TABLE response_feedback ADD COLUMN reason TEXT`)
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE response_feedback ADD COLUMN comment TEXT`)
  } catch { /* column already exists */ }

  // 迁移：将 FTS5 unicode61 分词器无损升级为 trigram（三元分词器能完美切分 3 字符及以上 CJK 中文词）
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='doc_fts'").get() as { sql: string } | undefined
    if (row && !row.sql.includes('trigram')) {
      db.exec('DROP TABLE IF EXISTS doc_fts')
      console.log('[DB] FTS5 tokenizer 已升级为 trigram，后台将重建全文索引')
    }
  } catch { /* 首次启动表尚不存在时忽略 */ }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docs_source
      ON documents(kb_id, source_type, source_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
      content,
      original_name UNINDEXED,
      file_path     UNINDEXED,
      kb_id         UNINDEXED,
      doc_id        UNINDEXED,
      chunk_line    UNINDEXED,
      tokenize      = 'trigram'
    );

    CREATE TABLE IF NOT EXISTS doc_chunk_vectors (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id        INTEGER NOT NULL,
      kb_id         INTEGER NOT NULL,
      chunk_line    INTEGER NOT NULL,
      original_name TEXT    NOT NULL,
      file_path     TEXT    NOT NULL,
      embedding     BLOB    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_vectors_kb  ON doc_chunk_vectors(kb_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_vectors_doc ON doc_chunk_vectors(doc_id);

    CREATE TABLE IF NOT EXISTS mcp_api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash     TEXT NOT NULL UNIQUE,
      key_prefix   TEXT NOT NULL,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kb_ids       TEXT NOT NULL DEFAULT '[]',
      label        TEXT,
      created_at   INTEGER DEFAULT (strftime('%s','now')),
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_keys_user ON mcp_api_keys(user_id);
  `)
}

/**
 * 安全关闭 SQLite 数据库连接并释放资源
 */
export function closeDb(): void {
  db.close()
}

/**
 * 确保管理员账户存在（系统首次启动时自动初始化创建）
 *
 * @param username 默认管理员用户名
 * @param password 默认管理员明文初始密码（入库前自动执行 bcrypt 加盐哈希）
 */
export function ensureAdmin(username: string, password: string): void {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (!exists) {
    const hash = bcrypt.hashSync(password, 10)
    db.prepare(`
      INSERT INTO users (username, password_hash, role)
      VALUES (?, ?, 'admin')
    `).run(username, hash)
    console.log(`[DB] 管理员账户已创建：${username}`)
  }
}

// ── 用户账户操作 ──────────────────────────────────────────

/**
 * 根据登录名检索用户
 *
 * @param username 用户登录名
 * @returns 完整的 User 实体（包含 password_hash）；不存在时返回 undefined
 */
export function getUserByUsername(username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined
}

/**
 * 根据用户数字 ID 检索用户
 *
 * @param id 用户唯一数字 ID
 * @returns 完整的 User 实体；不存在时返回 undefined
 */
export function getUserById(id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined
}

/**
 * 列出系统中所有注册用户（按创建时间排序，自动剥离密码散列防泄漏）
 *
 * @returns 不含 password_hash 的安全用户列表
 */
export function listUsers(): Omit<User, 'password_hash'>[] {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all() as Omit<User, 'password_hash'>[]
}

/**
 * 创建新用户账户
 *
 * @param username 用户名
 * @param password 用户明文密码
 * @param role 用户角色，默认普通员工 'user'
 * @returns 新建成功的用户实体对象
 */
export function createUser(username: string, password: string, role: 'admin' | 'user' = 'user'): User {
  const hash = bcrypt.hashSync(password, 10)
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
  `).run(username, hash, role)
  return getUserById(result.lastInsertRowid as number)!
}

/**
 * 根据 ID 物理删除用户
 *
 * @param id 目标用户 ID
 */
export function deleteUser(id: number): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

// ── 知识库空间操作 ────────────────────────────────────────

/**
 * 列出当前用户有权访问的全部知识库
 *
 * 权限规则：包含全员公开 (is_public=1) + 用户自己创建 (owner_id=userId) + 显式授权加入 (kb_access)
 *
 * @param userId 目标用户数字 ID
 * @returns 知识库实体列表（按创建时间倒序）
 */
export function listKbsForUser(userId: number): KnowledgeBase[] {
  return db.prepare(`
    SELECT DISTINCT kb.*
    FROM knowledge_bases kb
    LEFT JOIN kb_access ka ON ka.kb_id = kb.id
    WHERE kb.is_public = 1
       OR kb.owner_id = ?
       OR ka.user_id = ?
    ORDER BY kb.created_at DESC
  `).all(userId, userId) as KnowledgeBase[]
}

/**
 * 列出系统中所有的知识库（管理员专用）
 *
 * @returns 全部知识库实体列表
 */
export function getAllKbs(): KnowledgeBase[] {
  return db.prepare('SELECT * FROM knowledge_bases ORDER BY created_at DESC').all() as KnowledgeBase[]
}

/**
 * 根据知识库 ID 查询知识库详情
 *
 * @param id 知识库 ID
 * @returns 知识库实体；不存在时返回 undefined
 */
export function getKbById(id: number): KnowledgeBase | undefined {
  return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) as KnowledgeBase | undefined
}

/**
 * 创建新知识库空间
 *
 * @param data 知识库元数据
 * @param data.name 知识库名称
 * @param data.description 知识库描述说明
 * @param data.storagePath 磁盘物理存储路径
 * @param data.ownerId 创建者用户 ID
 * @returns 新建成功的知识库实体
 */
export function createKb(data: {
  name: string
  description?: string
  storagePath: string
  ownerId: number
}): KnowledgeBase {
  const result = db.prepare(`
    INSERT INTO knowledge_bases (name, description, storage_path, owner_id)
    VALUES (?, ?, ?, ?)
  `).run(data.name, data.description ?? null, data.storagePath, data.ownerId)
  return getKbById(result.lastInsertRowid as number)!
}

/**
 * 更新知识库底层物理存储路径
 *
 * @param id 知识库 ID
 * @param storagePath 新存储路径
 */
export function updateKbStoragePath(id: number, storagePath: string): void {
  db.prepare('UPDATE knowledge_bases SET storage_path = ? WHERE id = ?').run(storagePath, id)
}

/**
 * 更新知识库名称与简介元数据
 *
 * @param id 知识库 ID
 * @param name 新名称
 * @param description 新描述说明
 */
export function updateKbMeta(id: number, name: string, description: string | null): void {
  db.prepare('UPDATE knowledge_bases SET name = ?, description = ? WHERE id = ?').run(name, description, id)
}

/**
 * 设置知识库是否公开全员可见
 *
 * @param id 知识库 ID
 * @param isPublic 是否公开
 */
export function updateKbPublic(id: number, isPublic: boolean): void {
  db.prepare('UPDATE knowledge_bases SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, id)
}

/**
 * 配置本地目录同步源路径
 *
 * @param id 知识库 ID
 * @param syncSourcePath 本地文件夹绝对物理路径
 */
export function updateKbSyncSource(id: number, syncSourcePath: string | null): void {
  db.prepare('UPDATE knowledge_bases SET sync_source_path = ? WHERE id = ?').run(syncSourcePath, id)
}

/**
 * 记录最近一次同步的执行时间与摘要结果
 *
 * @param id 知识库 ID
 * @param result 同步执行摘要或报错信息（最多截取 1,000 字符）
 */
export function updateKbSyncResult(id: number, result: string): void {
  db.prepare(`
    UPDATE knowledge_bases
    SET sync_last_at = strftime('%s','now'),
        sync_last_result = ?
    WHERE id = ?
  `).run(result.slice(0, 1000), id)
}

/**
 * 配置知识库专属的自定义 System Prompt 指令
 *
 * @param id 知识库 ID
 * @param systemPrompt 提示词指令文本；置空时清空
 */
export function updateKbSystemPrompt(id: number, systemPrompt: string | null): void {
  db.prepare('UPDATE knowledge_bases SET system_prompt = ? WHERE id = ?').run(systemPrompt ?? null, id)
}

/**
 * 级联删除知识库及其下属所有关联数据（通过数据库外键级联）
 *
 * @param id 知识库 ID
 */
export function deleteKb(id: number): void {
  db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
}

/**
 * 校验指定用户是否有权访问该知识库
 *
 * 判权逻辑：
 * 1. 知识库不存在直接返回 false；
 * 2. 若知识库为公开 (is_public=1) 或用户为所有者 (owner_id=userId)，返回 true；
 * 3. 检查 kb_access 关联授权表是否包含该用户。
 *
 * @param userId 用户 ID
 * @param kbId 知识库 ID
 * @returns 是否有权访问
 */
export function canUserAccessKb(userId: number, kbId: number): boolean {
  const kb = getKbById(kbId)
  if (!kb) return false
  if (kb.is_public === 1 || kb.owner_id === userId) return true
  const access = db.prepare('SELECT 1 FROM kb_access WHERE kb_id = ? AND user_id = ?').get(kbId, userId)
  return !!access
}

/**
 * 向用户授予知识库访问成员权限（幂等添加）
 *
 * @param kbId 知识库 ID
 * @param userId 目标用户 ID
 */
export function grantKbAccess(kbId: number, userId: number): void {
  db.prepare('INSERT OR IGNORE INTO kb_access (kb_id, user_id) VALUES (?, ?)').run(kbId, userId)
}

/**
 * 撤销用户的知识库成员访问权限
 *
 * @param kbId 知识库 ID
 * @param userId 目标用户 ID
 */
export function revokeKbAccess(kbId: number, userId: number): void {
  db.prepare('DELETE FROM kb_access WHERE kb_id = ? AND user_id = ?').run(kbId, userId)
}

/**
 * 列出当前知识库的所有显式授权成员
 *
 * @param kbId 知识库 ID
 * @returns 成员安全信息列表（不含 password_hash）
 */
export function listKbMembers(kbId: number): Omit<User, 'password_hash'>[] {
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at
    FROM users u
    INNER JOIN kb_access ka ON ka.user_id = u.id
    WHERE ka.kb_id = ?
    ORDER BY u.username
  `).all(kbId) as Omit<User, 'password_hash'>[]
}

/**
 * 更新用户密码哈希值
 *
 * @param id 用户 ID
 * @param newHash 新密码的 bcrypt 散列
 */
export function updateUserPassword(id: number, newHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, id)
}

// ── 审计日志系统 ──────────────────────────────────────────

/**
 * 记录一条系统安全与业务审计事件
 *
 * @param data 审计事件详情
 * @param data.userId 操作人 ID
 * @param data.username 操作人快照用户名
 * @param data.action 操作动作标识（如 kb.create, doc.upload）
 * @param data.entityType 目标实体类型
 * @param data.entityId 目标实体 ID
 * @param data.kbId 关联的知识库 ID
 * @param data.detail 补充参数或变更详情（自动序列化为 JSON 并限制 4,000 字符）
 * @param data.ip 客户端 IP
 */
export function createAuditEvent(data: {
  userId?: number | null
  username?: string | null
  action: string
  entityType: string
  entityId?: number | null
  kbId?: number | null
  detail?: unknown
  ip?: string | null
}): void {
  const detail = data.detail === undefined
    ? null
    : typeof data.detail === 'string'
      ? data.detail
      : JSON.stringify(data.detail)
  db.prepare(`
    INSERT INTO audit_events (
      user_id, username, action, entity_type, entity_id, kb_id, detail, ip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.userId ?? null,
    data.username ?? null,
    data.action,
    data.entityType,
    data.entityId ?? null,
    data.kbId ?? null,
    detail ? detail.slice(0, 4000) : null,
    data.ip ?? null,
  )
}

/**
 * 分页条件查询审计日志列表（管理员专用）
 *
 * @param data 查询过滤参数
 * @param data.limit 分页大小，默认 50
 * @param data.offset 分页偏移量，默认 0
 * @param data.action 按操作类型模糊匹配
 * @param data.username 按用户名模糊匹配
 * @param data.kbId 按指定知识库 ID 筛选
 * @returns 包含日志列表与总条数的对象
 */
export function listAuditEvents(data: {
  limit?: number
  offset?: number
  action?: string
  username?: string
  kbId?: number
} = {}): { items: AuditEvent[]; total: number } {
  const where: string[] = []
  const params: Array<string | number> = []
  if (data.action) {
    where.push('action LIKE ?')
    params.push(`%${data.action}%`)
  }
  if (data.username) {
    where.push('username LIKE ?')
    params.push(`%${data.username}%`)
  }
  if (data.kbId != null) {
    where.push('kb_id = ?')
    params.push(data.kbId)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = data.limit ?? 50
  const offset = data.offset ?? 0
  const items = db.prepare(`
    SELECT * FROM audit_events
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as AuditEvent[]
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM audit_events
    ${whereSql}
  `).get(...params) as { cnt: number }
  return { items, total: totalRow.cnt }
}

// ── 知识库文档操作 ──────────────────────────────────────────

/**
 * 分页或全量列出知识库中的所有文档
 *
 * @param kbId 知识库 ID
 * @param limit 返回上限；未传时返回全量文档
 * @param offset 偏移起始量，默认 0
 * @returns 文档列表（按上传时间倒序）
 */
export function listDocs(kbId: number, limit?: number, offset?: number): Document[] {
  if (limit != null) {
    return db.prepare('SELECT * FROM documents WHERE kb_id = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?')
      .all(kbId, limit, offset ?? 0) as Document[]
  }
  return db.prepare('SELECT * FROM documents WHERE kb_id = ? ORDER BY uploaded_at DESC').all(kbId) as Document[]
}

/**
 * 分页列出知识库文档，并动态聚合每个文档的 FTS5 切片数与向量数
 *
 * @param kbId 知识库 ID
 * @param limit 分页大小
 * @param offset 偏移量
 * @returns 包含 chunk_count 和 vec_count 的文档列表
 */
export function listDocsWithCounts(kbId: number, limit: number, offset: number): Document[] {
  const docs = db.prepare(
    'SELECT * FROM documents WHERE kb_id = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?',
  ).all(kbId, limit, offset) as Document[]
  const ftsCount = db.prepare('SELECT COUNT(*) as n FROM doc_fts WHERE doc_id = ?')
  const vecCount = db.prepare('SELECT COUNT(*) as n FROM doc_chunk_vectors WHERE doc_id = ?')
  for (const doc of docs) {
    doc.chunk_count = (ftsCount.get(doc.id) as { n: number }).n
    doc.vec_count   = (vecCount.get(doc.id) as { n: number }).n
  }
  return docs
}

/**
 * 统计指定知识库下的文档总数
 *
 * @param kbId 知识库 ID
 * @returns 文档总数
 */
export function countDocs(kbId: number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE kb_id = ?').get(kbId) as { cnt: number }
  return row.cnt
}

/**
 * 根据文档 ID 查询文档详情
 *
 * @param id 文档 ID
 * @returns 文档实体；不存在时返回 undefined
 */
export function getDocById(id: number): Document | undefined {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Document | undefined
}

/**
 * 根据来源类型筛选知识库文档（如仅筛选 sync 同步源导入的文档）
 *
 * @param kbId 知识库 ID
 * @param sourceType 文档来源类型 ('upload' | 'text' | 'sync')
 * @returns 匹配来源的文档列表
 */
export function listDocsBySourceType(kbId: number, sourceType: DocumentSourceType): Document[] {
  return db.prepare(`
    SELECT * FROM documents
    WHERE kb_id = ? AND source_type = ?
    ORDER BY uploaded_at DESC
  `).all(kbId, sourceType) as Document[]
}

/**
 * 向知识库新增文档记录
 *
 * @param data 文档元数据
 * @returns 创建成功的文档实体
 */
export function createDoc(data: {
  kbId: number
  filename: string
  originalName: string
  size: number
  indexStatus?: Document['index_status']
  sourceType?: DocumentSourceType
  sourcePath?: string | null
  sourceMtime?: number | null
  sourceSize?: number | null
}): Document {
  const result = db.prepare(`
    INSERT INTO documents (
      kb_id, filename, original_name, size, index_status,
      source_type, source_path, source_mtime, source_size
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.kbId,
    data.filename,
    data.originalName,
    data.size,
    data.indexStatus ?? 'pending',
    data.sourceType ?? 'upload',
    data.sourcePath ?? null,
    data.sourceMtime ?? null,
    data.sourceSize ?? null,
  )
  return getDocById(result.lastInsertRowid as number)!
}

/**
 * 本地同步更新文档：当源文件内容发生修改时更新元数据并重置索引状态为 pending
 *
 * @param data 同步更新参数
 */
export function updateDocFromSync(data: {
  id: number
  filename: string
  originalName: string
  size: number
  sourcePath: string
  sourceMtime: number
  sourceSize: number
}): void {
  db.prepare(`
    UPDATE documents
    SET filename = ?,
        original_name = ?,
        size = ?,
        uploaded_at = strftime('%s','now'),
        source_type = 'sync',
        source_path = ?,
        source_mtime = ?,
        source_size = ?,
        index_version = 0,
        index_status = 'pending',
        index_error = NULL,
        indexed_at = NULL
    WHERE id = ?
  `).run(
    data.filename,
    data.originalName,
    data.size,
    data.sourcePath,
    data.sourceMtime,
    data.sourceSize,
    data.id,
  )
}

/**
 * 更新文档的原始显示名与字节大小
 *
 * @param id 文档 ID
 * @param originalName 新的原始文件名
 * @param size 新的文件大小 (Bytes)
 */
export function updateDocMeta(id: number, originalName: string, size: number): void {
  db.prepare('UPDATE documents SET original_name = ?, size = ? WHERE id = ?').run(originalName, size, id)
}

/**
 * 更新文档的自动总结摘要
 *
 * @param id 文档 ID
 * @param summary 摘要文本（截取前 300 字符）
 */
export function updateDocSummary(id: number, summary: string): void {
  db.prepare('UPDATE documents SET summary = ? WHERE id = ?').run(summary.slice(0, 300), id)
}

/**
 * 提交或更新用户对某次对话回答的满意度反馈 (点赞 / 点踩)
 *
 * @param conversationId 对话会话 ID
 * @param userId 用户 ID
 * @param rating 评分：1 表示满意点赞，-1 表示不满意点踩
 * @param reason 不满意归因类别 (如 doc_missing, wrong_answer, not_found, other)
 * @param comment 用户的详细文字反馈与改进建议（截取前 500 字符）
 */
export function upsertFeedback(
  conversationId: number,
  userId: number,
  rating: 1 | -1,
  reason?: string | null,
  comment?: string | null,
): void {
  db.prepare(`
    INSERT INTO response_feedback(conversation_id, user_id, rating, reason, comment)
    VALUES(?,?,?,?,?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET
      rating  = excluded.rating,
      reason  = excluded.reason,
      comment = excluded.comment
  `).run(conversationId, userId, rating, reason ?? null, comment ? comment.slice(0, 500) : null)
}

/**
 * 统计指定知识库的问答反馈指标（点赞数、点踩数及负评原因分布）
 *
 * @param kbId 知识库 ID
 * @returns 统计汇总结果
 */
export function getFeedbackStats(kbId: number): {
  positive: number
  negative: number
  byReason: Record<string, number>
} {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN f.rating = 1 THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN f.rating = -1 THEN 1 ELSE 0 END) as negative
    FROM response_feedback f
    JOIN conversations c ON c.id = f.conversation_id
    WHERE c.kb_id = ?
  `).get(kbId) as { positive: number | null; negative: number | null }

  const reasonRows = db.prepare(`
    SELECT reason, COUNT(*) as cnt
    FROM response_feedback f
    JOIN conversations c ON c.id = f.conversation_id
    WHERE c.kb_id = ? AND f.rating = -1 AND f.reason IS NOT NULL
    GROUP BY f.reason
  `).all(kbId) as Array<{ reason: string; cnt: number }>

  const byReason: Record<string, number> = {}
  for (const r of reasonRows) byReason[r.reason] = r.cnt

  return { positive: row.positive ?? 0, negative: row.negative ?? 0, byReason }
}

/**
 * 负面反馈条目详情结构
 */
export interface NegativeFeedbackItem {
  /** 对话 ID */
  conversation_id: number
  /** 对话标题 */
  conversation_title: string
  /** 知识库 ID */
  kb_id: number
  /** 知识库名称 */
  kb_name: string
  /** 用户的首句提问摘要（用于快速回溯问题上下文） */
  question_snippet: string
  /** 归因原因分类 */
  reason: string | null
  /** 用户手填的详细评论 */
  comment: string | null
  /** 评价提交时间戳（秒级） */
  created_at: number
}

/**
 * 分页获取指定知识库下的差评列表（供管理员优化知识库与补齐缺漏文档）
 *
 * @param kbId 知识库 ID
 * @param limit 每页数量，默认 20
 * @param offset 偏移量，默认 0
 * @returns 差评详情列表及总数
 */
export function listNegativeFeedback(
  kbId: number,
  limit = 20,
  offset = 0,
): { items: NegativeFeedbackItem[]; total: number } {
  const items = db.prepare(`
    SELECT
      f.conversation_id,
      c.title       AS conversation_title,
      c.kb_id,
      kb.name       AS kb_name,
      COALESCE(
        (SELECT m.content FROM messages m
         WHERE m.conversation_id = f.conversation_id AND m.role = 'user'
         ORDER BY m.seq LIMIT 1),
        ''
      ) AS question_snippet,
      f.reason,
      f.comment,
      f.created_at
    FROM response_feedback f
    JOIN conversations c  ON c.id = f.conversation_id
    JOIN knowledge_bases kb ON kb.id = c.kb_id
    WHERE c.kb_id = ? AND f.rating = -1
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(kbId, limit, offset) as NegativeFeedbackItem[]

  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM response_feedback f
    JOIN conversations c ON c.id = f.conversation_id
    WHERE c.kb_id = ? AND f.rating = -1
  `).get(kbId) as { cnt: number }

  return { items, total: row.cnt }
}

/**
 * 根据原始文件名查询该知识库下的文档
 *
 * @param kbId 知识库 ID
 * @param originalName 上传时的原始文件名
 * @returns 匹配的文档实体
 */
export function getDocByOriginalName(kbId: number, originalName: string): Document | undefined {
  return db.prepare(
    'SELECT * FROM documents WHERE kb_id = ? AND original_name = ? LIMIT 1',
  ).get(kbId, originalName) as Document | undefined
}

/**
 * 根据磁盘物理文件名查询该知识库下的文档
 *
 * @param kbId 知识库 ID
 * @param filename 磁盘存储的文件名
 * @returns 匹配的文档实体
 */
export function getDocByFilename(kbId: number, filename: string): Document | undefined {
  return db.prepare(
    'SELECT * FROM documents WHERE kb_id = ? AND filename = ? LIMIT 1',
  ).get(kbId, filename) as Document | undefined
}

/**
 * 重置因进程意外中断而卡死在 processing 状态的文档
 * 服务启动时调用，将遗留的僵尸状态恢复为 pending 以便重新入队索引
 *
 * @returns 被重置的文档数量
 */
export function resetStuckDocuments(): number {
  const result = db.prepare(
    "UPDATE documents SET index_status = 'pending', index_error = NULL WHERE index_status = 'processing'",
  ).run()
  return result.changes
}

/**
 * 更新文档索引处理状态
 *
 * @param id 文档 ID
 * @param status 新状态：pending | processing | ready | error
 * @param error 异常提示信息
 */
export function updateDocIndexStatus(
  id: number,
  status: Document['index_status'],
  error: string | null = null,
): void {
  db.prepare(`
    UPDATE documents
    SET index_status = ?,
        index_error = ?,
        indexed_at = CASE WHEN ? = 'ready' THEN strftime('%s','now') ELSE indexed_at END
    WHERE id = ?
  `).run(status, error, status, id)
}

/**
 * 物理删除文档记录（通过外键级联删除对应的全文索引与向量表切片）
 *
 * @param id 文档 ID
 */
export function deleteDoc(id: number): void {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
}

// ── 对话会话与消息操作 ──────────────────────────────────────────

/**
 * 列出指定用户在特定知识库下的所有对话会话（优先展示置顶会话，其次按更新时间倒序）
 *
 * @param userId 用户 ID
 * @param kbId 知识库 ID
 * @param limit 返回条数上限
 * @param offset 偏移量
 * @returns 会话实体列表
 */
export function listConversations(
  userId: number, kbId: number, limit = 9999, offset = 0
): Conversation[] {
  return db.prepare(`
    SELECT * FROM conversations
    WHERE user_id = ? AND kb_id = ?
    ORDER BY is_pinned DESC, updated_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, kbId, limit, offset) as Conversation[]
}

/**
 * 统计指定用户在某个知识库下的会话总数
 *
 * @param userId 用户 ID
 * @param kbId 知识库 ID
 * @returns 会话数
 */
export function countConversations(userId: number, kbId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND kb_id = ?
  `).get(userId, kbId) as { cnt: number }
  return row.cnt
}

/**
 * 创建新问答对话会话
 *
 * @param userId 用户 ID
 * @param kbId 知识库 ID
 * @param title 对话标题，默认 "新对话"
 * @returns 创建的会话实体
 */
export function createConversation(userId: number, kbId: number, title = '新对话'): Conversation {
  const result = db.prepare(`
    INSERT INTO conversations (user_id, kb_id, title) VALUES (?, ?, ?)
  `).run(userId, kbId, title)
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid as number) as Conversation
}

/**
 * 重命名会话标题
 *
 * @param id 会话 ID
 * @param title 新标题
 */
export function updateConversationTitle(id: number, title: string): void {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
}

/**
 * 刷新会话的最后活跃时间戳为当前时间
 *
 * @param id 会话 ID
 */
export function touchConversation(id: number): void {
  db.prepare(`UPDATE conversations SET updated_at = strftime('%s','now') WHERE id = ?`).run(id)
}

/**
 * 级联删除会话及其包含的全部消息记录
 *
 * @param id 会话 ID
 */
export function deleteConversation(id: number): void {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

/**
 * 根据 ID 查询会话详情
 *
 * @param id 会话 ID
 * @returns 会话实体；不存在时返回 undefined
 */
export function getConversationById(id: number): Conversation | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined
}

/**
 * 获取会话中的所有历史消息行（严格按时序序号 seq 升序排列）
 *
 * @param conversationId 会话 ID
 * @returns 原始消息行列表
 */
export function listMessages(conversationId: number): MessageRow[] {
  return db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq
  `).all(conversationId) as MessageRow[]
}

/**
 * 批量插入消息记录（在同一个原子事务中执行，保证时序与完整性）
 *
 * @param conversationId 会话 ID
 * @param msgs 待插入的消息实体数组
 */
export function insertMessages(
  conversationId: number,
  msgs: Array<{ role: string; content: string | null; tool_calls: string | null; tool_call_id: string | null; seq: number }>
): void {
  const stmt = db.prepare(`
    INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, seq)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertAll = db.transaction(() => {
    for (const m of msgs) {
      stmt.run(conversationId, m.role, m.content, m.tool_calls, m.tool_call_id, m.seq)
    }
  })
  insertAll()
}

/**
 * 统计指定会话内的历史消息总条数
 *
 * @param conversationId 会话 ID
 * @returns 消息条数
 */
export function countMessages(conversationId: number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversationId) as { cnt: number }
  return row.cnt
}

/**
 * 修改用户的系统角色权限
 *
 * @param id 目标用户 ID
 * @param role 角色：'admin' | 'user'
 */
export function updateUserRole(id: number, role: 'admin' | 'user'): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
}

/**
 * 设置或取消会话的置顶状态
 *
 * @param id 会话 ID
 * @param pinned 是否置顶
 */
export function pinConversation(id: number, pinned: boolean): void {
  db.prepare('UPDATE conversations SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

/**
 * 知识库综合业务概况统计
 */
export interface KbStats {
  /** 文档总数 */
  doc_count: number
  /** 会话总数 */
  conv_count: number
  /** 最近一次会话问答更新时间戳（秒级） */
  last_active: number | null
}

/**
 * 查询指定知识库的综合概况指标
 *
 * @param kbId 知识库 ID
 * @returns 概况统计结构体
 */
export function getKbStats(kbId: number): KbStats {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents     WHERE kb_id = ?) AS doc_count,
      (SELECT COUNT(*) FROM conversations WHERE kb_id = ?) AS conv_count,
      (SELECT MAX(updated_at) FROM conversations WHERE kb_id = ?) AS last_active
  `).get(kbId, kbId, kbId) as KbStats
}

// ── FTS5 文档全文检索与混合打分系统 ──────────────────────────────────

/** 文档索引版本号：分词器、分块规则升级时递增，用于触发后台重建索引 */
export const DOC_INDEX_VERSION = 4

/**
 * 对文档纯文本内容构建 FTS5 全文索引
 *
 * 处理流程：
 * 1. 调用 `chunkDocument` 按段落、标题与行号预算智能切分文本片段；
 * 2. 开启 SQLite 独占事务；
 * 3. 清理该文档旧的 `doc_fts` 虚拟表记录；
 * 4. 批量向 `doc_fts` 写入切片正文、原始文件名、文件绝对路径及起始行号 (chunk_line)；
 * 5. 将 documents 表中对应文档的 `index_status` 置为 'ready'，记录 `indexed_at` 时间戳。
 *
 * @param docId 文档 ID
 * @param kbId 知识库 ID
 * @param originalName 原始文件名
 * @param filePath 本地文件路径
 * @param text 完整纯文本内容
 */
export function indexDocContent(
  docId: number,
  kbId: number,
  originalName: string,
  filePath: string,
  text: string,
): void {
  // 智能分块切分
  const chunks = chunkDocument(text)

  // 事务批量写入保证原子性
  db.transaction(() => {
    db.prepare('DELETE FROM doc_fts WHERE doc_id = ?').run(docId)
    const ins = db.prepare(
      'INSERT INTO doc_fts(content, original_name, file_path, kb_id, doc_id, chunk_line) VALUES (?,?,?,?,?,?)',
    )
    for (const chunk of chunks) {
      ins.run(chunk.content, originalName, filePath, kbId, docId, chunk.startLine)
    }
    db.prepare(`
      UPDATE documents
      SET index_version = ?,
          index_status = 'ready',
          index_error = NULL,
          indexed_at = strftime('%s','now')
      WHERE id = ?
    `).run(DOC_INDEX_VERSION, docId)
  })()
}

/**
 * 检索结果片段条目
 */
export interface DocSearchResult {
  /** 命中片段所属的原始文件名 */
  original_name: string
  /** 磁盘文件绝对存储路径 */
  file_path:     string
  /** 带有 >>>关键词<<< 标记的高亮命中上下文摘要 */
  snippet:       string
  /** 该片段在源文档中的物理起始行号（0-based，可直接传给 Read 工具） */
  chunk_line:    number
}

/**
 * 检索候选集内部结构（暂存各路召回打分指标）
 */
interface SearchCandidate {
  doc_id: number
  original_name: string
  file_path: string
  content: string
  chunk_line: number
  fts_rank?: number
  /** 召回来源通道集合：strict(AND匹配), relaxed(OR匹配), substring(LIKE子串匹配) */
  sources: Set<'strict' | 'relaxed' | 'substring'>
}

/**
 * 清洗并提取检索查询词列表
 * 过滤 FTS5 语法保留特殊符号（如 * " ^ ( ) 等），防止语法注入报错
 */
function queryTerms(query: string): string[] {
  return query
    .replace(/["\*\^\(\)\\<>]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * 将检索词数组包装为安全用双引号包裹的 FTS5 MATCH 查询表达式
 */
function ftsQuery(terms: string[], operator: 'AND' | 'OR'): string {
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(` ${operator} `)
}

/**
 * 构造包含搜索词上下文的高亮预览摘要 (Snippet)
 *
 * 算法：
 * 1. 在正文中定位最靠前匹配的关键词位置；
 * 2. 以关键词为中心向前截取最多 120 字符，向后截取最多 240 字符；
 * 3. 用 `>>>关键词<<<` 进行包裹标识，前后按需增加省略号 `…`。
 */
function makeSnippet(content: string, query: string, terms: string[]): string {
  const normalized = content.toLocaleLowerCase()
  const match = [query, ...terms]
    .map(value => value.toLocaleLowerCase())
    .filter(Boolean)
    .map(value => ({ value, index: normalized.indexOf(value) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index || b.value.length - a.value.length)[0]

  if (!match) return content.slice(0, 360)
  const start = Math.max(0, match.index - 120)
  const end = Math.min(content.length, match.index + match.value.length + 240)
  return `${start > 0 ? '…' : ''}${content.slice(start, match.index)}>>>${content.slice(match.index, match.index + match.value.length)}<<<${content.slice(match.index + match.value.length, end)}${end < content.length ? '…' : ''}`
}

/**
 * 多因子加权精排评分函数 (scoreCandidate)
 *
 * 打分策略：
 * - 通道加分：strict(AND) +80, relaxed(OR) +35, substring(LIKE) +20
 * - 标题完全吻合：+240；标题包含短语：+160；正文包含短语：+120
 * - 标题命中词：每个词 +45；正文命中词：每个词 +12
 * - FTS5 BM25 排名分：按倒数折算补加最多 15 分
 */
function scoreCandidate(candidate: SearchCandidate, query: string, terms: string[]): number {
  const name = candidate.original_name.toLocaleLowerCase()
  const content = candidate.content.toLocaleLowerCase()
  const phrase = query.toLocaleLowerCase()
  let score = 0

  if (candidate.sources.has('strict')) score += 80
  if (candidate.sources.has('relaxed')) score += 35
  if (candidate.sources.has('substring')) score += 20
  if (name === phrase) score += 240
  else if (name.includes(phrase)) score += 160
  if (content.includes(phrase)) score += 120

  for (const term of terms.map(value => value.toLocaleLowerCase())) {
    if (name.includes(term)) score += 45
    if (content.includes(term)) score += 12
  }

  if (candidate.fts_rank != null) score += Math.max(0, 15 - Math.abs(candidate.fts_rank))
  return score
}

/**
 * 知识库混合检索核心算法 (searchDocContent)
 *
 * 召回与重排流程：
 * 1. 分词与语法清洗：提取搜索词；
 * 2. 第一路召回 (FTS5 AND)：严格全词命中；
 * 3. 第二路召回 (FTS5 OR)：宽松任一词命中（多词时触发）；
 * 4. 第三路召回 (LIKE 模糊)：兜底匹配短中文词（如 1~2 字符的缩写或专用词汇）；
 * 5. 第四路召回 (向量语义检索)：若传入 queryEmbedding，通过余弦相似度计算前 N 个语义最相似的切片；
 * 6. 统一融合与混合打分 (Hybrid Scoring)：
 *    若启用向量检索，综合权重为 50% 文本全文分 + 50% 向量相似度分；
 * 7. 降序重排截取前 limit 项，生成高亮摘要并返回。
 *
 * @param kbId 目标知识库 ID
 * @param query 用户的搜索关键词或问答句
 * @param limit 最多返回的结果片段数，默认 8
 * @param queryEmbedding 可选的查询文本嵌入向量（用于向量语义混合打分）
 * @returns 最终排序输出的高相关度切片列表
 */
export function searchDocContent(
  kbId: number,
  query: string,
  limit = 8,
  queryEmbedding?: Float32Array,
): DocSearchResult[] {
  const terms = queryTerms(query)
  if (!terms.length) return []

  const candidateLimit = Math.max(limit * 6, 30)
  const candidates = new Map<string, SearchCandidate>()
  const addRows = (
    rows: Array<Omit<SearchCandidate, 'sources'>>,
    source: 'strict' | 'relaxed' | 'substring',
  ) => {
    for (const row of rows) {
      const key = `${row.doc_id}:${row.chunk_line}`
      const existing = candidates.get(key)
      if (existing) {
        existing.sources.add(source)
        if (row.fts_rank != null) existing.fts_rank = Math.min(existing.fts_rank ?? row.fts_rank, row.fts_rank)
      } else {
        candidates.set(key, { ...row, sources: new Set([source]) })
      }
    }
  }

  // 1. FTS5 全文索引检索
  const runFts = (expression: string, source: 'strict' | 'relaxed') => {
    try {
      const rows = db.prepare(`
        SELECT doc_id, original_name, file_path, content, chunk_line, bm25(doc_fts) AS fts_rank
        FROM doc_fts
        WHERE kb_id = ? AND doc_fts MATCH ?
        ORDER BY bm25(doc_fts)
        LIMIT ?
      `).all(kbId, expression, candidateLimit) as Array<Omit<SearchCandidate, 'sources'>>
      addRows(rows, source)
    } catch { /* 遇到极端符号语法异常时平滑回退 */ }
  }

  runFts(ftsQuery(terms, 'AND'), 'strict')
  if (terms.length > 1) runFts(ftsQuery(terms, 'OR'), 'relaxed')

  // 2. LIKE 子串匹配兜底（处理小于 3 字无法被 trigram 覆盖的中文短词）
  const conditions = terms.map(() => '(content LIKE ? OR original_name LIKE ?)').join(' OR ')
  const substringRows = db.prepare(`
    SELECT doc_id, original_name, file_path, content, chunk_line
    FROM doc_fts
    WHERE kb_id = ? AND (${conditions})
    LIMIT ?
  `).all(
    kbId,
    ...terms.flatMap(term => [`%${term}%`, `%${term}%`]),
    candidateLimit,
  ) as Array<Omit<SearchCandidate, 'sources'>>
  addRows(substringRows, 'substring')

  // 3. 向量语义混合召回（若外部传入了查询语义向量）
  const vectorScoreMap = new Map<string, number>()
  if (queryEmbedding) {
    const vectorResults = searchByVector(kbId, queryEmbedding, candidateLimit)
    for (const vr of vectorResults) {
      const key = `${vr.doc_id}:${vr.chunk_line}`
      vectorScoreMap.set(key, vr.similarity)
      // 向量命中但全文未命中的语义切片，动态补入候选池
      if (!candidates.has(key)) {
        try {
          const row = db.prepare(
            'SELECT content FROM doc_fts WHERE doc_id = ? AND chunk_line = ? LIMIT 1',
          ).get(vr.doc_id, vr.chunk_line) as { content: string } | undefined
          if (row) {
            candidates.set(key, {
              doc_id:        vr.doc_id,
              original_name: vr.original_name,
              file_path:     vr.file_path,
              content:       row.content,
              chunk_line:    vr.chunk_line,
              sources:       new Set(['relaxed']),
            })
          }
        } catch { /* 忽略 */ }
      }
    }
  }

  // 4. 混合加权综合重排序
  return Array.from(candidates.values())
    .sort((a, b) => {
      const keyA = `${a.doc_id}:${a.chunk_line}`
      const keyB = `${b.doc_id}:${b.chunk_line}`
      const ftsA = scoreCandidate(a, query, terms)
      const ftsB = scoreCandidate(b, query, terms)
      const vecA = (vectorScoreMap.get(keyA) ?? 0) * 100   // 向量相似度 0~1 线性映射至 0~100
      const vecB = (vectorScoreMap.get(keyB) ?? 0) * 100
      const hybridA = queryEmbedding ? ftsA * 0.5 + vecA * 0.5 : ftsA
      const hybridB = queryEmbedding ? ftsB * 0.5 + vecB * 0.5 : ftsB
      return hybridB - hybridA
        || (a.fts_rank ?? 999) - (b.fts_rank ?? 999)
        || a.chunk_line - b.chunk_line
    })
    .slice(0, limit)
    .map(candidate => ({
      original_name: candidate.original_name,
      file_path: candidate.file_path,
      snippet: makeSnippet(candidate.content, query, terms),
      chunk_line: candidate.chunk_line,
    }))
}

/**
 * 从 FTS5 全文索引和向量索引表中彻底删除指定文档的全部索引切片
 *
 * @param docId 文档 ID
 */
export function removeDocFromIndex(docId: number): void {
  db.prepare('DELETE FROM doc_fts WHERE doc_id = ?').run(docId)
  db.prepare('DELETE FROM doc_chunk_vectors WHERE doc_id = ?').run(docId)
}

// ── 向量存储与语义检索 ─────────────────────────────────────

/**
 * 计算两个浮点向量之间的余弦相似度 (Cosine Similarity)
 *
 * 算法公式：sim(A, B) = (A · B) / (||A|| * ||B||)
 * 增加 1e-8 防止除以零浮点异常
 *
 * @param a 查询向量 Float32Array
 * @param b 候选切片向量 Float32Array
 * @returns 余弦相似度分值，通常在 -1 到 1 之间（正向相似度通常在 0 ~ 1 范围）
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8)
}

/**
 * 将文档各切片的向量批量持久化至 SQLite BLOB 字段
 *
 * @param docId 文档 ID
 * @param kbId 知识库 ID
 * @param vectors 包含行号、向量、原文件名和路径的切片集合
 */
export function storeChunkVectors(
  docId: number,
  kbId: number,
  vectors: Array<{ chunkLine: number; embedding: Float32Array; originalName: string; filePath: string }>,
): void {
  db.transaction(() => {
    // 覆盖旧向量
    db.prepare('DELETE FROM doc_chunk_vectors WHERE doc_id = ?').run(docId)
    const ins = db.prepare(
      'INSERT INTO doc_chunk_vectors(doc_id, kb_id, chunk_line, original_name, file_path, embedding) VALUES (?,?,?,?,?,?)',
    )
    for (const v of vectors) {
      ins.run(docId, kbId, v.chunkLine, v.originalName, v.filePath, Buffer.from(v.embedding.buffer))
    }
  })()
}

/**
 * 数据库向量行内部反序列化结构
 */
interface VectorRow {
  doc_id: number
  original_name: string
  file_path: string
  chunk_line: number
  embedding: Buffer
}

/**
 * 向量相似度检索命中结果
 */
export interface VectorSearchResult {
  /** 命中切片所属文档 ID */
  doc_id: number
  /** 原始文件名 */
  original_name: string
  /** 磁盘绝对路径 */
  file_path: string
  /** 起始行号 */
  chunk_line: number
  /** 与查询向量的余弦相似度分值 (0~1) */
  similarity: number
}

/**
 * 在指定知识库内执行纯向量余弦相似度检索
 *
 * @param kbId 知识库 ID
 * @param queryEmbedding 查询词向量 Float32Array
 * @param limit 返回上限，默认 8
 * @returns 按余弦相似度降序排列的切片结果
 */
export function searchByVector(
  kbId: number,
  queryEmbedding: Float32Array,
  limit = 8,
): VectorSearchResult[] {
  const rows = db.prepare(
    'SELECT doc_id, original_name, file_path, chunk_line, embedding FROM doc_chunk_vectors WHERE kb_id = ?',
  ).all(kbId) as VectorRow[]

  if (!rows.length) return []

  return rows
    .map(row => {
      const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
      return {
        doc_id: row.doc_id,
        original_name: row.original_name,
        file_path: row.file_path,
        chunk_line: row.chunk_line,
        similarity: cosineSimilarity(queryEmbedding, emb),
      }
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
}

/**
 * 检查当前知识库是否已存在任何向量切片索引
 *
 * @param kbId 知识库 ID
 * @returns 是否包含向量记录
 */
export function hasVectors(kbId: number): boolean {
  return !!db.prepare('SELECT 1 FROM doc_chunk_vectors WHERE kb_id = ? LIMIT 1').get(kbId)
}

/**
 * 查询指定文档已生成的向量切片总条数
 *
 * @param docId 文档 ID
 * @returns 向量数
 */
export function getDocVectorCount(docId: number): number {
  return (db.prepare('SELECT COUNT(*) as n FROM doc_chunk_vectors WHERE doc_id = ?').get(docId) as { n: number }).n
}

/**
 * 关联推荐文档条目结构
 */
export interface RelatedDoc {
  /** 关联文档 ID */
  doc_id: number
  /** 关联文档原始文件名 */
  original_name: string
  /** 语义相似度分值 (0~1) */
  similarity: number
}

/**
 * 计算与指定文档语义最相关的其他文档列表（用于前端文档详情页的相关推荐）
 *
 * 聚合算法：
 * 1. 取出源文档所有的切片向量集合；
 * 2. 取出同知识库其他候选文档的所有切片向量；
 * 3. 针对每个候选文档，计算源切片与候选切片的最大余弦相似度（以最高相似切片代表整篇文档的关联度）；
 * 4. 降序重排，截取前 limit 项返回。
 *
 * @param kbId 知识库 ID
 * @param docId 源文档 ID
 * @param limit 推荐数量上限，默认 5
 * @returns 推荐的相关文档列表
 */
export function getRelatedDocs(kbId: number, docId: number, limit = 5): RelatedDoc[] {
  // 取源文档所有切片向量
  const srcRows = db.prepare(
    'SELECT embedding FROM doc_chunk_vectors WHERE doc_id = ?',
  ).all(docId) as Array<{ embedding: Buffer }>
  if (!srcRows.length) return []

  const srcVecs = srcRows.map(r =>
    new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  )

  // 取同知识库其他文档的所有切片向量
  const otherRows = db.prepare(
    'SELECT doc_id, original_name, embedding FROM doc_chunk_vectors WHERE kb_id = ? AND doc_id != ?',
  ).all(kbId, docId) as Array<{ doc_id: number; original_name: string; embedding: Buffer }>
  if (!otherRows.length) return []

  // 计算每个 chunk 对的最大相似度，按目标 doc 聚合取最高分
  const docScores = new Map<number, { name: string; score: number }>()
  for (const row of otherRows) {
    const tgtVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
    let maxSim = 0
    for (const src of srcVecs) {
      const sim = cosineSimilarity(src, tgtVec)
      if (sim > maxSim) maxSim = sim
    }
    const existing = docScores.get(row.doc_id)
    if (!existing || maxSim > existing.score) {
      docScores.set(row.doc_id, { name: row.original_name, score: maxSim })
    }
  }

  return Array.from(docScores.entries())
    .map(([id, { name, score }]) => ({ doc_id: id, original_name: name, similarity: score }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
}

/**
 * 判断指定文档是否已完成全文索引构建且处于可用就绪状态
 *
 * @param docId 文档 ID
 * @returns 是否就绪
 */
export function isDocIndexed(docId: number): boolean {
  const doc = getDocById(docId)
  return doc?.index_version === DOC_INDEX_VERSION
    && doc.index_status === 'ready'
    && !!db.prepare('SELECT 1 FROM doc_fts WHERE doc_id = ? LIMIT 1').get(docId)
}

/**
 * 历史对话全文搜索命中条目
 */
export interface ConvSearchResult {
  /** 命中会话 ID */
  conv_id: number
  /** 会话标题 */
  conv_title: string
  /** 知识库 ID */
  kb_id: number
  /** 知识库名称 */
  kb_name: string
  /** 命中的消息正文片段 */
  snippet: string
  /** 会话最后更新时间戳 */
  updated_at: number
}

/**
 * 在用户的历史问答对话记录中进行关键词模糊匹配
 *
 * @param userId 用户 ID
 * @param query 搜索关键词
 * @param limit 返回上限
 * @param offset 偏移量
 * @returns 命中的对话列表及总数
 */
export function searchConversations(
  userId: number,
  query: string,
  limit = 20,
  offset = 0,
): { items: ConvSearchResult[]; total: number } {
  const like = `%${query}%`
  const items = db.prepare(`
    SELECT
      c.id          AS conv_id,
      c.title       AS conv_title,
      c.kb_id,
      kb.name       AS kb_name,
      m.content     AS snippet,
      c.updated_at
    FROM messages m
    JOIN conversations c  ON m.conversation_id = c.id
    JOIN knowledge_bases kb ON c.kb_id = kb.id
    WHERE m.role IN ('user', 'assistant')
      AND m.content IS NOT NULL
      AND m.content LIKE ?
      AND c.user_id = ?
    GROUP BY c.id
    ORDER BY c.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(like, userId, limit, offset) as ConvSearchResult[]

  const row = db.prepare(`
    SELECT COUNT(DISTINCT c.id) AS cnt
    FROM messages m
    JOIN conversations c  ON m.conversation_id = c.id
    JOIN knowledge_bases kb ON c.kb_id = kb.id
    WHERE m.role IN ('user', 'assistant')
      AND m.content IS NOT NULL
      AND m.content LIKE ?
      AND c.user_id = ?
  `).get(like, userId) as { cnt: number }

  return { items, total: row.cnt }
}

// ── MCP API Key 凭证管理 ──────────────────────────────────────

/**
 * MCP API Key 数据结构
 */
export interface McpApiKey {
  /** 唯一自增 ID */
  id: number
  /** 密钥的 bcrypt 加密散列 */
  key_hash: string
  /** 密钥明文的前 8 位前缀（用于加速筛选候选记录） */
  key_prefix: string
  /** 归属的用户 ID */
  user_id: number
  /** 授权访问的知识库 ID 列表 (JSON 字符串，如 "[1,2]"，空数组表示按用户权限访问所有) */
  kb_ids: string
  /** 用户手填的密钥备注标签 */
  label: string | null
  /** 创建时间戳（秒级） */
  created_at: number
  /** 最近一次成功调用鉴权的时间戳（秒级） */
  last_used_at: number | null
}

/**
 * 创建并持久化一条新的 MCP API Key 凭证
 *
 * @param data 密钥数据
 * @returns 数据库持久化后的记录实体
 */
export function createMcpApiKey(data: {
  keyHash: string
  keyPrefix: string
  userId: number
  kbIds: number[]
  label?: string
}): McpApiKey {
  const result = db.prepare(`
    INSERT INTO mcp_api_keys (key_hash, key_prefix, user_id, kb_ids, label)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.keyHash, data.keyPrefix, data.userId, JSON.stringify(data.kbIds), data.label ?? null)
  return db.prepare('SELECT * FROM mcp_api_keys WHERE id = ?').get(result.lastInsertRowid) as McpApiKey
}

/**
 * 列出指定用户的全部 MCP API Key（安全脱敏，剔除 key_hash）
 *
 * @param userId 用户 ID
 * @returns 安全脱敏后的 API Key 列表
 */
export function listMcpApiKeys(userId: number): Omit<McpApiKey, 'key_hash'>[] {
  return db.prepare(
    'SELECT id, key_prefix, user_id, kb_ids, label, created_at, last_used_at FROM mcp_api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as Omit<McpApiKey, 'key_hash'>[]
}

/**
 * 根据哈希精确检索 MCP API Key
 *
 * @param keyHash 完整 bcrypt 哈希
 * @returns McpApiKey 实体
 */
export function getMcpApiKeyByHash(keyHash: string): McpApiKey | undefined {
  return db.prepare('SELECT * FROM mcp_api_keys WHERE key_hash = ?').get(keyHash) as McpApiKey | undefined
}

/**
 * 删除指定的 MCP API Key（严格校验 user_id 防止越权删除他人密钥）
 *
 * @param id 密钥 ID
 * @param userId 当前操作人用户 ID
 * @returns 是否成功删除
 */
export function deleteMcpApiKey(id: number, userId: number): boolean {
  const result = db.prepare('DELETE FROM mcp_api_keys WHERE id = ? AND user_id = ?').run(id, userId)
  return result.changes > 0
}

/**
 * 刷新 MCP API Key 的最后使用时间戳
 *
 * @param id 密钥 ID
 */
export function touchMcpApiKey(id: number): void {
  db.prepare('UPDATE mcp_api_keys SET last_used_at = strftime(\'%s\',\'now\') WHERE id = ?').run(id)
}

/**
 * 根据密钥前 8 位前缀快速检索候选列表（加速后续 bcrypt 比对效率）
 *
 * @param prefix 密钥前缀（前8字符，如 'ekb_1234'）
 * @returns 匹配前缀的候选密钥列表
 */
export function getMcpApiKeysByPrefix(prefix: string): McpApiKey[] {
  return db.prepare('SELECT * FROM mcp_api_keys WHERE key_prefix = ?').all(prefix) as McpApiKey[]
}
