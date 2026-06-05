/**
 * 数据库层 — SQLite (better-sqlite3)
 * 无 ORM，原生 SQL，轻量适合企业内部部署
 */

import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import bcrypt from 'bcryptjs'

// ── 类型定义 ──────────────────────────────────────────

export interface User {
  id: number
  username: string
  password_hash: string
  role: 'admin' | 'user'
  created_at: number
}

export interface KnowledgeBase {
  id: number
  name: string
  description: string | null
  storage_path: string
  owner_id: number
  is_public: number   // 0 | 1
  created_at: number
}

export interface Document {
  id: number
  kb_id: number
  filename: string
  original_name: string
  size: number
  uploaded_at: number
}

export interface Conversation {
  id: number
  kb_id: number
  user_id: number
  title: string
  is_pinned: number   // 0 | 1
  created_at: number
  updated_at: number
}

export interface MessageRow {
  id: number
  conversation_id: number
  role: string
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  seq: number
  created_at: number
}

// ── 初始化 ────────────────────────────────────────────

let db: Database.Database

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
  `)

  // 幂等迁移：添加 is_pinned 列（已存在则忽略）
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`)
  } catch { /* 列已存在 */ }

  // FTS5 全文检索索引（幂等）
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
      content,
      original_name UNINDEXED,
      file_path     UNINDEXED,
      kb_id         UNINDEXED,
      doc_id        UNINDEXED,
      chunk_line    UNINDEXED,
      tokenize      = 'unicode61 remove_diacritics 1'
    );
  `)
}

/** 确保 admin 账户存在（首次启动时创建） */
export function closeDb(): void {
  db.close()
}

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

// ── 用户操作 ──────────────────────────────────────────

export function getUserByUsername(username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined
}

export function getUserById(id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined
}

export function listUsers(): Omit<User, 'password_hash'>[] {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all() as Omit<User, 'password_hash'>[]
}

export function createUser(username: string, password: string, role: 'admin' | 'user' = 'user'): User {
  const hash = bcrypt.hashSync(password, 10)
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
  `).run(username, hash, role)
  return getUserById(result.lastInsertRowid as number)!
}

export function deleteUser(id: number): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

// ── 知识库操作 ────────────────────────────────────────

/** 列出用户可访问的知识库（公开 + 自己创建 + 被授权） */
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

export function getAllKbs(): KnowledgeBase[] {
  return db.prepare('SELECT * FROM knowledge_bases ORDER BY created_at DESC').all() as KnowledgeBase[]
}

export function getKbById(id: number): KnowledgeBase | undefined {
  return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) as KnowledgeBase | undefined
}

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

export function updateKbStoragePath(id: number, storagePath: string): void {
  db.prepare('UPDATE knowledge_bases SET storage_path = ? WHERE id = ?').run(storagePath, id)
}

export function updateKbMeta(id: number, name: string, description: string | null): void {
  db.prepare('UPDATE knowledge_bases SET name = ?, description = ? WHERE id = ?').run(name, description, id)
}

export function updateKbPublic(id: number, isPublic: boolean): void {
  db.prepare('UPDATE knowledge_bases SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, id)
}

export function deleteKb(id: number): void {
  db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
}

export function canUserAccessKb(userId: number, kbId: number): boolean {
  const kb = getKbById(kbId)
  if (!kb) return false
  if (kb.is_public === 1 || kb.owner_id === userId) return true
  const access = db.prepare('SELECT 1 FROM kb_access WHERE kb_id = ? AND user_id = ?').get(kbId, userId)
  return !!access
}

export function grantKbAccess(kbId: number, userId: number): void {
  db.prepare('INSERT OR IGNORE INTO kb_access (kb_id, user_id) VALUES (?, ?)').run(kbId, userId)
}

export function revokeKbAccess(kbId: number, userId: number): void {
  db.prepare('DELETE FROM kb_access WHERE kb_id = ? AND user_id = ?').run(kbId, userId)
}

export function listKbMembers(kbId: number): Omit<User, 'password_hash'>[] {
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at
    FROM users u
    INNER JOIN kb_access ka ON ka.user_id = u.id
    WHERE ka.kb_id = ?
    ORDER BY u.username
  `).all(kbId) as Omit<User, 'password_hash'>[]
}

export function updateUserPassword(id: number, newHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, id)
}

// ── 文档操作 ──────────────────────────────────────────

export function listDocs(kbId: number, limit?: number, offset?: number): Document[] {
  if (limit != null) {
    return db.prepare('SELECT * FROM documents WHERE kb_id = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?')
      .all(kbId, limit, offset ?? 0) as Document[]
  }
  return db.prepare('SELECT * FROM documents WHERE kb_id = ? ORDER BY uploaded_at DESC').all(kbId) as Document[]
}

export function countDocs(kbId: number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE kb_id = ?').get(kbId) as { cnt: number }
  return row.cnt
}

export function getDocById(id: number): Document | undefined {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Document | undefined
}

export function createDoc(data: {
  kbId: number
  filename: string
  originalName: string
  size: number
}): Document {
  const result = db.prepare(`
    INSERT INTO documents (kb_id, filename, original_name, size)
    VALUES (?, ?, ?, ?)
  `).run(data.kbId, data.filename, data.originalName, data.size)
  return getDocById(result.lastInsertRowid as number)!
}

export function deleteDoc(id: number): void {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
}

// ── 对话操作 ──────────────────────────────────────────

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

export function countConversations(userId: number, kbId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND kb_id = ?
  `).get(userId, kbId) as { cnt: number }
  return row.cnt
}

