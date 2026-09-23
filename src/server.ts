/**
 * Express 主服务 — 所有路由
 * 启动：npx tsx src/server.ts
 */

import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as url from 'node:url'

import { initDb, ensureAdmin, getUserByUsername, getUserById, listUsers, createUser, deleteUser,
         listKbsForUser, getAllKbs, getKbById, createKb, deleteKb, updateKbPublic, updateKbStoragePath, updateKbMeta,
         updateKbSyncSource, updateKbSyncResult,
         canUserAccessKb, grantKbAccess, revokeKbAccess, listKbMembers,
         listDocs, listDocsBySourceType, createDoc, updateDocFromSync, deleteDoc, getDocById,
         updateUserPassword, updateUserRole,
         listConversations, createConversation, updateConversationTitle, touchConversation,
         deleteConversation, getConversationById, listMessages, insertMessages, countMessages,
         countConversations, pinConversation, getKbStats, searchConversations,
         indexDocContent, removeDocFromIndex, isDocIndexed, searchDocContent, countDocs,
         updateDocIndexStatus, createAuditEvent, listAuditEvents,
         storeChunkVectors, hasVectors, getDocVectorCount, getRelatedDocs } from './db.js'
import type { Document, KnowledgeBase, MessageRow } from './db.js'
import { isEmbeddingEnabled, getEmbeddingModel, embedChunks } from './embedding.js'
import { chunkDocument } from './documentChunker.js'
import { requireAuth, requireAdmin, signToken, verifyPassword, hashPassword } from './auth.js'
import type { AuthRequest } from './auth.js'
import { LLMExecutor } from './executor.js'
import { ALL_TOOLS, collectKbStats } from './tools.js'
import { buildSystemPrompt } from './prompt.js'
import type { QAEvent } from './tools.js'
import { buildTrustedHistory } from './conversationHistory.js'

// pdf-parse 用 CommonJS require，动态导入兼容 ESM
async function extractPdfText(filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfParse: any = (await import('pdf-parse')).default
  const data = await pdfParse(buf)
  return data.text as string
}

async function extractDocxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth: any = (await import('mammoth')).default
  const result = await mammoth.extractRawText({ path: filePath })
  return result.value as string
}

async function extractXlsxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const lines: string[] = []
  workbook.eachSheet((sheet: any) => {
    lines.push(`[工作表: ${sheet.name}]`)
    sheet.eachRow((row: any) => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: false }, (cell: any) => {
        const v = cell.value
        if (v === null || v === undefined) return
        if (typeof v === 'object' && 'text' in v) cells.push(String(v.text))
        else if (typeof v === 'object' && 'result' in v) cells.push(String(v.result ?? ''))
        else if (typeof v === 'object' && v instanceof Date) cells.push(v.toISOString().slice(0, 10))
        else cells.push(String(v))
      })
      if (cells.length) lines.push(cells.join('\t'))
    })
  })
  return lines.join('\n')
}

async function extractPptxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officeParser: any = (await import('officeparser')).default
  return await officeParser.parseOfficeAsync(filePath) as string
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// ── 配置 ──────────────────────────────────────────────

const NODE_ENV      = process.env.NODE_ENV ?? 'development'
const IS_PRODUCTION = NODE_ENV === 'production'
const DEFAULT_ADMIN_PASSWORD  = 'Admin@123'
const EXAMPLE_ADMIN_PASSWORD  = 'change-this-admin-password'
const DEFAULT_JWT_SECRET      = 'dev-secret-change-me'
const EXAMPLE_JWT_SECRET      = 'change-this-to-a-random-secret-string-at-least-32-chars'

function envValue(primary: string, ...aliases: string[]): string | undefined {
  for (const key of [primary, ...aliases]) {
    const val = process.env[key]?.trim()
    if (val) return val
  }
  return undefined
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer.`)
  return n
}

function isOllamaEndpoint(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1/.test(baseUrl) && baseUrl.includes('11434')
}

function normalizeLlmBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  if (isOllamaEndpoint(trimmed) && !trimmed.endsWith('/v1')) return `${trimmed}/v1`
  return trimmed
}

const PORT         = parsePositiveInt(envValue('PORT'), 8080, 'PORT')
const LLM_BASE_URL = normalizeLlmBaseUrl(envValue('LLM_BASE_URL', 'OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1')
const LLM_API_KEY  = envValue('LLM_API_KEY', 'OLLAMA_API_KEY') ?? 'ollama'
let currentModel   = envValue('LLM_MODEL', 'OLLAMA_MODEL') ?? 'qwen2.5:7b'
const MAX_TURNS    = parsePositiveInt(envValue('LLM_MAX_TURNS', 'OLLAMA_MAX_TURNS'), 8, 'LLM_MAX_TURNS')
const HISTORY_MAX_MESSAGES = parsePositiveInt(envValue('HISTORY_MAX_MESSAGES'), 40, 'HISTORY_MAX_MESSAGES')
const HISTORY_MAX_CHARS    = parsePositiveInt(envValue('HISTORY_MAX_CHARS'), 40_000, 'HISTORY_MAX_CHARS')
const OLLAMA_URL   = LLM_BASE_URL.replace(/\/v1\/?$/, '')
const IS_OLLAMA    = isOllamaEndpoint(LLM_BASE_URL)
const LLM_PROVIDER = (() => {
  if (IS_OLLAMA) return 'Ollama'
  try {
    const hostname = new URL(LLM_BASE_URL).hostname
    if (hostname.includes('minimaxi.com')) return 'MiniMax'
    if (hostname.includes('openai.com')) return 'OpenAI'
    return hostname
  } catch {
    return 'OpenAI-compatible'
  }
})()
const PROJECT_ROOT = path.join(__dirname, '..')
function resolveFromProject(envVal: string | undefined, fallback: string): string {
  const val = envVal ?? fallback
  return path.isAbsolute(val) ? val : path.resolve(PROJECT_ROOT, val)
}
const STORAGE_PATH = resolveFromProject(process.env.STORAGE_PATH, 'storage')
const DB_PATH      = resolveFromProject(process.env.DB_PATH,      'data/enterprise-kb.db')
const ADMIN_USER   = process.env.ADMIN_USERNAME   ?? 'admin'
const ADMIN_PASS   = process.env.ADMIN_PASSWORD   ?? 'Admin@123'
const CORS_ORIGIN  = envValue('CORS_ORIGIN')
const TRUST_PROXY  = /^(1|true|yes)$/i.test(envValue('TRUST_PROXY') ?? '')

function validateRuntimeConfig(): void {
  const jwtSecret = process.env.JWT_SECRET
  if (IS_PRODUCTION) {
    if (!jwtSecret || jwtSecret === DEFAULT_JWT_SECRET || jwtSecret === EXAMPLE_JWT_SECRET || jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production.')
    }
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === EXAMPLE_ADMIN_PASSWORD) {
      throw new Error('ADMIN_PASSWORD must be changed before production deployment.')
    }
  }
}

// ── 初始化 ────────────────────────────────────────────

validateRuntimeConfig()
if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true })
initDb(DB_PATH)
ensureAdmin(ADMIN_USER, ADMIN_PASS)

// ── Multer（文件上传） ─────────────────────────────────

const ALLOWED_EXTS = new Set([
  '.txt', '.md', '.markdown', '.pdf',
  '.ts', '.js', '.py', '.java', '.go', '.rs',
  '.json', '.yaml', '.yml', '.toml',
  '.csv', '.html', '.xml', '.sh',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
])

const OFFICE_EXTS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])

const SYNC_SKIP_DIRS = new Set([
  '.git', '.svn', '.hg',
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache',
  '__pycache__', '.venv', 'venv',
])
const SYNC_MAX_FILES = parsePositiveInt(envValue('SYNC_MAX_FILES'), 1000, 'SYNC_MAX_FILES')
const SYNC_MAX_TOTAL_BYTES = parsePositiveInt(envValue('SYNC_MAX_TOTAL_MB'), 500, 'SYNC_MAX_TOTAL_MB') * 1024 * 1024
const SYNC_MAX_FILE_BYTES = 50 * 1024 * 1024

interface SyncFile {
  absolutePath: string
  relativePath: string
  size: number
  sourceMtime: number
}

interface SyncSkipped {
  unsupported: number
  tooLarge: number
  limit: number
  symlink: number
  hiddenDir: number
  errors: number
}

interface SyncSummary {
  added: number
  updated: number
  removed: number
  queued: number
  unchanged: number
  scanned: number
  skipped: SyncSkipped
  errors: string[]
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function normalizeSourcePath(sourcePath: string): string {
  return path.normalize(path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(PROJECT_ROOT, sourcePath))
}

function isDirectory(sourcePath: string): boolean {
  try {
    return fs.statSync(sourcePath).isDirectory()
  } catch {
    return false
  }
}

function sourcePathKey(sourcePath: string): string {
  const normalized = path.normalize(sourcePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function makeStoredFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase()
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`
}

