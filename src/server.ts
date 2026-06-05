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
         canUserAccessKb, grantKbAccess, revokeKbAccess, listKbMembers,
         listDocs, createDoc, deleteDoc, getDocById,
         updateUserPassword, updateUserRole,
         listConversations, createConversation, updateConversationTitle, touchConversation,
         deleteConversation, getConversationById, listMessages, insertMessages, countMessages,
         countConversations, pinConversation, getKbStats, searchConversations,
         indexDocContent, removeDocFromIndex, isDocIndexed, searchDocContent, countDocs } from './db.js'
import type { MessageRow } from './db.js'
import { requireAuth, requireAdmin, signToken, verifyPassword, hashPassword } from './auth.js'
import type { AuthRequest } from './auth.js'
import { OllamaExecutor } from './executor.js'
import { ALL_TOOLS, collectKbStats } from './tools.js'
import { buildSystemPrompt } from './prompt.js'
import type { QAEvent } from './tools.js'

// pdf-parse 用 CommonJS require，动态导入兼容 ESM
async function extractPdfText(filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfParse: any = (await import('pdf-parse')).default
  const data = await pdfParse(buf)
  return data.text as string
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// ── 配置 ──────────────────────────────────────────────

const NODE_ENV      = process.env.NODE_ENV ?? 'development'
const IS_PRODUCTION = NODE_ENV === 'production'
const DEFAULT_ADMIN_PASSWORD = 'Admin@123'
const DEFAULT_JWT_SECRET     = 'dev-secret-change-me'
const EXAMPLE_JWT_SECRET     = 'change-this-to-a-random-secret-string-at-least-32-chars'

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
const MAX_TURNS    = parsePositiveInt(envValue('OLLAMA_MAX_TURNS', 'LLM_MAX_TURNS'), 25, 'OLLAMA_MAX_TURNS')
const OLLAMA_URL   = LLM_BASE_URL.replace(/\/v1\/?$/, '')
const IS_OLLAMA    = isOllamaEndpoint(LLM_BASE_URL)
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
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
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
])

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
    res.status(401).json({ error: '用户名或密码错误' }); return
  }

  const token = signToken({ userId: user.id, username: user.username, role: user.role })
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
  res.json({ ok: true })
})

// ── 知识库路由 ────────────────────────────────────────

app.get('/api/kbs', requireAuth, (req: AuthRequest, res) => {
  const kbs = req.user!.role === 'admin'
    ? getAllKbs()
    : listKbsForUser(req.user!.userId)
  res.json(kbs.map(kb => ({ ...kb, ...getKbStats(kb.id) })))
})

app.post('/api/kbs', requireAuth, (req: AuthRequest, res) => {
  const { name, description } = req.body as { name: string; description?: string }
  if (!name?.trim()) { res.status(400).json({ error: '知识库名称不能为空' }); return }

  // 先用占位路径创建记录，拿到 ID 后更新为真实路径
  const kb = createKb({ name: name.trim(), description, storagePath: '', ownerId: req.user!.userId })
  const realPath = path.join(STORAGE_PATH, `kb_${kb.id}`)
  fs.mkdirSync(realPath, { recursive: true })
  updateKbStoragePath(kb.id, realPath)

  res.status(201).json({ ...kb, storage_path: realPath })
})

app.get('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限访问该知识库' }); return
  }
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  res.json(kb)
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
  res.json({ ok: true })
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
  res.json({ ok: true })
})

// ── 文档路由 ──────────────────────────────────────────

