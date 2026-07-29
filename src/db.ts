/**
 * 数据库层 — SQLite (better-sqlite3)
 * 无 ORM，原生 SQL，轻量适合企业内部部署
 */

import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import bcrypt from 'bcryptjs'
import { chunkDocument } from './documentChunker.js'

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
  sync_source_path: string | null
  sync_last_at: number | null
  sync_last_result: string | null
  created_at: number
}

export type DocumentSourceType = 'upload' | 'text' | 'sync'

export interface Document {
  id: number
  kb_id: number
  filename: string
  original_name: string
  size: number
  uploaded_at: number
  source_type: DocumentSourceType
  source_path: string | null
  source_mtime: number | null
  source_size: number | null
  index_version: number
  index_status: 'pending' | 'processing' | 'ready' | 'error'
  index_error: string | null
  indexed_at: number | null
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

export interface AuditEvent {
  id: number
  user_id: number | null
  username: string | null
  action: string
  entity_type: string
  entity_id: number | null
  kb_id: number | null
  detail: string | null
  ip: string | null
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

  // 幂等迁移：添加 is_pinned 列（已存在则忽略）
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`)
  } catch { /* 列已存在 */ }

  // FTS5 全文检索索引（幂等）
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

  // Migration: unicode61 → trigram for CJK support (trigram handles 3+ char Chinese terms;
  // 2-char terms continue to be served by the existing LIKE substring fallback)
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='doc_fts'").get() as { sql: string } | undefined
    if (row && !row.sql.includes('trigram')) {
      db.exec('DROP TABLE IF EXISTS doc_fts')
      console.log('[DB] FTS5 tokenizer 已升级为 trigram，后台将重建全文索引')
    }
  } catch { /* ignore — table may not exist yet on first run */ }

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

export function updateKbSyncSource(id: number, syncSourcePath: string | null): void {
  db.prepare('UPDATE knowledge_bases SET sync_source_path = ? WHERE id = ?').run(syncSourcePath, id)
}

export function updateKbSyncResult(id: number, result: string): void {
  db.prepare(`
    UPDATE knowledge_bases
    SET sync_last_at = strftime('%s','now'),
        sync_last_result = ?
    WHERE id = ?
  `).run(result.slice(0, 1000), id)
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

// ── 审计日志 ──────────────────────────────────────────

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

export function listDocsBySourceType(kbId: number, sourceType: DocumentSourceType): Document[] {
  return db.prepare(`
    SELECT * FROM documents
    WHERE kb_id = ? AND source_type = ?
    ORDER BY uploaded_at DESC
  `).all(kbId, sourceType) as Document[]
}

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

export const DOC_INDEX_VERSION = 4

export function indexDocContent(
  docId: number,
  kbId: number,
  originalName: string,
  filePath: string,
  text: string,
): void {
  // 收集所有块，一次性事务写入
  const chunks = chunkDocument(text)

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

export interface DocSearchResult {
  original_name: string
  file_path:     string
  snippet:       string
  chunk_line:    number
}

interface SearchCandidate {
  doc_id: number
  original_name: string
  file_path: string
  content: string
  chunk_line: number
  fts_rank?: number
  sources: Set<'strict' | 'relaxed' | 'substring'>
}

function queryTerms(query: string): string[] {
  return query
    .replace(/["\*\^\(\)\\<>]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function ftsQuery(terms: string[], operator: 'AND' | 'OR'): string {
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(` ${operator} `)
}

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

export function searchDocContent(
  kbId: number,
  query: string,
  limit = 8,
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
    } catch { /* fall through to substring candidates */ }
  }

  runFts(ftsQuery(terms, 'AND'), 'strict')
  if (terms.length > 1) runFts(ftsQuery(terms, 'OR'), 'relaxed')

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

  return Array.from(candidates.values())
    .sort((a, b) => scoreCandidate(b, query, terms) - scoreCandidate(a, query, terms)
      || (a.fts_rank ?? 999) - (b.fts_rank ?? 999)
      || a.chunk_line - b.chunk_line)
    .slice(0, limit)
    .map(candidate => ({
      original_name: candidate.original_name,
      file_path: candidate.file_path,
      snippet: makeSnippet(candidate.content, query, terms),
      chunk_line: candidate.chunk_line,
    }))
}

export function removeDocFromIndex(docId: number): void {
  db.prepare('DELETE FROM doc_fts WHERE doc_id = ?').run(docId)
}

export function isDocIndexed(docId: number): boolean {
  const doc = getDocById(docId)
  return doc?.index_version === DOC_INDEX_VERSION
    && doc.index_status === 'ready'
    && !!db.prepare('SELECT 1 FROM doc_fts WHERE doc_id = ? LIMIT 1').get(docId)
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