function removeStoredDocument(kbId: number, doc: Document): void {
  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  const filePath = path.join(kbDir, doc.filename)
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch {}
  const txtPath = filePath.replace(/\.pdf$/i, '.txt')
  if (txtPath !== filePath) {
    try { if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath) } catch {}
  }
  removeDocFromIndex(doc.id)
  deleteDoc(doc.id)
}

function canManageKb(kb: KnowledgeBase, user: AuthRequest['user']): boolean {
  return Boolean(user && (user.role === 'admin' || kb.owner_id === user.userId))
}

function publicKb(kb: KnowledgeBase, user: AuthRequest['user']): KnowledgeBase {
  if (canManageKb(kb, user)) return kb
  return { ...kb, sync_source_path: null, sync_last_at: null, sync_last_result: null }
}

function publicDoc(doc: Document, kb: KnowledgeBase, user: AuthRequest['user']): Document {
  if (canManageKb(kb, user)) return doc
  return { ...doc, source_path: null }
}

function audit(
  req: AuthRequest | Request,
  action: string,
  entityType: string,
  data: {
    entityId?: number | null
    kbId?: number | null
    detail?: unknown
    userId?: number | null
    username?: string | null
  } = {},
): void {
  const authUser = (req as AuthRequest).user
  createAuditEvent({
    userId: data.userId ?? authUser?.userId ?? null,
    username: data.username ?? authUser?.username ?? null,
    action,
    entityType,
    entityId: data.entityId ?? null,
    kbId: data.kbId ?? null,
    detail: data.detail,
    ip: req.ip,
  })
}

function requireKbOwnerOrAdmin(req: AuthRequest, res: Response, kbId: number): KnowledgeBase | null {
  const kb = getKbById(kbId)
  if (!kb) {
    res.status(404).json({ error: '知识库不存在' })
    return null
  }
  if (!canManageKb(kb, req.user)) {
    res.status(403).json({ error: '无权限' })
    return null
  }
  return kb
}

function scanSyncDirectory(root: string): { files: SyncFile[]; skipped: SyncSkipped; errors: string[] } {
  const files: SyncFile[] = []
  const skipped: SyncSkipped = { unsupported: 0, tooLarge: 0, limit: 0, symlink: 0, hiddenDir: 0, errors: 0 }
  const errors: string[] = []
  let totalBytes = 0

  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      skipped.errors++
      errors.push(`${dir}: ${(err as Error).message}`)
      return
    }

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped.symlink++
        continue
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SYNC_SKIP_DIRS.has(entry.name)) {
          skipped.hiddenDir++
          continue
        }
        walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (!ALLOWED_EXTS.has(ext)) {
        skipped.unsupported++
        continue
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(absolutePath)
      } catch (err) {
        skipped.errors++
        errors.push(`${absolutePath}: ${(err as Error).message}`)
        continue
      }
      if (stat.size > SYNC_MAX_FILE_BYTES) {
        skipped.tooLarge++
        continue
      }
      if (files.length >= SYNC_MAX_FILES || totalBytes + stat.size > SYNC_MAX_TOTAL_BYTES) {
        skipped.limit++
        continue
      }

      totalBytes += stat.size
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).replace(/\\/g, '/'),
        size: stat.size,
        sourceMtime: Math.round(stat.mtimeMs),
      })
    }
  }

  walk(root)
  return { files, skipped, errors }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      // 目录在路由里确保存在
      const kbId = (req as AuthRequest).params?.id
      const dir  = path.join(STORAGE_PATH, `kb_${kbId}`)
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase()
      const name = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
      cb(null, name)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },   // 50MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, ALLOWED_EXTS.has(ext))
  },
})

interface DocIndexJob {
  docId: number
  kbId: number
  originalName: string
  filePath: string
}