app.get('/api/kbs/:id/docs', requireAuth, (req: AuthRequest, res) => {
  const kbId   = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const limit  = req.query.limit  ? Math.min(Number(req.query.limit),  200) : undefined
  const offset = req.query.offset ? Number(req.query.offset) : undefined
  const total  = countDocs(kbId)
  const items  = listDocs(kbId, limit, offset)
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

  const docs = await Promise.all(files.map(async f => {
    // multer 在 Windows 上把中文文件名按 Latin-1 读取，需转回 UTF-8
    const origName = Buffer.from(f.originalname, 'latin1').toString('utf8')
    const ext = path.extname(origName).toLowerCase()
    let extractedText = ''

    // PDF → 提取文本，存为同名 .txt 供 Grep/Read 检索
    if (ext === '.pdf') {
      try {
        extractedText = await extractPdfText(f.path)
        const txtName = f.filename.replace(/\.pdf$/i, '.txt')
        fs.writeFileSync(path.join(path.dirname(f.path), txtName), extractedText, 'utf-8')
      } catch (e) {
        console.warn('[PDF] 文本提取失败:', (e as Error).message)
      }
    } else {
      try { extractedText = fs.readFileSync(f.path, 'utf-8') } catch { /* binary, skip */ }
    }

    const doc = createDoc({ kbId, filename: f.filename, originalName: origName, size: f.size })

    // 建立 FTS5 索引
    if (extractedText) {
      try {
        indexDocContent(doc.id, kbId, origName, f.path, extractedText)
      } catch (e) {
        console.warn('[FTS5] 索引失败:', (e as Error).message)
      }
    }

    return doc
  }))
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

  const doc = createDoc({ kbId, filename, originalName: origName, size })
  try {
    indexDocContent(doc.id, kbId, origName, filePath, content)
  } catch (e) {
    console.warn('[FTS5] 索引失败:', (e as Error).message)
  }

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
  if (origExt === '.pdf') {
    readPath   = path.join(kbDir, doc.filename.replace(/\.pdf$/i, '.txt'))
    displayExt = '.txt'
  } else {
    readPath   = path.join(kbDir, doc.filename)
    displayExt = origExt
  }
  if (!TEXT_PREVIEWABLE_EXTS.has(displayExt)) {
    res.status(415).json({ error: '该文件类型不支持预览', type: origExt }); return
  }
  if (!fs.existsSync(readPath)) {
    res.status(404).json({ error: origExt === '.pdf' ? 'PDF 文本提取失败或尚未完成' : '文件不存在' }); return
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

app.delete('/api/kbs/:id/docs/batch', requireAuth, async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const ids: number[] = req.body?.ids ?? []
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: '请提供文档 id 列表' }); return
  }
  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  let deleted = 0
  for (const docId of ids) {
    const doc = getDocById(docId)
    if (!doc || doc.kb_id !== kbId) continue
    try { fs.unlinkSync(path.join(kbDir, doc.filename)) } catch {}
    const txtPath = path.join(kbDir, doc.filename.replace(/\.pdf$/i, '.txt'))
    if (txtPath !== path.join(kbDir, doc.filename) && fs.existsSync(txtPath)) {
      try { fs.unlinkSync(txtPath) } catch {}
    }
    removeDocFromIndex(docId)
    deleteDoc(docId)
    deleted++
  }
  res.json({ deleted })
})