export function createConversation(userId: number, kbId: number, title = '新对话'): Conversation {
  const result = db.prepare(`
    INSERT INTO conversations (user_id, kb_id, title) VALUES (?, ?, ?)
  `).run(userId, kbId, title)
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid as number) as Conversation
}

export function updateConversationTitle(id: number, title: string): void {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
}

export function touchConversation(id: number): void {
  db.prepare(`UPDATE conversations SET updated_at = strftime('%s','now') WHERE id = ?`).run(id)
}

export function deleteConversation(id: number): void {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function getConversationById(id: number): Conversation | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined
}

export function listMessages(conversationId: number): MessageRow[] {
  return db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq
  `).all(conversationId) as MessageRow[]
}

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

export function countMessages(conversationId: number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversationId) as { cnt: number }
  return row.cnt
}

export function updateUserRole(id: number, role: 'admin' | 'user'): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
}

export function pinConversation(id: number, pinned: boolean): void {
  db.prepare('UPDATE conversations SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export interface KbStats {
  doc_count: number
  conv_count: number
  last_active: number | null
}

export function getKbStats(kbId: number): KbStats {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents     WHERE kb_id = ?) AS doc_count,
      (SELECT COUNT(*) FROM conversations WHERE kb_id = ?) AS conv_count,
      (SELECT MAX(updated_at) FROM conversations WHERE kb_id = ?) AS last_active
  `).get(kbId, kbId, kbId) as KbStats
}

// ── FTS5 文档全文检索 ──────────────────────────────────

const CHUNK_SIZE    = 800   // 每块约 800 字符
const CHUNK_OVERLAP = 80    // 块间重叠，保留上下文连贯性

export function indexDocContent(
  docId: number,
  kbId: number,
  originalName: string,
  filePath: string,
  text: string,
): void {
  // 收集所有块，一次性事务写入
  const chunks: Array<[string, string, string, number, number, number]> = []
  const lines  = text.split('\n')
  let charBuf  = ''
  let chunkStart = 0

  for (let i = 0; i < lines.length; i++) {
    charBuf += lines[i] + '\n'
    if (charBuf.length >= CHUNK_SIZE) {
      if (charBuf.trim().length >= 10)
        chunks.push([charBuf, originalName, filePath, kbId, docId, chunkStart])
      charBuf    = charBuf.slice(-CHUNK_OVERLAP)
      chunkStart = i + 1
    }
  }
  if (charBuf.trim().length >= 10)
    chunks.push([charBuf, originalName, filePath, kbId, docId, chunkStart])

  db.transaction(() => {
    db.prepare('DELETE FROM doc_fts WHERE doc_id = ?').run(docId)
    const ins = db.prepare(
      'INSERT INTO doc_fts(content, original_name, file_path, kb_id, doc_id, chunk_line) VALUES (?,?,?,?,?,?)',
    )
    for (const chunk of chunks) ins.run(...chunk)
  })()
}

export interface DocSearchResult {
  original_name: string
  file_path:     string
  snippet:       string
  chunk_line:    number
}

/** FTS5 特殊字符转义，防止查询语法错误 */
function sanitizeFts5(query: string): string {
  // 去掉 FTS5 运算符/特殊符号，每个词加引号做精确词匹配
  const words = query
    .replace(/["\*\^\(\)\\<>]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)
  if (!words.length) return '""'
  return words.map(w => `"${w}"`).join(' ')
}

export function searchDocContent(
  kbId: number,
  query: string,
  limit = 8,
): DocSearchResult[] {
  const safe = sanitizeFts5(query)
  try {
    return db.prepare(`
      SELECT
        original_name,
        file_path,
        snippet(doc_fts, 0, '>>>', '<<<', '…', 24) AS snippet,
        chunk_line
      FROM doc_fts
      WHERE kb_id = ? AND doc_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(kbId, safe, limit) as DocSearchResult[]
  } catch {
    return []
  }
}

export function removeDocFromIndex(docId: number): void {
  db.prepare('DELETE FROM doc_fts WHERE doc_id = ?').run(docId)
}

export function isDocIndexed(docId: number): boolean {
  return !!db.prepare('SELECT 1 FROM doc_fts WHERE doc_id = ? LIMIT 1').get(docId)
}

export interface ConvSearchResult {
  conv_id: number
  conv_title: string
  kb_id: number
  kb_name: string
  snippet: string
  updated_at: number
}

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
      AND (
        c.user_id = ?
        OR kb.is_public = 1
        OR EXISTS (SELECT 1 FROM kb_access WHERE kb_id = c.kb_id AND user_id = ?)
      )
    GROUP BY c.id
    ORDER BY c.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(like, userId, userId, limit, offset) as ConvSearchResult[]

  const row = db.prepare(`
    SELECT COUNT(DISTINCT c.id) AS cnt
    FROM messages m
    JOIN conversations c  ON m.conversation_id = c.id
    JOIN knowledge_bases kb ON c.kb_id = kb.id
    WHERE m.role IN ('user', 'assistant')
      AND m.content IS NOT NULL
      AND m.content LIKE ?
      AND (
        c.user_id = ?
        OR kb.is_public = 1
        OR EXISTS (SELECT 1 FROM kb_access WHERE kb_id = c.kb_id AND user_id = ?)
      )
  `).get(like, userId, userId) as { cnt: number }

  return { items, total: row.cnt }
}