const docIndexQueue: DocIndexJob[] = []
let docIndexWorkerRunning = false

async function extractIndexableText(job: DocIndexJob): Promise<{ text: string; indexPath: string }> {
  const ext = path.extname(job.originalName).toLowerCase()
  const txtPath = job.filePath.replace(/\.[^.]+$/i, '.txt')

  if (ext === '.pdf') {
    const text = await extractPdfText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  if (ext === '.docx' || ext === '.doc') {
    const text = await extractDocxText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const text = await extractXlsxText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  if (ext === '.pptx' || ext === '.ppt') {
    const text = await extractPptxText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  return { text: fs.readFileSync(job.filePath, 'utf-8'), indexPath: job.filePath }
}

async function processDocIndexJob(job: DocIndexJob): Promise<void> {
  if (!getDocById(job.docId)) return
  updateDocIndexStatus(job.docId, 'processing')

  try {
    const { text, indexPath } = await extractIndexableText(job)
    if (!text.trim()) throw new Error('文档没有可索引文本')
    indexDocContent(job.docId, job.kbId, job.originalName, indexPath, text)

    if (isEmbeddingEnabled()) {
      void generateAndStoreEmbeddings(job.docId, job.kbId, job.originalName, indexPath, text)
    }
  } catch (err) {
    removeDocFromIndex(job.docId)
    const message = (err as Error).message || '索引失败'
    updateDocIndexStatus(job.docId, 'error', message.slice(0, 500))
    console.warn(`[index] 文档解析失败 ${job.originalName}: ${message}`)
  }
}

async function generateAndStoreEmbeddings(
  docId: number,
  kbId: number,
  originalName: string,
  filePath: string,
  text: string,
): Promise<void> {
  try {
    const chunks = chunkDocument(text)
    const vectors = await embedChunks(chunks)
    if (vectors.length) {
      storeChunkVectors(docId, kbId, vectors.map(v => ({
        chunkLine:    v.chunkLine,
        embedding:    v.embedding,
        originalName,
        filePath,
      })))
      console.log(`[embedding] ${originalName}: ${vectors.length} 个 chunk 向量化完成`)
    }
  } catch (err) {
    console.warn(`[embedding] 向量生成失败 ${originalName}: ${(err as Error).message}`)
  }
}

function enqueueDocIndex(job: DocIndexJob): void {
  docIndexQueue.push(job)
  void drainDocIndexQueue()
}

async function drainDocIndexQueue(): Promise<void> {
  if (docIndexWorkerRunning) return
  docIndexWorkerRunning = true
  try {
    while (docIndexQueue.length) {
      await processDocIndexJob(docIndexQueue.shift()!)
    }
  } finally {
    docIndexWorkerRunning = false
  }
}

function syncKnowledgeBase(kb: KnowledgeBase, sourceRoot: string): SyncSummary {
  const { files, skipped, errors } = scanSyncDirectory(sourceRoot)
  const summary: SyncSummary = {
    added: 0,
    updated: 0,
    removed: 0,
    queued: 0,
    unchanged: 0,
    scanned: files.length,
    skipped,
    errors: errors.slice(0, 20),
  }
  const kbDir = kb.storage_path || path.join(STORAGE_PATH, `kb_${kb.id}`)
  fs.mkdirSync(kbDir, { recursive: true })

  const sourceDocs = listDocsBySourceType(kb.id, 'sync')
  const docsBySource = new Map(sourceDocs
    .filter(doc => doc.source_path)
    .map(doc => [sourcePathKey(doc.source_path!), doc]))
  const scannedSourceKeys = new Set<string>()

  for (const file of files) {
    const sourcePath = normalizeSourcePath(file.absolutePath)
    const key = sourcePathKey(sourcePath)
    scannedSourceKeys.add(key)

    const existing = docsBySource.get(key)
    if (existing) {
      const unchanged = existing.source_mtime === file.sourceMtime
        && existing.source_size === file.size
        && isDocIndexed(existing.id)
      if (unchanged) {
        summary.unchanged++
        continue
      }

      const storedPath = path.join(kbDir, existing.filename)
      try {
        fs.copyFileSync(sourcePath, storedPath)
        const extractedTxt = storedPath.replace(/\.pdf$/i, '.txt')
        if (extractedTxt !== storedPath && fs.existsSync(extractedTxt)) fs.unlinkSync(extractedTxt)
        removeDocFromIndex(existing.id)
        updateDocFromSync({
          id: existing.id,
          filename: existing.filename,
          originalName: file.relativePath,
          size: file.size,
          sourcePath,
          sourceMtime: file.sourceMtime,
          sourceSize: file.size,
        })
        enqueueDocIndex({ docId: existing.id, kbId: kb.id, originalName: file.relativePath, filePath: storedPath })
        summary.updated++
        summary.queued++
      } catch (err) {
        summary.errors.push(`${file.relativePath}: ${(err as Error).message}`)
      }
      continue
    }

    const filename = makeStoredFilename(file.relativePath)
    const storedPath = path.join(kbDir, filename)
    try {
      fs.copyFileSync(sourcePath, storedPath)
      const doc = createDoc({
        kbId: kb.id,
        filename,
        originalName: file.relativePath,
        size: file.size,
        indexStatus: 'pending',
        sourceType: 'sync',
        sourcePath,
        sourceMtime: file.sourceMtime,
        sourceSize: file.size,
      })
      enqueueDocIndex({ docId: doc.id, kbId: kb.id, originalName: file.relativePath, filePath: storedPath })
      summary.added++
      summary.queued++
    } catch (err) {
      summary.errors.push(`${file.relativePath}: ${(err as Error).message}`)
    }
  }

  for (const doc of sourceDocs) {
    if (!doc.source_path || scannedSourceKeys.has(sourcePathKey(doc.source_path))) continue
    removeStoredDocument(kb.id, doc)
    summary.removed++
  }

  return summary
}

// ── Express ───────────────────────────────────────────

export const app = express()
if (TRUST_PROXY) app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  next()
})
const corsOrigins = CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) ?? []
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : IS_PRODUCTION ? { origin: false } : undefined))
app.use(express.json({ limit: '4mb' }))
app.use(express.static(path.join(__dirname, '../public')))
app.get('/favicon.ico', (_req, res) => res.status(204).end())

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

app.get('/readyz', async (_req, res) => {
  res.json({ status: 'ok', llmOnline: await checkLlmOnline(), model: currentModel })
})