app.delete('/api/kbs/:id/docs/:docId', requireAuth, (req: AuthRequest, res) => {
  const kbId  = Number(req.params.id)
  const docId = Number(req.params.docId)
  const kb  = getKbById(kbId)
  const doc = getDocById(docId)
  if (!kb || !doc) { res.status(404).json({ error: '不存在' }); return }

  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  const filePath = path.join(kbDir, doc.filename)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  const txtPath = filePath.replace(/\.pdf$/i, '.txt')
  if (filePath !== txtPath && fs.existsSync(txtPath)) fs.unlinkSync(txtPath)
  removeDocFromIndex(docId)
  deleteDoc(docId)
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

  res.json({
    name: kb.name,
    stats: lines.join('\n'),          // 格式化文本（给前端直接展示）
    totalDocs: docs.length,
    totalFiles: fileStats.totalFiles,
    totalLines: fileStats.totalLines,
    totalSizeKB: Math.round(fileStats.totalSizeKB),
    byExtension: fileStats.byExtension,
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
  res.json({ deleted })
})

app.delete('/api/conversations/:convId', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  deleteConversation(conv.id)
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

  const { question, history = [], conversationId: convIdParam } = req.body as {
    question: string; history: unknown[]; conversationId?: number | null
  }
  if (!question?.trim()) { res.status(400).json({ error: '问题不能为空' }); return }

  // 确定 conversation
  let conv
  if (convIdParam) {
    conv = getConversationById(Number(convIdParam))
    if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
    if (conv.user_id !== req.user!.userId) { res.status(403).json({ error: '无权限' }); return }
  } else {
    conv = createConversation(req.user!.userId, kb.id)
  }

  const prevCount = countMessages(conv.id)

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

  const executor = new OllamaExecutor({
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
    const result = await executor.run(question, ALL_TOOLS, history as any, abortCtrl.signal)

    // 客户端已断开时不持久化未完成的对话
    if (!abortCtrl.signal.aborted) {
      const newMsgs = (result.messages as unknown as Record<string, unknown>[]).slice(history.length)
      insertMessages(conv.id, newMsgs.map((m, i) => serializeMessage(m, prevCount + i)))
      touchConversation(conv.id)

      // 首轮对话自动命题
      if (prevCount === 0) {
        updateConversationTitle(conv.id, generateTitle(question))
      }

      send({ type: 'done', turns: result.turns, messages: result.messages, conversationId: conv.id })
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

  const docs   = listDocs(kbId)
  const kbDir  = path.join(STORAGE_PATH, `kb_${kbId}`)
  let indexed  = 0

  for (const doc of docs) {
    const ext      = path.extname(doc.original_name).toLowerCase()
    let   filePath = path.join(kbDir, doc.filename)
    if (ext === '.pdf') filePath = filePath.replace(/\.pdf$/i, '.txt')
    if (!fs.existsSync(filePath)) continue
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      indexDocContent(doc.id, kbId, doc.original_name, filePath, text)
      indexed++
    } catch { /* skip unreadable */ }
  }

  res.json({ indexed, total: docs.length })
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
  res.status(201).json({ id: user.id, username: user.username, role: user.role })
})

app.delete('/api/admin/users/:id', requireAdmin, (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  if (id === req.user!.userId) {
    res.status(400).json({ error: '不能删除自己' }); return
  }
  deleteUser(id)
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
  res.json({ ok: true })
})

// ── 服务端配置（供前端读取） ───────────────────────────

async function checkLlmOnline(): Promise<boolean> {
  try {
    if (IS_OLLAMA) {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
      return r.ok
    }
    // 非 Ollama（MiniMax / OpenAI 等）：配置即视为在线，不发探测请求
    return true
  } catch { return false }
}

app.get('/api/config', async (_req, res) => {
  const ollamaOnline = await checkLlmOnline()
  res.json({ model: currentModel, ollamaUrl: OLLAMA_URL, ollamaOnline })
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
  res.json({ ok: true, model: currentModel })
})

// ── LLM 健康检查 ───────────────────────────────────

async function checkLLM(): Promise<void> {
  try {
    if (IS_OLLAMA) {
      const url = `${OLLAMA_URL}/api/tags`
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        console.log(`✓  Ollama 在线 (${LLM_BASE_URL})，当前模型 "${currentModel}"`)
      } else {
        console.warn(`⚠  Ollama 连接异常 (HTTP ${res.status})，请确认 ollama serve 已启动`)
      }
    } else {
      // 远程 API（MiniMax / OpenAI 等）：仅验证配置，不做网络探测
      console.log(`✓  远程 LLM 已配置：${LLM_BASE_URL}，模型 "${currentModel}"`)
    }
  } catch (err) {
    console.warn(`⚠  无法连接 Ollama (${LLM_BASE_URL})：${(err as Error).message}`)
    console.warn('   请先启动：ollama serve')
  }
}

// ── 启动时补建历史文档 FTS5 索引（后台，不阻塞启动） ────────────

async function reindexExistingDocs(): Promise<void> {
  const allKbs = getAllKbs()
  let total = 0, indexed = 0
  for (const kb of allKbs) {
    const docs = listDocs(kb.id)
    for (const doc of docs) {
      total++
      if (isDocIndexed(doc.id)) continue
      const kbDir = path.join(STORAGE_PATH, `kb_${kb.id}`)
      const ext   = path.extname(doc.original_name).toLowerCase()
      let filePath = path.join(kbDir, doc.filename)
      if (ext === '.pdf') filePath = filePath.replace(/\.pdf$/i, '.txt')
      if (!fs.existsSync(filePath)) continue
      try {
        const text = fs.readFileSync(filePath, 'utf-8')
        indexDocContent(doc.id, kb.id, doc.original_name, filePath, text)
        indexed++
      } catch { /* binary or unreadable, skip */ }
    }
  }
  if (total > 0) console.log(`[FTS5] 补建索引完成：${indexed}/${total} 个文档`)
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