// 根路径重定向到登录页
app.get('/', (_req, res) => res.redirect('/login.html'))

const LOGIN_WINDOW_MS = parsePositiveInt(envValue('LOGIN_RATE_WINDOW_MS'), 15 * 60 * 1000, 'LOGIN_RATE_WINDOW_MS')
const LOGIN_MAX_ATTEMPTS = parsePositiveInt(envValue('LOGIN_RATE_MAX'), 10, 'LOGIN_RATE_MAX')
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().trim() : ''
  const key = `${req.ip}:${username}`
  const now = Date.now()
  const state = loginAttempts.get(key)
  if (!state || state.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    next()
    return
  }
  if (state.count >= LOGIN_MAX_ATTEMPTS) {
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' })
    return
  }
  state.count++
  next()
}

// ── 认证路由 ──────────────────────────────────────────

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body as { username: string; password: string }
  if (!username || !password) {
    res.status(400).json({ error: '用户名和密码不能为空' }); return
  }

  const user = getUserByUsername(username)
  if (!user || !verifyPassword(password, user.password_hash)) {
    audit(req, 'auth.login_failed', 'auth', {
      userId: user?.id ?? null,
      username: username || null,
      detail: { username },
    })
    res.status(401).json({ error: '用户名或密码错误' }); return
  }

  const token = signToken({ userId: user.id, username: user.username, role: user.role })
  audit(req, 'auth.login', 'auth', { userId: user.id, username: user.username })
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

app.get('/api/me', requireAuth, (req: AuthRequest, res) => {
  res.json(req.user)
})

app.patch('/api/me/password', requireAuth, (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string; newPassword: string
  }
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: '请填写当前密码和新密码' }); return
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: '新密码至少 6 位' }); return
  }

  const user = getUserById(req.user!.userId)
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    res.status(401).json({ error: '当前密码错误' }); return
  }

  updateUserPassword(req.user!.userId, hashPassword(newPassword))
  audit(req, 'user.password_changed', 'user', { entityId: req.user!.userId })
  res.json({ ok: true })
})

// ── 知识库路由 ────────────────────────────────────────

app.get('/api/kbs', requireAuth, (req: AuthRequest, res) => {
  const kbs = req.user!.role === 'admin'
    ? getAllKbs()
    : listKbsForUser(req.user!.userId)
  res.json(kbs.map(kb => ({ ...publicKb(kb, req.user), ...getKbStats(kb.id) })))
})

app.post('/api/kbs', requireAuth, (req: AuthRequest, res) => {
  const { name, description } = req.body as { name: string; description?: string }
  if (!name?.trim()) { res.status(400).json({ error: '知识库名称不能为空' }); return }

  // 先用占位路径创建记录，拿到 ID 后更新为真实路径
  const kb = createKb({ name: name.trim(), description, storagePath: '', ownerId: req.user!.userId })
  const realPath = path.join(STORAGE_PATH, `kb_${kb.id}`)
  fs.mkdirSync(realPath, { recursive: true })
  updateKbStoragePath(kb.id, realPath)
  audit(req, 'kb.create', 'kb', { entityId: kb.id, kbId: kb.id, detail: { name: name.trim() } })

  res.status(201).json({ ...kb, storage_path: realPath })
})

app.get('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限访问该知识库' }); return
  }
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  res.json(publicKb(kb, req.user))
})

app.delete('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限删除' }); return
  }

  // 删除存储目录（使用计算路径，兼容旧数据）
  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  if (fs.existsSync(kbDir)) {
    fs.rmSync(kbDir, { recursive: true, force: true })
  }
  deleteKb(kbId)
  audit(req, 'kb.delete', 'kb', { entityId: kbId, kbId, detail: { name: kb.name } })
  res.json({ ok: true })
})

app.patch('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限修改' }); return
  }
  const { name, description } = req.body as { name?: string; description?: string }
  if (!name?.trim()) { res.status(400).json({ error: '名称不能为空' }); return }
  updateKbMeta(kbId, name.trim(), description?.trim() ?? null)
  audit(req, 'kb.update', 'kb', { entityId: kbId, kbId, detail: { name: name.trim() } })
  res.json({ ok: true })
})

app.patch('/api/kbs/:id/public', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限修改' }); return
  }
  updateKbPublic(kbId, Boolean(req.body.is_public))
  audit(req, 'kb.public_update', 'kb', {
    entityId: kbId,
    kbId,
    detail: { is_public: Boolean(req.body.is_public) },
  })
  res.json({ ok: true })
})

app.patch('/api/kbs/:id/sync-source', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = requireKbOwnerOrAdmin(req, res, kbId)
  if (!kb) return

  const rawPath = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
  if (!rawPath) {
    updateKbSyncSource(kbId, null)
    updateKbSyncResult(kbId, '同步目录已清空')
    audit(req, 'kb.sync_source_clear', 'kb', { entityId: kbId, kbId })
    res.json({ ok: true, sync_source_path: null })
    return
  }

  const sourcePath = normalizeSourcePath(rawPath)
  if (!isDirectory(sourcePath)) {
    res.status(400).json({ error: '同步路径不存在或不是文件夹' })
    return
  }
  if (isPathInside(STORAGE_PATH, sourcePath) || isPathInside(sourcePath, STORAGE_PATH)) {
    res.status(400).json({ error: '同步路径不能指向或包含应用存储目录' })
    return
  }

  updateKbSyncSource(kbId, sourcePath)
  audit(req, 'kb.sync_source_update', 'kb', { entityId: kbId, kbId, detail: { path: sourcePath } })
  res.json({ ok: true, sync_source_path: sourcePath })
})

app.post('/api/kbs/:id/sync', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = requireKbOwnerOrAdmin(req, res, kbId)
  if (!kb) return

  const sourcePath = kb.sync_source_path ? normalizeSourcePath(kb.sync_source_path) : ''
  if (!sourcePath) {
    res.status(400).json({ error: '请先设置同步文件夹' })
    return
  }
  if (!isDirectory(sourcePath)) {
    res.status(400).json({ error: '同步路径不存在或不是文件夹' })
    return
  }

  const summary = syncKnowledgeBase(kb, sourcePath)
  updateKbSyncResult(kbId, JSON.stringify(summary))
  audit(req, 'kb.sync_run', 'kb', {
    entityId: kbId,
    kbId,
    detail: { ...summary, errors: summary.errors.slice(0, 5) },
  })
  res.json(summary)
})

// ── 知识库成员路由 ────────────────────────────────────

app.get('/api/kbs/:id/members', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  res.json(listKbMembers(kbId))
})

app.post('/api/kbs/:id/members', requireAuth, (req: AuthRequest, res) => {
  const kbId   = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const { username } = req.body as { username: string }
  if (!username?.trim()) { res.status(400).json({ error: '请提供用户名' }); return }

  const target = getUserByUsername(username.trim())
  if (!target) { res.status(404).json({ error: `用户 "${username}" 不存在` }); return }
  if (target.id === kb.owner_id) { res.status(400).json({ error: '创建者已有访问权限' }); return }

  grantKbAccess(kbId, target.id)
  audit(req, 'kb.member_add', 'kb_member', {
    entityId: target.id,
    kbId,
    detail: { username: target.username },
  })
  res.status(201).json({ id: target.id, username: target.username, role: target.role })
})

app.delete('/api/kbs/:id/members/:userId', requireAuth, (req: AuthRequest, res) => {
  const kbId   = Number(req.params.id)
  const userId = Number(req.params.userId)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  revokeKbAccess(kbId, userId)
  audit(req, 'kb.member_remove', 'kb_member', { entityId: userId, kbId })
  res.json({ ok: true })
})

// ── 文档路由 ──────────────────────────────────────────

app.get('/api/kbs/:id/docs', requireAuth, (req: AuthRequest, res) => {
  const kbId   = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const limit  = req.query.limit  ? Math.min(Number(req.query.limit),  200) : undefined
  const offset = req.query.offset ? Number(req.query.offset) : undefined
  const total  = countDocs(kbId)
  const items  = listDocs(kbId, limit, offset).map(doc => publicDoc(doc, kb, req.user))
  if (limit != null) {
    res.json({ items, total, hasMore: (offset ?? 0) + items.length < total })
  } else {
    res.json(items)   // 不传 limit 时保持原格式，兼容 chat.js 的 kbDocMap 加载
  }
})

app.post('/api/kbs/:id/docs', requireAuth, upload.array('files', 20), async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const files = req.files as Express.Multer.File[] | undefined
  if (!files?.length) { res.status(400).json({ error: '未接收到文件' }); return }

  const docs = files.map(f => {
    // multer 在 Windows 上把中文文件名按 Latin-1 读取，需转回 UTF-8
    const origName = Buffer.from(f.originalname, 'latin1').toString('utf8')
    const doc = createDoc({ kbId, filename: f.filename, originalName: origName, size: f.size, indexStatus: 'pending' })
    enqueueDocIndex({ docId: doc.id, kbId, originalName: origName, filePath: f.path })
    return doc
  })
  audit(req, 'doc.upload', 'doc', {
    kbId,
    detail: { count: docs.length, names: docs.map(doc => doc.original_name).slice(0, 20) },
  })
  res.status(201).json(docs)
})

// ── 直接创建文本文档 ──────────────────────────────────
app.post('/api/kbs/:id/docs/text', requireAuth, async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const { title, content } = req.body as { title?: string; content?: string }
  if (!content?.trim()) { res.status(400).json({ error: '内容不能为空' }); return }

  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }

  const safeName = (title?.trim() || '未命名笔记')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 80)
  const timestamp  = Date.now()
  const filename   = `${timestamp}_${Math.random().toString(36).slice(2,8)}.md`
  const origName   = safeName.endsWith('.md') ? safeName : `${safeName}.md`
  const filePath   = path.join(kb.storage_path, filename)

  fs.writeFileSync(filePath, content, 'utf-8')
  const size = Buffer.byteLength(content, 'utf-8')

  const doc = createDoc({ kbId, filename, originalName: origName, size, indexStatus: 'processing', sourceType: 'text' })
  try {
    indexDocContent(doc.id, kbId, origName, filePath, content)
  } catch (e) {
    updateDocIndexStatus(doc.id, 'error', (e as Error).message.slice(0, 500))
    console.warn('[FTS5] 索引失败:', (e as Error).message)
  }

  audit(req, 'doc.create_text', 'doc', {
    entityId: doc.id,
    kbId,
    detail: { title: origName, size },
  })
  res.status(201).json(doc)
})

const PREVIEW_MAX_CHARS = 10_000
const TEXT_PREVIEWABLE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.ts', '.js', '.py', '.java', '.go',
  '.rs', '.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.xml', '.sh',
])

app.get('/api/kbs/:id/docs/:docId/preview', requireAuth, (req: AuthRequest, res) => {
  const kbId  = Number(req.params.id)
  const docId = Number(req.params.docId)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const doc = getDocById(docId)
  if (!doc || doc.kb_id !== kbId) {
    res.status(404).json({ error: '文档不存在' }); return
  }
  const origExt = path.extname(doc.original_name).toLowerCase()
  const kbDir   = path.join(STORAGE_PATH, `kb_${kbId}`)
  let readPath: string
  let displayExt: string
  if (origExt === '.pdf' || OFFICE_EXTS.has(origExt)) {
    readPath   = path.join(kbDir, doc.filename.replace(/\.[^.]+$/i, '.txt'))
    displayExt = '.txt'
  } else {
    readPath   = path.join(kbDir, doc.filename)
    displayExt = origExt
  }
  if (!TEXT_PREVIEWABLE_EXTS.has(displayExt)) {
    res.status(415).json({ error: '该文件类型不支持预览', type: origExt }); return
  }
  if (!fs.existsSync(readPath)) {
    const notReadyMsg = (origExt === '.pdf' || OFFICE_EXTS.has(origExt))
      ? '文档文本提取失败或尚未完成'
      : '文件不存在'
    res.status(404).json({ error: notReadyMsg }); return
  }
  const totalBytes = fs.statSync(readPath).size
  const fd  = fs.openSync(readPath, 'r')
  const buf = Buffer.alloc(Math.min(totalBytes, PREVIEW_MAX_CHARS * 3))
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  let content = buf.subarray(0, bytesRead).toString('utf-8')
  if (content.length > PREVIEW_MAX_CHARS) content = content.slice(0, PREVIEW_MAX_CHARS)
  const truncated = totalBytes > PREVIEW_MAX_CHARS * 3 || content.length >= PREVIEW_MAX_CHARS
  res.json({
    filename: doc.original_name, ext: origExt, displayExt, totalBytes, content, truncated,
    truncatedHint: truncated
      ? `内容过长，仅显示前 ${(content.length / 1024).toFixed(1)} KB（共 ${(totalBytes / 1024).toFixed(1)} KB）`
      : null,
  })
})

app.get('/api/kbs/:id/docs/:docId/related', requireAuth, (req: AuthRequest, res) => {
  const kbId  = Number(req.params.id)
  const docId = Number(req.params.docId)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const doc = getDocById(docId)
  if (!doc || doc.kb_id !== kbId) { res.status(404).json({ error: '文档不存在' }); return }
  const limit = Math.min(Number(req.query.limit ?? 5), 10)
  const related = getRelatedDocs(kbId, docId, limit)
  res.json({ items: related, vectorsAvailable: related.length > 0 })
})

app.delete('/api/kbs/:id/docs/batch', requireAuth, async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const ids: number[] = req.body?.ids ?? []
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: '请提供文档 id 列表' }); return
  }
  let deleted = 0
  for (const docId of ids) {
    const doc = getDocById(docId)
    if (!doc || doc.kb_id !== kbId) continue
    removeStoredDocument(kbId, doc)
    deleted++
  }
  audit(req, 'doc.batch_delete', 'doc', { kbId, detail: { requested: ids.length, deleted } })
  res.json({ deleted })
})

app.delete('/api/kbs/:id/docs/:docId', requireAuth, (req: AuthRequest, res) => {
  const kbId  = Number(req.params.id)
  const docId = Number(req.params.docId)
  const kb  = getKbById(kbId)
  const doc = getDocById(docId)
  if (!kb || !doc || doc.kb_id !== kbId) { res.status(404).json({ error: '不存在' }); return }

  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  removeStoredDocument(kbId, doc)
  audit(req, 'doc.delete', 'doc', {
    entityId: docId,
    kbId,
    detail: { name: doc.original_name },
  })
  res.json({ ok: true })
})

// ── 统计路由 ──────────────────────────────────────────

app.get('/api/kbs/:id/stats', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const kb   = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '不存在' }); return }

  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  const fileStats = collectKbStats(kbDir)
  const docs = listDocs(kbId)

  // 格式化为可读文本（与 KBStatsTool 输出格式一致）
  const lines: string[] = [
    `📚 知识库：${kb.name}`,
    `─────────────────────────`,
    `文档总数：${docs.length}（已上传文件）`,
    `可索引文件：${fileStats.totalFiles}`,
    `总行数：${fileStats.totalLines.toLocaleString()}`,
    `总大小：${fileStats.totalSizeKB.toFixed(1)} KB`,
  ]

  if (Object.keys(fileStats.byExtension).length > 0) {
    lines.push(``, `按文件类型分布：`)
    const sorted = Object.entries(fileStats.byExtension).sort((a, b) => b[1].count - a[1].count)
    for (const [ext, info] of sorted) {
      lines.push(`  ${ext.padEnd(14)}${String(info.count).padStart(4)} 个文件  ${info.lines.toLocaleString()} 行`)
    }
  }

  const vectoredDocs = docs.filter(d => getDocVectorCount(d.id) > 0).length
  if (isEmbeddingEnabled()) {
    lines.push(``, `向量覆盖：${vectoredDocs}/${docs.length} 个文档已向量化`)
  }

  res.json({
    name: kb.name,
    stats: lines.join('\n'),
    totalDocs: docs.length,
    totalFiles: fileStats.totalFiles,
    totalLines: fileStats.totalLines,
    totalSizeKB: Math.round(fileStats.totalSizeKB),
    byExtension: fileStats.byExtension,
    vectoredDocs,
    embeddingEnabled: isEmbeddingEnabled(),
  })
})

// ── 对话历史路由 ──────────────────────────────────────

function serializeMessage(msg: Record<string, unknown>, seq: number) {
  return {
    role:         msg.role as string,
    content:      typeof msg.content === 'string' ? msg.content : (msg.content as string | null) ?? null,
    tool_calls:   ('tool_calls' in msg && msg.tool_calls) ? JSON.stringify(msg.tool_calls) : null,
    tool_call_id: ('tool_call_id' in msg) ? (msg.tool_call_id as string | null) ?? null : null,
    seq,
  }
}

function deserializeMessage(row: MessageRow): Record<string, unknown> {
  const base: Record<string, unknown> = { role: row.role, content: row.content ?? null }
  if (row.tool_calls)   base.tool_calls   = JSON.parse(row.tool_calls)
  if (row.tool_call_id) base.tool_call_id = row.tool_call_id
  return base
}

app.get('/api/kbs/:id/conversations', requireAuth, (req: AuthRequest, res) => {
  const kbId   = Number(req.params.id)
  const limit  = Math.min(Number(req.query.limit)  || 20, 100)
  const offset = Number(req.query.offset) || 0
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const total = countConversations(req.user!.userId, kbId)
  const items = listConversations(req.user!.userId, kbId, limit, offset)
  res.json({ items, total, hasMore: offset + items.length < total, nextOffset: offset + items.length })
})

app.post('/api/kbs/:id/conversations', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const conv = createConversation(req.user!.userId, kbId)
  res.status(201).json(conv)
})

app.get('/api/conversations/:convId', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  res.json(conv)
})

app.get('/api/conversations/:convId/messages', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const rows = listMessages(conv.id)
  res.json(rows.map(deserializeMessage))
})

app.delete('/api/conversations/batch', requireAuth, (req: AuthRequest, res) => {
  const ids: number[] = req.body?.ids ?? []
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: '请提供对话 id 列表' }); return
  }
  let deleted = 0
  for (const id of ids) {
    const conv = getConversationById(id)
    if (!conv) continue
    if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') continue
    deleteConversation(id)
    deleted++
  }
  audit(req, 'conversation.batch_delete', 'conversation', { detail: { requested: ids.length, deleted } })
  res.json({ deleted })
})

app.delete('/api/conversations/:convId', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  deleteConversation(conv.id)
  audit(req, 'conversation.delete', 'conversation', { entityId: conv.id, kbId: conv.kb_id })
  res.json({ ok: true })
})

app.patch('/api/conversations/:convId', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const { title } = req.body as { title?: string }
  if (!title?.trim()) { res.status(400).json({ error: '标题不能为空' }); return }
  updateConversationTitle(conv.id, title.trim().slice(0, 60))
  res.json({ ok: true })
})

app.patch('/api/conversations/:convId/pin', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  pinConversation(conv.id, Boolean(req.body?.pinned))
  res.json({ ok: true })
})

// ── 问答路由（SSE） ───────────────────────────────────

/** 从用户首条消息生成对话标题，过滤代码块前缀和 Markdown 标记 */
function generateTitle(question: string): string {
  const cleaned = question
    .replace(/^```[\w]*\n?/m, '')
    .replace(/```[\s\S]*$/m, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*>]\s*/gm, '')
    .trim()
  const firstLine = cleaned.split('\n').map(l => l.trim()).find(l => l.length > 3) ?? cleaned
  return firstLine.slice(0, 30) + (firstLine.length > 30 ? '…' : '')
}

app.post('/api/kbs/:id/ask', requireAuth, async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }

  const { question, conversationId: convIdParam } = req.body as {
    question: string; conversationId?: number | null
  }
  if (!question?.trim()) { res.status(400).json({ error: '问题不能为空' }); return }

  // 确定 conversation
  let conv
  if (convIdParam) {
    conv = getConversationById(Number(convIdParam))
    if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
    if (conv.user_id !== req.user!.userId) { res.status(403).json({ error: '无权限' }); return }
    if (conv.kb_id !== kbId) { res.status(400).json({ error: '对话不属于当前知识库' }); return }
  } else {
    conv = createConversation(req.user!.userId, kb.id)
  }

  const prevCount = countMessages(conv.id)
  const trustedHistory = buildTrustedHistory(
    listMessages(conv.id),
    HISTORY_MAX_MESSAGES,
    HISTORY_MAX_CHARS,
  )

  // SSE 头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  // 每 15 秒发送 SSE 注释保活，防止企业代理因空闲超时断开连接
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) }
  }, 15_000)

  // 客户端断开时中止 executor，避免后台继续消耗资源
  const abortCtrl = new AbortController()
  res.on('close', () => {
    abortCtrl.abort()
    clearInterval(keepalive)
  })

  const kbPath = path.join(STORAGE_PATH, `kb_${kb.id}`)

  const executor = new LLMExecutor({
    baseUrl:      LLM_BASE_URL,
    apiKey:       LLM_API_KEY,
    model:        currentModel,
    kbPath,
    systemPrompt: buildSystemPrompt(kb.name, kbPath),
    maxTurns:     MAX_TURNS,
    onEvent:      (e: QAEvent) => {
      if (!abortCtrl.signal.aborted) send(e)
    },
  })

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executor.run(question, ALL_TOOLS, trustedHistory.messages as any, abortCtrl.signal)

    // 客户端已断开时不持久化未完成的对话
    if (!abortCtrl.signal.aborted) {
      const newMsgs = (result.messages as unknown as Record<string, unknown>[]).slice(trustedHistory.messages.length)
      insertMessages(conv.id, newMsgs.map((m, i) => serializeMessage(m, prevCount + i)))
      touchConversation(conv.id)

      // 首轮对话自动命题
      if (prevCount === 0) {
        updateConversationTitle(conv.id, generateTitle(question))
      }

      send({
        type: 'done',
        turns: result.turns,
        messages: newMsgs,
        conversationId: conv.id,
        context: {
          usedMessages: trustedHistory.messages.length,
          totalMessages: trustedHistory.totalMessages,
          truncated: trustedHistory.truncated,
        },
      })
    }
  } catch (err) {
    if (!abortCtrl.signal.aborted) {
      send({ type: 'error', message: (err as Error).message })
    }
  } finally {
    clearInterval(keepalive)
  }

  res.end()
})

// ── 搜索路由 ──────────────────────────────────────────

/** 文档内容全文搜索（FTS5） */
app.get('/api/kbs/:id/search/docs', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const q     = String(req.query.q ?? '').trim()
  const limit = Math.min(Number(req.query.limit) || 10, 30)
  if (q.length < 1) { res.json([]); return }
  res.json(searchDocContent(kbId, q, limit))
})

/** 手动触发知识库 FTS5 重建索引 */
app.post('/api/kbs/:id/reindex', requireAuth, async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const docs  = listDocs(kbId)
  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  let indexed = 0
  let failed  = 0

  for (const doc of docs) {
    const filePath = path.join(kbDir, doc.filename)
    if (!fs.existsSync(filePath)) continue
    await processDocIndexJob({ docId: doc.id, kbId, originalName: doc.original_name, filePath })
    if (isDocIndexed(doc.id)) indexed++
    else failed++
  }

  audit(req, 'doc.reindex', 'doc', { kbId, detail: { indexed, failed, total: docs.length } })
  res.json({ indexed, failed, total: docs.length })
})

app.get('/api/search/conversations', requireAuth, (req: AuthRequest, res) => {
  const q      = String(req.query.q ?? '').trim()
  const limit  = Math.min(Number(req.query.limit)  || 20, 50)
  const offset = Number(req.query.offset) || 0
  if (q.length < 2) { res.json({ items: [], total: 0 }); return }
  const result = searchConversations(req.user!.userId, q, limit, offset)
  res.json(result)
})

// ── 管理员路由 ────────────────────────────────────────

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Number(req.query.offset) || 0
  const action = String(req.query.action ?? '').trim()
  const username = String(req.query.username ?? '').trim()
  const kbIdRaw = req.query.kbId != null ? Number(req.query.kbId) : undefined
  const result = listAuditEvents({
    limit,
    offset,
    action: action || undefined,
    username: username || undefined,
    kbId: Number.isFinite(kbIdRaw) ? kbIdRaw : undefined,
  })
  res.json({ ...result, hasMore: offset + result.items.length < result.total })
})

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json(listUsers())
})

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body as {
    username: string; password: string; role?: 'admin' | 'user'
  }
  if (!username?.trim() || !password) {
    res.status(400).json({ error: '用户名和密码不能为空' }); return
  }
  if (getUserByUsername(username)) {
    res.status(409).json({ error: '用户名已存在' }); return
  }
  const user = createUser(username.trim(), password, role ?? 'user')
  audit(req, 'admin.user_create', 'user', {
    entityId: user.id,
    detail: { username: user.username, role: user.role },
  })
  res.status(201).json({ id: user.id, username: user.username, role: user.role })
})

app.delete('/api/admin/users/:id', requireAdmin, (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  if (id === req.user!.userId) {
    res.status(400).json({ error: '不能删除自己' }); return
  }
  const target = getUserById(id)
  deleteUser(id)
  audit(req, 'admin.user_delete', 'user', {
    entityId: id,
    detail: { username: target?.username ?? null },
  })
  res.json({ ok: true })
})

app.patch('/api/admin/users/:id/role', requireAdmin, (req: AuthRequest, res) => {
  const uid  = Number(req.params.id)
  const role = req.body?.role
  if (role !== 'admin' && role !== 'user') {
    res.status(400).json({ error: '角色值无效' }); return
  }
  if (uid === req.user!.userId) {
    res.status(400).json({ error: '不能修改自己的角色' }); return
  }
  updateUserRole(uid, role)
  audit(req, 'admin.user_role_update', 'user', { entityId: uid, detail: { role } })
  res.json({ ok: true })
})

app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const { newPassword } = req.body as { newPassword: string }
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: '新密码至少 6 位' }); return
  }
  if (!getUserById(id)) { res.status(404).json({ error: '用户不存在' }); return }
  updateUserPassword(id, hashPassword(newPassword))
  audit(req, 'admin.user_password_reset', 'user', { entityId: id })
  res.json({ ok: true })
})

// ── 服务端配置（供前端读取） ───────────────────────────

async function checkLlmOnline(): Promise<boolean> {
  if (NODE_ENV === 'test') return true
  try {
    if (IS_OLLAMA) {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
      return r.ok
    }
    const r = await fetch(`${LLM_BASE_URL}/models/${encodeURIComponent(currentModel)}`, {
      headers: { Authorization: `Bearer ${LLM_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    })
    return r.ok
  } catch { return false }
}

app.get('/api/config', async (_req, res) => {
  const llmOnline = await checkLlmOnline()
  res.json({
    model: currentModel,
    provider: LLM_PROVIDER,
    llmOnline,
    ollamaOnline: llmOnline,
    embeddingEnabled: isEmbeddingEnabled(),
    embeddingModel: getEmbeddingModel() || null,
  })
})

app.get('/api/config/models', requireAuth, async (_req, res) => {
  try {
    if (IS_OLLAMA) {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) {
        const data = await r.json() as { models?: Array<{ name: string }> }
        const models = (data.models ?? []).map((m: { name: string }) => m.name)
        res.json({ models: models.length ? models : [currentModel], current: currentModel }); return
      }
    } else {
      const r = await fetch(`${LLM_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${LLM_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      })
      if (r.ok) {
        const data = await r.json() as { data?: Array<{ id?: string }> }
        const models = (data.data ?? []).map(m => m.id).filter((id): id is string => Boolean(id))
        res.json({ models: models.length ? models : [currentModel], current: currentModel }); return
      }
    }
    res.json({ models: [currentModel], current: currentModel })
  } catch {
    res.json({ models: [currentModel], current: currentModel })
  }
})

app.patch('/api/config/model', requireAdmin, (req: AuthRequest, res) => {
  const model = (req.body?.model as string | undefined)?.trim()
  if (!model) { res.status(400).json({ error: '模型名不能为空' }); return }
  currentModel = model
  console.log(`模型已切换为：${currentModel}`)
  audit(req, 'config.model_update', 'config', { detail: { model: currentModel } })
  res.json({ ok: true, model: currentModel })
})

// ── LLM 健康检查 ───────────────────────────────────

async function checkLLM(): Promise<void> {
  try {
    const online = await checkLlmOnline()
    if (online) {
      console.log(`✓  ${LLM_PROVIDER} 模型服务在线，当前模型 "${currentModel}"`)
    } else {
      console.warn(`⚠  ${LLM_PROVIDER} 模型服务连接失败 (${LLM_BASE_URL})`)
    }
  } catch (err) {
    console.warn(`⚠  无法连接模型服务 (${LLM_BASE_URL})：${(err as Error).message}`)
  }
}

// ── 启动时补建历史文档 FTS5 索引（后台，不阻塞启动） ────────────

async function reindexExistingDocs(): Promise<void> {
  const allKbs = getAllKbs()
  let total = 0, queued = 0, embQueued = 0
  for (const kb of allKbs) {
    const docs = listDocs(kb.id)
    for (const doc of docs) {
      total++
      const kbDir = path.join(STORAGE_PATH, `kb_${kb.id}`)
      const filePath = path.join(kbDir, doc.filename)
      if (!fs.existsSync(filePath)) continue

      if (!isDocIndexed(doc.id)) {
        enqueueDocIndex({ docId: doc.id, kbId: kb.id, originalName: doc.original_name, filePath })
        queued++
      } else if (isEmbeddingEnabled() && getDocVectorCount(doc.id) === 0) {
        // FTS 已就绪但向量缺失 — 后台补生成
        const txtPath = filePath.replace(/\.[^.]+$/i, '.txt')
        const readPath = fs.existsSync(txtPath) ? txtPath : filePath
        try {
          const text = fs.readFileSync(readPath, 'utf-8')
          void generateAndStoreEmbeddings(doc.id, kb.id, doc.original_name, readPath, text)
          embQueued++
        } catch { /* 跳过无法读取的文件 */ }
      }
    }
  }
  if (total > 0) {
    console.log(`[index] 已排队补建 FTS 索引：${queued}/${total} 个文档`)
    if (embQueued > 0) console.log(`[embedding] 已排队补生成向量：${embQueued} 个文档`)
  }
}

// ── 启动 ──────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    res.status(status).json({ error: err.message })
    return
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON request body.' })
    return
  }
  console.error('[http] unhandled error:', err)
  res.status(500).json({ error: 'Internal server error.' })
})

export function startServer(): void {
  app.listen(PORT, async () => {
  console.log('\n企业知识库系统已启动')
  console.log(`地址：http://localhost:${PORT}`)
  console.log(`模型：${currentModel}  (${LLM_BASE_URL})`)
  console.log(`存储：${STORAGE_PATH}`)
  console.log(`管理员账户：${ADMIN_USER}\n`)
  await checkLLM()
  reindexExistingDocs().catch(e => console.warn('[FTS5] 补建索引出错:', e.message))
  })
}

function isDirectRun(): boolean {
  const entryPoint = process.argv[1]
  return Boolean(entryPoint && path.resolve(entryPoint) === url.fileURLToPath(import.meta.url))
}

if (isDirectRun()) startServer()
