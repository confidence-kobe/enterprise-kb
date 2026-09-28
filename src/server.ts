/**
 * 企业级知识库核心 HTTP 服务入口 (Enterprise KB Main Application Server)
 *
 * 核心架构与模块职责：
 * 1. Express 5 运行时架构：单服务同时承载 Web UI 静态资源与全套 RESTful API；
 * 2. 多格式文档解构引擎 (Document Text Extractors)：
 *    - PDF 文档 (pdf-parse)
 *    - Word 文档 (.docx / .doc via mammoth)
 *    - Excel 电子表格 (.xlsx / .xls via exceljs)
 *    - PowerPoint 幻灯片 (.pptx / .ppt via officeparser)
 * 3. 严格的安全生产基线校验 (Security Hardening)：
 *    - 生产环境强制拒绝默认弱密码 (Admin@123) 与示例 JWT_SECRET；
 *    - 敏感 HTTP 安全响应头设置 (X-Content-Type-Options, Referrer-Policy, X-Frame-Options, Permissions-Policy)；
 *    - 文件路径遍历防护 (Path Traversal Protection)；
 * 4. 混合智能问答与工具调用管道：
 *    - SSE (Server-Sent Events) 流式推理推送与思考链过滤；
 *    - 基于 ReAct 的本地知识库沙箱检索 (SearchDocs, Read, Glob, Grep, KBStats)；
 * 5. Model Context Protocol (MCP) 端点集成：支持标准 HTTP/SSE 传输与 API Key 凭证管理。
 */

import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as url from 'node:url'
import { setGlobalDispatcher, ProxyAgent } from 'undici'

// 若环境变量中配置了 HTTP 代理，则让 Node.js fetch() 自动走代理
const _proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
if (_proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(_proxyUrl))
  console.log(`[proxy] 使用代理: ${_proxyUrl}`)
}

import { initDb, ensureAdmin, getUserByUsername, getUserById, listUsers, createUser, deleteUser,
         listKbsForUser, getAllKbs, getKbById, createKb, deleteKb, updateKbPublic, updateKbStoragePath, updateKbMeta,
         updateKbSyncSource, updateKbSyncResult,
         canUserAccessKb, grantKbAccess, revokeKbAccess, listKbMembers,
         listDocs, listDocsWithCounts, listDocsBySourceType, createDoc, updateDocFromSync, deleteDoc, getDocById,
         updateUserPassword, updateUserRole,
         listConversations, createConversation, updateConversationTitle, touchConversation,
         deleteConversation, getConversationById, listMessages, insertMessages, countMessages,
         countConversations, pinConversation, getKbStats, searchConversations,
         indexDocContent, removeDocFromIndex, isDocIndexed, searchDocContent, countDocs,
         updateDocMeta, updateDocSummary, updateDocIndexStatus, createAuditEvent, listAuditEvents,
         updateKbSystemPrompt, storeChunkVectors, hasVectors, getDocVectorCount, getRelatedDocs,
         upsertFeedback, getFeedbackStats, listNegativeFeedback,
         getDocByOriginalName, getDocByFilename, resetStuckDocuments,
         createMcpApiKey, listMcpApiKeys, getMcpApiKeysByPrefix, deleteMcpApiKey, touchMcpApiKey } from './db.js'
import type { Document, KnowledgeBase, MessageRow } from './db.js'
import { isEmbeddingEnabled, getEmbeddingModel, embedChunks } from './embedding.js'
import { chunkDocument } from './documentChunker.js'
import { requireAuth, requireAdmin, signToken, verifyPassword, hashPassword } from './auth.js'
import { createMcpServer, type McpContext } from './mcp-server.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AuthRequest } from './auth.js'
import { LLMExecutor } from './executor.js'
import { ALL_TOOLS, collectKbStats } from './tools.js'
import { buildSystemPrompt } from './prompt.js'
import type { QAEvent } from './tools.js'
import { buildTrustedHistory } from './conversationHistory.js'

// ── 多格式文档内容解析提取器 ──────────────────────────────────────────

/**
 * 提取 PDF 文件中的纯文本内容（动态异步载入 pdf-parse）
 *
 * @param filePath PDF 文件绝对路径
 * @returns 提取出的纯文本正文
 */
async function extractPdfText(filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfParse: any = (await import('pdf-parse')).default
  const data = await pdfParse(buf)
  return data.text as string
}

/**
 * 提取 Word (.docx / .doc) 文件的纯文本（使用 mammoth 引擎）
 *
 * @param filePath Word 文件绝对路径
 * @returns 提取出的原始文本
 */
async function extractDocxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth: any = (await import('mammoth')).default
  const result = await mammoth.extractRawText({ path: filePath })
  return result.value as string
}

/**
 * 提取 Excel (.xlsx / .xls) 表格各工作表中的单元格文本（使用 exceljs）
 * 将各行单元格通过制表符 '\t' 拼接，保留表格二维结构信息
 *
 * @param filePath Excel 文件绝对路径
 * @returns 按工作表分隔的制表符纯文本
 */
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

/**
 * 提取 PowerPoint (.pptx / .ppt) 幻灯片演讲稿与正文文本
 *
 * @param filePath PPT 文件绝对路径
 * @returns 幻灯片正文文本
 */
async function extractPptxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officeParser: any = (await import('officeparser')).default
  return await officeParser.parseOfficeAsync(filePath) as string
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// ── 全局环境配置与安全基线检查 ──────────────────────────────

/** 运行环境：development 或 production */
const NODE_ENV      = process.env.NODE_ENV ?? 'development'
const IS_PRODUCTION = NODE_ENV === 'production'
const DEFAULT_ADMIN_PASSWORD  = 'Admin@123'
const EXAMPLE_ADMIN_PASSWORD  = 'change-this-admin-password'
const DEFAULT_JWT_SECRET      = 'dev-secret-change-me'
const EXAMPLE_JWT_SECRET      = 'change-this-to-a-random-secret-string-at-least-32-chars'

/**
 * 优先读取主环境变量，回退到历史别名变量
 */
function envValue(primary: string, ...aliases: string[]): string | undefined {
  for (const key of [primary, ...aliases]) {
    const val = process.env[key]?.trim()
    if (val) return val
  }
  return undefined
}

/**
 * 解析正整数环境变量，非法时抛出配置异常
 */
function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer.`)
  return n
}

/**
 * 探测模型地址是否为本地 Ollama 服务端
 */
function isOllamaEndpoint(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1/.test(baseUrl) && baseUrl.includes('11434')
}

/**
 * 规范化模型 API Base URL（去除末尾斜杠，为 Ollama 自动补全 /v1 兼容路径）
 */
function normalizeLlmBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  if (isOllamaEndpoint(trimmed) && !trimmed.endsWith('/v1')) return `${trimmed}/v1`
  return trimmed
}

/** 服务 HTTP 监听端口，默认 8080 */
const PORT         = parsePositiveInt(envValue('PORT'), 8080, 'PORT')
/** 模型 API 基础路径 */
const LLM_BASE_URL = normalizeLlmBaseUrl(envValue('LLM_BASE_URL', 'OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1')
/** 模型 API 鉴权密钥 */
const LLM_API_KEY  = envValue('LLM_API_KEY', 'OLLAMA_API_KEY') ?? 'ollama'
/** 问答默认使用的语言模型标识符 */
let currentModel   = envValue('LLM_MODEL', 'OLLAMA_MODEL') ?? 'qwen2.5:7b'
/** 问答 ReAct 智能体最大工具调用轮数 */
const MAX_TURNS    = parsePositiveInt(envValue('LLM_MAX_TURNS', 'OLLAMA_MAX_TURNS'), 8, 'LLM_MAX_TURNS')
/** 单次问答上下文纳入的历史消息条数上限 */
const HISTORY_MAX_MESSAGES = parsePositiveInt(envValue('HISTORY_MAX_MESSAGES'), 40, 'HISTORY_MAX_MESSAGES')
/** 单次问答上下文历史字符预算配额 */
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

/** 将路径相对项目根目录解析为绝对路径 */
function resolveFromProject(envVal: string | undefined, fallback: string): string {
  const val = envVal ?? fallback
  return path.isAbsolute(val) ? val : path.resolve(PROJECT_ROOT, val)
}

/** 知识库上传与解析文件的物理根目录 */
const STORAGE_PATH = resolveFromProject(process.env.STORAGE_PATH, 'storage')
/** SQLite 数据库文件绝对物理路径 */
const DB_PATH      = resolveFromProject(process.env.DB_PATH,      'data/enterprise-kb.db')
/** 初始管理员用户名 */
const ADMIN_USER   = process.env.ADMIN_USERNAME   ?? 'admin'
/** 初始管理员密码 */
const ADMIN_PASS   = process.env.ADMIN_PASSWORD   ?? 'Admin@123'
const CORS_ORIGIN  = envValue('CORS_ORIGIN')
const TRUST_PROXY  = /^(1|true|yes)$/i.test(envValue('TRUST_PROXY') ?? '')

/**
 * 生产环境部署合规校验
 * 阻断弱密钥、默认密码启动，确保生产安全
 */
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

// ── 服务初始化 ────────────────────────────────────────────

validateRuntimeConfig()
if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true })
initDb(DB_PATH)
ensureAdmin(ADMIN_USER, ADMIN_PASS)

// ── Multer 文件上传与同步策略 ─────────────────────────────────

// ── 文件上传格式白名单与同步扫描策略 ─────────────────────────────────

/** 系统允许上传与解析的文档扩展名白名单 */
const ALLOWED_EXTS = new Set([
  '.txt', '.md', '.markdown', '.pdf',
  '.ts', '.js', '.py', '.java', '.go', '.rs',
  '.json', '.yaml', '.yml', '.toml',
  '.csv', '.html', '.xml', '.sh',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
])

/** 专属 Office 格式后缀集合 */
const OFFICE_EXTS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])

/** 本地目录同步时跳过的隐藏文件夹、依赖及构建缓存目录 */
const SYNC_SKIP_DIRS = new Set([
  '.git', '.svn', '.hg',
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache',
  '__pycache__', '.venv', 'venv',
])
/** 本地单次同步允许导入的最大文件数量，默认 1000 */
const SYNC_MAX_FILES = parsePositiveInt(envValue('SYNC_MAX_FILES'), 1000, 'SYNC_MAX_FILES')
/** 本地单次同步允许导入的最大总字节上限，默认 500MB */
const SYNC_MAX_TOTAL_BYTES = parsePositiveInt(envValue('SYNC_MAX_TOTAL_MB'), 500, 'SYNC_MAX_TOTAL_MB') * 1024 * 1024
/** 单个文件最大允许字节数 (50MB) */
const SYNC_MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * 待同步的文件条目描述
 */
interface SyncFile {
  /** 文件在操作系统的绝对路径 */
  absolutePath: string
  /** 相对同步源根目录的相对路径 (POSIX 格式斜杠) */
  relativePath: string
  /** 文件大小 (Bytes) */
  size: number
  /** 文件最后修改时间戳（毫秒级） */
  sourceMtime: number
}

/**
 * 同步过程中被跳过的文件计数统计
 */
interface SyncSkipped {
  /** 不在扩展名白名单中 */
  unsupported: number
  /** 超出单个文件大小上限 (50MB) */
  tooLarge: number
  /** 达到单次同步文件总数或总容量阈值 */
  limit: number
  /** 符号链接（安全跳过） */
  symlink: number
  /** 隐藏或黑名单目录 */
  hiddenDir: number
  /** 读文件元数据出错 */
  errors: number
}

/**
 * 知识库同步操作执行摘要汇总
 */
interface SyncSummary {
  /** 新增入库的文档数 */
  added: number
  /** 内容变更重新索引的文档数 */
  updated: number
  /** 源目录已删除而被同步清理的文档数 */
  removed: number
  /** 推入后台异步索引队列的总任务数 */
  queued: number
  /** 未发生修改保持不变的文档数 */
  unchanged: number
  /** 实际扫描到的有效白名单文件数 */
  scanned: number
  /** 跳过明细统计 */
  skipped: SyncSkipped
  /** 记录的部分错误信息（最多返回前 20 条） */
  errors: string[]
}

/**
 * 安全校验：检查目标子路径 child 是否严格位于指定父目录 parent 内部
 * 防止通过 `../` 进行任意路径遍历攻击 (Path Traversal Protection)
 *
 * @param parent 允许的基准父目录
 * @param child 待检查的子路径
 * @returns 是否安全在父目录内
 */
function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 将同步源路径规范化为绝对路径并统一分隔符
 */
function normalizeSourcePath(sourcePath: string): string {
  return path.normalize(path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(PROJECT_ROOT, sourcePath))
}

/**
 * 安全判断指定路径是否为现有文件夹
 */
function isDirectory(sourcePath: string): boolean {
  try {
    return fs.statSync(sourcePath).isDirectory()
  } catch {
    return false
  }
}

/**
 * 生成用于 Map 映射的文件路径比对键（在 Windows 系统下忽略大小写）
 */
function sourcePathKey(sourcePath: string): string {
  const normalized = path.normalize(sourcePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 为入库文档生成全局唯一的物理存储文件名，保留原始扩展名
 * 格式：`时间戳_随机字符.ext`
 */
function makeStoredFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase()
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`
}

/**
 * 物理清理文档磁盘文件，并彻底从索引与数据库中删除
 *
 * @param kbId 知识库 ID
 * @param doc 文档实体
 */
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

/**
 * 检查当前登录用户是否具备管理该知识库的高级权限（管理员或创建者本人）
 */
function canManageKb(kb: KnowledgeBase, user: AuthRequest['user']): boolean {
  return Boolean(user && (user.role === 'admin' || kb.owner_id === user.userId))
}

/**
 * 针对普通访客用户脱敏知识库信息（隐藏服务器本地同步绝对路径等敏感内网路径）
 */
function publicKb(kb: KnowledgeBase, user: AuthRequest['user']): KnowledgeBase {
  if (canManageKb(kb, user)) return kb
  return { ...kb, sync_source_path: null, sync_last_at: null, sync_last_result: null }
}

/**
 * 针对普通访客用户脱敏文档信息（隐藏内网 source_path 路径）
 */
function publicDoc(doc: Document, kb: KnowledgeBase, user: AuthRequest['user']): Document {
  if (canManageKb(kb, user)) return doc
  return { ...doc, source_path: null }
}

/**
 * 快捷记录审计日志辅助函数
 */
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

/**
 * 溯源引证结构体（向前端返回精准引用来源与所在行号）
 */
interface SourceRef {
  /** 引用的文档文件名 */
  name: string
  /** 引用的具体起始行号 */
  line: number
  /** 关联的文档 ID，未识别时为 null */
  docId: number | null
}

/**
 * 从多轮交互的工具调用消息流中自动提取模型所依据的知识库文档来源
 *
 * 提取机制：
 * 1. 扫描 assistant 的 tool_calls：若调用了 `Read` 工具，从参数中提取物理文件并匹配文档库原始文件名；
 * 2. 扫描 tool 的执行结果：若为 `SearchDocs` 工具，使用正则 `/【(.+?)】（行 (\d+)）/g` 自动提取匹配的标题与物理行号；
 * 3. 内存 Set 去重，返回清晰的引用证据链。
 *
 * @param kbId 知识库 ID
 * @param messages 本轮交互生成的消息列表
 * @returns 溯源列表
 */
function extractSources(kbId: number, messages: Record<string, unknown>[]): SourceRef[] {
  const sources: SourceRef[] = []
  const seen = new Set<string>()
  const toolCallNames = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const tcs = msg.tool_calls as Array<{ id: string; function?: { name?: string; arguments?: string } }> | undefined
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          if (tc.id) toolCallNames.set(tc.id, tc.function?.name ?? '')
          if (tc.function?.name === 'Read' && tc.function.arguments) {
            try {
              const args = JSON.parse(tc.function.arguments) as { file_path?: string }
              if (args.file_path) {
                const filename = path.basename(args.file_path)
                const key = `read:${filename}`
                if (!seen.has(key)) {
                  seen.add(key)
                  const doc = getDocByFilename(kbId, filename)
                  sources.push({ name: doc?.original_name ?? filename, line: 1, docId: doc?.id ?? null })
                }
              }
            } catch { /* ignore */ }
          }
        }
      }
    }

    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id as string | undefined
      const toolName = toolCallId ? (toolCallNames.get(toolCallId) ?? '') : ''
      const content = typeof msg.content === 'string' ? msg.content : ''

      if (toolName === 'SearchDocs') {
        const regex = /【(.+?)】（行 (\d+)）/g
        for (const m of content.matchAll(regex)) {
          const key = `${m[1]}:${m[2]}`
          if (!seen.has(key)) {
            seen.add(key)
            const doc = getDocByOriginalName(kbId, m[1])
            sources.push({ name: m[1], line: parseInt(m[2], 10), docId: doc?.id ?? null })
          }
        }
      }
    }
  }

  return sources
}

/**
 * 校验请求用户是否为该知识库的所有者或超级管理员
 * 若无权或知识库不存在，直接向 res 写入 404/403 响应并返回 null
 */
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

/**
 * 深度扫描本地同步源目录，收集待同步白名单文件
 * 包含符号链接过滤、超大文件阻断及总文件数/字节上限控制
 *
 * @param root 待扫描的本地源绝对根路径
 * @returns 包含扫描成功文件、跳过统计及错误信息的集合
 */
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

/**
 * Multer 文件上传中间件配置
 * - storage: 磁盘存储引擎，按知识库 ID 隔离存储子目录 (`storage/kb_{kbId}`)
 * - filename: 纳秒级时间戳 + 随机字符串 + 原扩展名，防止重名覆盖或路径遍历注入
 * - limits: 限制单文件最大为 50MB
 * - fileFilter: 严格基于允许的白名单文件后缀 (ALLOWED_EXTS) 进行安全过滤
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      // 动态提取知识库 ID，确保其物理存储目录存在
      const kbId = (req as AuthRequest).params?.id
      const dir  = path.join(STORAGE_PATH, `kb_${kbId}`)
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      // 生成全局唯一的存储文件名：当前时间戳_随机串.后缀
      const ext  = path.extname(file.originalname).toLowerCase()
      const name = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
      cb(null, name)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },   // 单文件大小限制：50MB
  fileFilter: (_req, file, cb) => {
    // 过滤不受支持的扩展名
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, ALLOWED_EXTS.has(ext))
  },
})

/**
 * 异步文档全文及向量索引任务的数据结构
 */
interface DocIndexJob {
  /** 数据库文档记录的主键 ID */
  docId: number
  /** 所属知识库的主键 ID */
  kbId: number
  /** 上传时的原始文件名或相对路径（用于展示与引用检索） */
  originalName: string
  /** 文档在服务器磁盘上的绝对存储路径 */
  filePath: string
}

/** 内存中等待处理的文档索引任务队列 */
const docIndexQueue: DocIndexJob[] = []
/** 队列工作器单例并发运行锁，确保任务顺序单线程执行，避免 SQLite 写竞争与系统过载 */
let docIndexWorkerRunning = false

/**
 * 从待索引文件中提取可供全文搜索与分块向量化的纯文本内容
 * 针对复杂二进制格式（PDF、Office 文档）调用对应解析器，并将提取出的文本持久化缓存至同名 `.txt` 文件
 *
 * @param job 索引任务详情
 * @returns 包含提取出的纯文本及对应索引文本物理路径的对象
 */
async function extractIndexableText(job: DocIndexJob): Promise<{ text: string; indexPath: string }> {
  const ext = path.extname(job.originalName).toLowerCase()
  const txtPath = job.filePath.replace(/\.[^.]+$/i, '.txt')

  // PDF 格式：通过 pdf-parse 提取文本，并缓存至 .txt
  if (ext === '.pdf') {
    const text = await extractPdfText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  // Word 格式 (.docx / .doc)：通过 mammoth 提取纯文本并缓存
  if (ext === '.docx' || ext === '.doc') {
    const text = await extractDocxText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  // Excel 格式 (.xlsx / .xls)：通过 xlsx 库提取各工作表为 CSV 文本并缓存
  if (ext === '.xlsx' || ext === '.xls') {
    const text = await extractXlsxText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  // PowerPoint 格式 (.pptx / .ppt)：通过解包 XML 提取文本并缓存
  if (ext === '.pptx' || ext === '.ppt') {
    const text = await extractPptxText(job.filePath)
    fs.writeFileSync(txtPath, text, 'utf-8')
    return { text, indexPath: txtPath }
  }
  // 纯文本类格式（.txt, .md, 代码文件等）：直接从磁盘以 UTF-8 读取
  return { text: fs.readFileSync(job.filePath, 'utf-8'), indexPath: job.filePath }
}

/**
 * 处理单个文档的索引与解析作业流水线
 * 流程包含：
 * 1. 检查文档在数据库中是否仍然有效（防异步处理前被用户删除）
 * 2. 将文档状态流转为 `'processing'`
 * 3. 提取可索引纯文本并建立 SQLite FTS5 全文索引
 * 4. 若开启了向量嵌入模型，异步触发文档语义分块与向量化嵌入入库
 * 5. 异步触发大语言模型生成文档核心摘要并入库
 * 6. 异常时自动清理索引残留并流转状态为 `'error'`
 *
 * @param job 索引任务对象
 */
async function processDocIndexJob(job: DocIndexJob): Promise<void> {
  // 若文档在排队期间已被删除，则直接丢弃任务
  if (!getDocById(job.docId)) return
  updateDocIndexStatus(job.docId, 'processing')

  try {
    // 步骤 1：提取结构化/纯文本
    const { text, indexPath } = await extractIndexableText(job)
    if (!text.trim()) throw new Error('文档没有可索引文本')

    // 步骤 2：建立 FTS5 全文检索索引
    indexDocContent(job.docId, job.kbId, job.originalName, indexPath, text)

    // 步骤 3：异步生成文档切片向量（不阻塞当前队列处理下一个文档）
    if (isEmbeddingEnabled()) {
      void generateAndStoreEmbeddings(job.docId, job.kbId, job.originalName, indexPath, text)
    }

    // 步骤 4：异步调用 LLM 生成文档极简核心摘要
    void generateDocSummary(job.docId, job.originalName, text)
  } catch (err) {
    // 索引失败异常回退：清除可能残留的 FTS 数据并将状态标记为 error
    removeDocFromIndex(job.docId)
    const message = (err as Error).message || '索引失败'
    updateDocIndexStatus(job.docId, 'error', message.slice(0, 500))
    console.warn(`[index] 文档解析失败 ${job.originalName}: ${message}`)
  }
}

/**
 * 针对文档进行智能文本分块，并调用嵌入模型生成向量后存入数据库
 *
 * @param docId 文档 ID
 * @param kbId 知识库 ID
 * @param originalName 原始文件名
 * @param filePath 物理文件绝对路径
 * @param text 文档完整纯文本
 */
async function generateAndStoreEmbeddings(
  docId: number,
  kbId: number,
  originalName: string,
  filePath: string,
  text: string,
): Promise<void> {
  try {
    // 1. 文档结构化智能切片（分块）
    const chunks = chunkDocument(text)
    // 2. 调用 OpenAI/Ollama 兼容的向量模型进行批量嵌入计算
    const vectors = await embedChunks(chunks)
    if (vectors.length) {
      // 3. 将切片向量存入 SQLite BLOB 存储表中
      storeChunkVectors(docId, kbId, vectors.map(v => ({
        chunkLine:    v.chunkLine,
        embedding:    v.embedding,
        originalName,
        filePath,
      })))
      console.log(`[embedding] ${originalName}: ${vectors.length} 个 chunk 向量化完成`)
    }
  } catch (err) {
    // 向量生成失败作为非致命降级处理，不影响全文检索基础功能
    console.warn(`[embedding] 向量生成失败 ${originalName}: ${(err as Error).message}`)
  }
}

/**
 * 调用配置的 LLM 大模型，自动为长文档生成 1-2 句（100 字以内）的高密度核心摘要
 *
 * @param docId 文档 ID
 * @param originalName 原始文件名
 * @param text 完整纯文本内容
 */
async function generateDocSummary(docId: number, originalName: string, text: string): Promise<void> {
  try {
    // 截取前 3000 个字符以控制 Prompt Token 消耗并聚焦首要背景
    const excerpt = text.slice(0, 3000).trim()
    if (!excerpt) return
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: currentModel,
        messages: [
          { role: 'system', content: '你是文档摘要助手。用1-2句话（不超过100字）概括文档的核心内容，不加引导语，直接输出摘要。' },
          { role: 'user', content: `文档名：${originalName}\n\n内容：\n${excerpt}` },
        ],
        max_tokens: 150,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) return
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] }
    const summary = data.choices?.[0]?.message?.content?.trim()
    if (summary) {
      // 更新数据库文档元数据中的 summary 列
      updateDocSummary(docId, summary)
      console.log(`[summary] ${originalName}: 摘要已生成`)
    }
  } catch {
    // 摘要生成失败不影响正常索引流程，静默忽略
  }
}

/**
 * 将文档索引任务推入后台处理队列，并触发消费者工作流
 *
 * @param job 待处理的文档索引任务
 */
function enqueueDocIndex(job: DocIndexJob): void {
  docIndexQueue.push(job)
  void drainDocIndexQueue()
}

/**
 * 消费后台文档索引队列循环工作器
 * 使用标志位进行单线程加锁排队，逐个处理队列中的索引任务
 */
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

/**
 * 执行知识库与外部本地文件夹的双向增量同步
 * 核心逻辑：
 * 1. 递归扫描源目录获取白名单文件列表
 * 2. 比对本地扫描结果与数据库存量同步文件（基于修改时间 source_mtime 与文件大小 source_size）
 * 3. 针对未变更且已完成索引的文件，跳过拷贝与索引
 * 4. 针对内容发生变更的文件，覆盖拷贝到内部存储，更新数据库并重新加入索引队列
 * 5. 针对新出现的文件，拷贝并插入数据库文档记录，触发索引队列
 * 6. 针对外部已被物理删除的文件，执行级联软/硬删除以清理知识库孤儿记录
 *
 * @param kb 目标知识库实体
 * @param sourceRoot 本地源绝对路径根目录
 * @returns 同步统计结果摘要
 */
function syncKnowledgeBase(kb: KnowledgeBase, sourceRoot: string): SyncSummary {
  // 递归扫描源文件
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

  // 获取该知识库下所有标记为外部同步 (source_type = 'sync') 的存量文件映射表
  const sourceDocs = listDocsBySourceType(kb.id, 'sync')
  const docsBySource = new Map(sourceDocs
    .filter(doc => doc.source_path)
    .map(doc => [sourcePathKey(doc.source_path!), doc]))
  const scannedSourceKeys = new Set<string>()

  // 1. 遍历扫描到的外部文件进行新增或增量更新
  for (const file of files) {
    const sourcePath = normalizeSourcePath(file.absolutePath)
    const key = sourcePathKey(sourcePath)
    scannedSourceKeys.add(key)

    const existing = docsBySource.get(key)
    if (existing) {
      // 比对修改时间和大小，且确认已有 FTS 索引，完全一致则判定为未变更
      const unchanged = existing.source_mtime === file.sourceMtime
        && existing.source_size === file.size
        && isDocIndexed(existing.id)
      if (unchanged) {
        summary.unchanged++
        continue
      }

      // 文件被修改或索引损坏：重新拷贝文件并重新排队构建索引
      const storedPath = path.join(kbDir, existing.filename)
      try {
        fs.copyFileSync(sourcePath, storedPath)
        // 清理旧的派生提取纯文本缓存
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

    // 新增文件：生成唯一存储文件名并持久化
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

  // 2. 检查存量同步文档，若源文件已不存在，则级联清理知识库中的存储与数据库记录
  for (const doc of sourceDocs) {
    if (!doc.source_path || scannedSourceKeys.has(sourcePathKey(doc.source_path))) continue
    removeStoredDocument(kb.id, doc)
    summary.removed++
  }

  return summary
}

// ── Express 应用配置与中间件 ───────────────────────────

/**
 * 实例化 Express 5 应用主服务
 */
export const app = express()

// 当位于反向代理（如 Nginx、K8s Ingress）后方时，启用 trust proxy 以正确获取客户端真实 IP
if (TRUST_PROXY) app.set('trust proxy', 1)

// 禁用 X-Powered-By 响应头，防止暴露底层 Express 框架特征
app.disable('x-powered-by')

// 全局安全标头强化中间件
app.use((_req, res, next) => {
  // 禁止浏览器猜测并推断响应的 MIME 类型（防止 MIME 混淆执行攻击）
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // 限制跨站 Referrer 泄露，仅在同源请求时传递完整 Referer 路径
  res.setHeader('Referrer-Policy', 'same-origin')
  // 严格禁止页面被嵌套至 <iframe> 中，防止点击劫持攻击 (Clickjacking)
  res.setHeader('X-Frame-Options', 'DENY')
  // 权限策略：完全禁用摄像头、麦克风、地理位置等敏感硬件 API
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  next()
})

// 跨域资源共享 (CORS) 安全策略
const corsOrigins = CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) ?? []
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : IS_PRODUCTION ? { origin: false } : undefined))

// 解析 JSON 格式请求体，设定最大载荷为 4MB
app.use(express.json({ limit: '4mb' }))

// 托管 public/ 目录下的前端单页应用静态资产
app.use(express.static(path.join(__dirname, '../public')))

// 浏览器图标请求静默返回 204 No Content，避免在控制台刷 404 错误
app.get('/favicon.ico', (_req, res) => res.status(204).end())

/**
 * 存活探针 (Liveness Probe)：用于 K8s 或监控检查进程存活状态与运行时间
 */
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

/**
 * 就绪探针 (Readiness Probe)：用于负载均衡器检查服务及上游 LLM 核心模型是否就绪
 */
app.get('/readyz', async (_req, res) => {
  res.json({ status: 'ok', llmOnline: await checkLlmOnline(), model: currentModel })
})

/** 访问根路径自动重定向至前端登录页 */
app.get('/', (_req, res) => res.redirect('/login.html'))

// 登录防暴力破解速率限制配置
const LOGIN_WINDOW_MS = parsePositiveInt(envValue('LOGIN_RATE_WINDOW_MS'), 15 * 60 * 1000, 'LOGIN_RATE_WINDOW_MS')
const LOGIN_MAX_ATTEMPTS = parsePositiveInt(envValue('LOGIN_RATE_MAX'), 10, 'LOGIN_RATE_MAX')
/** 记录各客户端 IP + 用户名维度的登录尝试计数与窗口重置时间戳 */
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

// 问答速率限制配置（每用户每 60 秒最多 20 次，防止 API 配额耗尽）
const QA_WINDOW_MS = 60_000
const QA_MAX_REQUESTS = parsePositiveInt(envValue('QA_RATE_MAX'), 20, 'QA_RATE_MAX')
/** 记录各用户的问答请求计数与窗口重置时间戳 */
const qaAttempts = new Map<string, { count: number; resetAt: number }>()

/**
 * 登录速率限制中间件
 * 针对 IP + 目标用户名维度进行滑动窗口限流，抵御密码爆破与撞库攻击
 */
function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().trim() : ''
  const key = `${req.ip}:${username}`
  const now = Date.now()
  const state = loginAttempts.get(key)
  if (!state || state.resetAt <= now) {
    // 首次请求或窗口已过期：初始化重置窗口
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    next()
    return
  }
  if (state.count >= LOGIN_MAX_ATTEMPTS) {
    // 超出最大允许尝试次数：拦截并返回 HTTP 429 Too Many Requests
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' })
    return
  }
  state.count++
  next()
}

/**
 * 问答速率限制中间件
 * 针对已认证用户 ID 维度进行滑动窗口限流，防止单用户耗尽 LLM API 配额
 */
function qaRateLimit(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as AuthRequest).user?.userId
  if (!userId) { next(); return }
  const key = String(userId)
  const now = Date.now()
  const state = qaAttempts.get(key)
  if (!state || state.resetAt <= now) {
    qaAttempts.set(key, { count: 1, resetAt: now + QA_WINDOW_MS })
    next()
    return
  }
  if (state.count >= QA_MAX_REQUESTS) {
    res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    return
  }
  state.count++
  next()
}

// ── 用户认证与凭据路由 ────────────────────────────────

/**
 * 用户登录接口
 * 接收用户名密码，通过 bcrypt 校验哈希并签发有效期的 JWT Token
 */
app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body as { username: string; password: string }
  if (!username || !password) {
    res.status(400).json({ error: '用户名和密码不能为空' }); return
  }

  const user = getUserByUsername(username)
  // 密码校验失败：记录失败审计日志并返回 401（统一模糊提示，防用户枚举）
  if (!user || !verifyPassword(password, user.password_hash)) {
    audit(req, 'auth.login_failed', 'auth', {
      userId: user?.id ?? null,
      username: username || null,
      detail: { username },
    })
    res.status(401).json({ error: '用户名或密码错误' }); return
  }

  // 签发带有用户基础权限角色的 JWT Token
  const token = signToken({ userId: user.id, username: user.username, role: user.role })
  audit(req, 'auth.login', 'auth', { userId: user.id, username: user.username })
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

/**
 * 获取当前登录用户的会话基本信息
 */
app.get('/api/me', requireAuth, (req: AuthRequest, res) => {
  res.json(req.user)
})

/**
 * 当前登录用户自主修改个人账户密码
 */
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

  // 更新为 bcrypt 加密后的新哈希值
  updateUserPassword(req.user!.userId, hashPassword(newPassword))
  audit(req, 'user.password_changed', 'user', { entityId: req.user!.userId })
  res.json({ ok: true })
})

// ── 知识库管理路由 ────────────────────────────────────

/**
 * 获取知识库列表
 * - 普通用户：仅返回其作为所有者或被授予成员权限的知识库
 * - 管理员：返回系统全部知识库
 * 每项附带文档数量、文件总大小等实时统计
 */
app.get('/api/kbs', requireAuth, (req: AuthRequest, res) => {
  const kbs = req.user!.role === 'admin'
    ? getAllKbs()
    : listKbsForUser(req.user!.userId)
  res.json(kbs.map(kb => ({ ...publicKb(kb, req.user), ...getKbStats(kb.id) })))
})

/**
 * 创建新知识库
 * 自动在 STORAGE_PATH 下为该知识库分配独立物理隔离目录 (`kb_{id}`)
 */
app.post('/api/kbs', requireAuth, (req: AuthRequest, res) => {
  const { name, description } = req.body as { name: string; description?: string }
  if (!name?.trim()) { res.status(400).json({ error: '知识库名称不能为空' }); return }

  // 先以空占位路径插入记录获取自增 ID，再更新为规范化的物理隔离目录路径
  const kb = createKb({ name: name.trim(), description, storagePath: '', ownerId: req.user!.userId })
  const realPath = path.join(STORAGE_PATH, `kb_${kb.id}`)
  fs.mkdirSync(realPath, { recursive: true })
  updateKbStoragePath(kb.id, realPath)
  audit(req, 'kb.create', 'kb', { entityId: kb.id, kbId: kb.id, detail: { name: name.trim() } })

  res.status(201).json({ ...kb, storage_path: realPath })
})

/**
 * 获取单个指定知识库的详情
 */
app.get('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限访问该知识库' }); return
  }
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  res.json(publicKb(kb, req.user))
})

/**
 * 删除知识库
 * 仅知识库所有者 (Owner) 或超级管理员 (Admin) 有权操作
 * 级联删除磁盘上对应的 `kb_{id}` 存储目录以及数据库中的文档、索引和切片记录
 */
app.delete('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限删除' }); return
  }

  // 递归物理删除该知识库的文件存储目录
  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  if (fs.existsSync(kbDir)) {
    fs.rmSync(kbDir, { recursive: true, force: true })
  }
  deleteKb(kbId)
  audit(req, 'kb.delete', 'kb', { entityId: kbId, kbId, detail: { name: kb.name } })
  res.json({ ok: true })
})

/**
 * 更新知识库基本信息（名称、描述、知识库定制专属 System Prompt）
 */
app.patch('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限修改' }); return
  }
  const { name, description, system_prompt } = req.body as { name?: string; description?: string; system_prompt?: string }
  if (!name?.trim()) { res.status(400).json({ error: '名称不能为空' }); return }
  updateKbMeta(kbId, name.trim(), description?.trim() ?? null)
  if (system_prompt !== undefined) updateKbSystemPrompt(kbId, system_prompt?.trim() || null)
  audit(req, 'kb.update', 'kb', { entityId: kbId, kbId, detail: { name: name.trim() } })
  res.json({ ok: true })
})

/**
 * 切换知识库公开 (Public) 属性
 * 公开知识库对系统内所有登录用户只读可见
 */
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

/**
 * 配置或清除知识库的外部本地源目录同步路径
 * 严格执行安全校验：路径必须存在为目录，且绝对不能包含或位于 STORAGE_PATH 内，防自递归死循环
 */
app.patch('/api/kbs/:id/sync-source', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = requireKbOwnerOrAdmin(req, res, kbId)
  if (!kb) return

  const rawPath = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
  // 传空表示清空同步源
  if (!rawPath) {
    updateKbSyncSource(kbId, null)
    updateKbSyncResult(kbId, '同步目录已清空')
    audit(req, 'kb.sync_source_clear', 'kb', { entityId: kbId, kbId })
    res.json({ ok: true, sync_source_path: null })
    return
  }

  // 规范化路径并进行目录与越界安全检测
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

/**
 * 手动触发知识库与已绑定的外部本地目录执行一次增量同步
 */
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

  // 启动同步流水线并将汇总摘要持久化至数据库
  const summary = syncKnowledgeBase(kb, sourcePath)
  updateKbSyncResult(kbId, JSON.stringify(summary))
  audit(req, 'kb.sync_run', 'kb', {
    entityId: kbId,
    kbId,
    detail: { ...summary, errors: summary.errors.slice(0, 5) },
  })
  res.json(summary)
})

// ── 知识库成员协同权限路由 ────────────────────────────

/**
 * 获取知识库的协作者成员列表（仅所有者或管理员可见）
 */
app.get('/api/kbs/:id/members', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  res.json(listKbMembers(kbId))
})

/**
 * 为知识库添加协作者成员
 */
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

/**
 * 从知识库中移除协作者成员
 */
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

// ── 知识库文档管理路由 ────────────────────────────────

/**
 * 获取指定知识库下的文档列表
 * - 支持通过 query 参数 limit 和 offset 实现分页
 * - 未传 limit 时返回全量文档数组（兼容前端聊天界面的文档快速映射）
 * - 结合 publicDoc 函数过滤内部存储物理路径等敏感字段
 */
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
  const items  = limit != null
    ? listDocsWithCounts(kbId, limit, offset ?? 0).map(doc => publicDoc(doc, kb, req.user))
    : listDocs(kbId).map(doc => publicDoc(doc, kb, req.user))
  if (limit != null) {
    res.json({ items, total, hasMore: (offset ?? 0) + items.length < total })
  } else {
    res.json(items)   // 不传 limit 时保持扁平数组，兼容前端 chat.js 的 kbDocMap 高速字典
  }
})

/**
 * 批量上传本地文件到知识库
 * - 最多一次性接收 20 个附件
 * - 针对 Windows 平台修复 multer 接收非 ASCII (如中文) 文件名时的 Latin-1 乱码问题
 * - 插入文档记录后异步推入后台索引任务队列 (docIndexQueue)
 */
app.post('/api/kbs/:id/docs', requireAuth, upload.array('files', 20), async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const files = req.files as Express.Multer.File[] | undefined
  if (!files?.length) { res.status(400).json({ error: '未接收到文件' }); return }

  const docs = files.map(f => {
    // multer 在 Windows / Node 环境下默认按 Latin-1 解码 header，导致中文乱码，将其重转回 UTF-8
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

/**
 * 直接在知识库中在线创建 Markdown 格式文本文档（如在线笔记、规章制度）
 */
app.post('/api/kbs/:id/docs/text', requireAuth, async (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }

  const { title, content } = req.body as { title?: string; content?: string }
  if (!content?.trim()) { res.status(400).json({ error: '内容不能为空' }); return }

  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }

  // 净化用户自定义标题，过滤非法文件系统特殊字符
  const safeName = (title?.trim() || '未命名笔记')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 80)
  const timestamp  = Date.now()
  const filename   = `${timestamp}_${Math.random().toString(36).slice(2,8)}.md`
  const origName   = safeName.endsWith('.md') ? safeName : `${safeName}.md`
  const filePath   = path.join(kb.storage_path, filename)

  // 写入物理文件并存入文档数据库
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

/**
 * 在线编辑修改现有的文本文档内容与标题
 * 仅允许修改 sourceType 为 `'text'` 的文本笔记
 */
app.patch('/api/kbs/:id/docs/:docId/text', requireAuth, async (req: AuthRequest, res) => {
  const kbId  = Number(req.params.id)
  const docId = Number(req.params.docId)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const doc = getDocById(docId)
  if (!doc || doc.kb_id !== kbId) { res.status(404).json({ error: '文档不存在' }); return }
  if (doc.source_type !== 'text') { res.status(400).json({ error: '只能编辑文本文档' }); return }

  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }

  const { title, content } = req.body as { title?: string; content?: string }
  if (!content?.trim()) { res.status(400).json({ error: '内容不能为空' }); return }

  const kbDir    = kb.storage_path || path.join(STORAGE_PATH, `kb_${kb.id}`)
  const filePath = path.join(kbDir, doc.filename)

  let origName = doc.original_name
  if (title?.trim()) {
    const safeName = title.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
    origName = safeName.endsWith('.md') ? safeName : `${safeName}.md`
  }

  fs.writeFileSync(filePath, content, 'utf-8')
  const size = Buffer.byteLength(content, 'utf-8')
  updateDocMeta(docId, origName, size)
  updateDocIndexStatus(docId, 'processing')

  // 重新同步 FTS5 全文索引
  try {
    indexDocContent(docId, kbId, origName, filePath, content)
  } catch (e) {
    updateDocIndexStatus(docId, 'error', (e as Error).message.slice(0, 500))
    console.warn('[FTS5] 索引失败:', (e as Error).message)
  }

  audit(req, 'doc.update_text', 'doc', { entityId: docId, kbId, detail: { title: origName, size } })
  res.json({ ok: true })
})

/** 预览文本内容的最大字符数上限（防止加载超大文件造成前端卡顿与内存溢出） */
const PREVIEW_MAX_CHARS = 10_000

/** 支持在线文本预览的扩展名集合 */
const TEXT_PREVIEWABLE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.ts', '.js', '.py', '.java', '.go',
  '.rs', '.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.xml', '.sh',
])

/**
 * 在线文档内容快速预览接口
 * - 针对纯文本文件直接读取磁盘内容
 * - 针对 Office / PDF 文档，读取预提取缓存在同目录下的 `.txt` 纯文本版本
 * - 限制单次读取最多不超过 10,000 字符，并在超出时返回截断提示
 */
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

  // 若为 Office 或 PDF 格式，则重定向至预生成的 .txt 提取文本路径
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

  // 流式分段读取指定上限字节，避免一次性全部载入内存
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

/**
 * 基于切片向量余弦相似度推荐与当前文档最相关的内容集合
 */
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

/**
 * 批量删除指定 ID 列表的文档
 */
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

/**
 * 单个文档删除（物理清理原始文件、txt 派生文件、FTS 索引和切片向量）
 */
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

// ── 知识库统计指标路由 ────────────────────────────────

/**
 * 获取知识库的全面统计信息
 * 包含总文档数、文件总大小、总代码/文本物理行数、各扩展名文件分布比例以及向量模型覆盖情况
 */
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

  // 格式化为美观可读的纯文本摘要（保持与 KBStatsTool Agent 内部工具输出一致）
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

// ── 对话会话与历史消息路由 ────────────────────────────

/**
 * 将运行时对象格式的问答消息转换为数据库持久化存储格式
 *
 * @param msg 内存消息对象
 * @param seq 该消息在所属对话中的严格递增物理序号
 */
function serializeMessage(msg: Record<string, unknown>, seq: number) {
  return {
    role:         msg.role as string,
    content:      typeof msg.content === 'string' ? msg.content : (msg.content as string | null) ?? null,
    tool_calls:   ('tool_calls' in msg && msg.tool_calls) ? JSON.stringify(msg.tool_calls) : null,
    tool_call_id: ('tool_call_id' in msg) ? (msg.tool_call_id as string | null) ?? null : null,
    seq,
  }
}

/**
 * 将数据库存储的 MessageRow 记录还原反序列化为模型调用的消息对象
 *
 * @param row 数据库消息行
 */
function deserializeMessage(row: MessageRow): Record<string, unknown> {
  const base: Record<string, unknown> = { role: row.role, content: row.content ?? null }
  if (row.tool_calls)   base.tool_calls   = JSON.parse(row.tool_calls)
  if (row.tool_call_id) base.tool_call_id = row.tool_call_id
  return base
}

/**
 * 分页拉取当前用户在指定知识库下的历史会话列表（置顶优先，其次按最近更新时间倒序）
 */
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

/**
 * 为当前用户在指定知识库下主动新建一个空白会话
 */
app.post('/api/kbs/:id/conversations', requireAuth, (req: AuthRequest, res) => {
  const kbId = Number(req.params.id)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const conv = createConversation(req.user!.userId, kbId)
  res.status(201).json(conv)
})

/**
 * 获取指定会话的详情元数据
 */
app.get('/api/conversations/:convId', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  res.json(conv)
})

/**
 * 获取指定会话下的全部历史消息记录（按时间次序正序排列）
 */
app.get('/api/conversations/:convId/messages', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  const rows = listMessages(conv.id)
  res.json(rows.map(deserializeMessage))
})

/**
 * 批量删除指定会话及其所有的历史消息记录
 */
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

/**
 * 单个删除会话及历史消息
 */
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

/**
 * 修改会话标题名称
 */
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

/**
 * 切换会话的置顶 (Pin) 状态
 */
app.patch('/api/conversations/:convId/pin', requireAuth, (req: AuthRequest, res) => {
  const conv = getConversationById(Number(req.params.convId))
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return
  }
  pinConversation(conv.id, Boolean(req.body?.pinned))
  res.json({ ok: true })
})

// ── 智能问答与检索增强生成 (RAG) 路由 ────────────────

/**
 * 从用户首轮提问中自动提取并清洗出对话标题
 * 规则：过滤 Markdown 代码块标记、标题符 (#)、列表符 (- * >) 等，提取第一行有效文本截断至 30 字符
 *
 * @param question 用户提问文本
 * @returns 净化后的会话标题
 */
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

/**
 * 知识库单库智能交互问答接口（基于 Server-Sent Events / SSE 协议流式输出）
 * 核心流程：
 * 1. 验证知识库访问权限与会话有效性（未传 conversationId 时自动创建新会话）
 * 2. 构造可信历史消息上下文 (buildTrustedHistory)，执行防 Prompt 注入过滤与预算窗口截断
 * 3. 建立 SSE 响应通道并启动 15 秒心跳保活定时器，防止云原生/企业网关断连
 * 4. 监听客户端 TCP 断开事件，联动 AbortController 中止 LLM 后续推理，节约算力
 * 5. 实例化 LLMExecutor 并执行 ReAct 智能循环推理（检索、阅读、调用工具）
 * 6. 执行完成事件处理：写入数据库持久化新消息、首轮对话自动命名、自动提取引用来源、推送 done 事件
 */
app.post('/api/kbs/:id/ask', requireAuth, qaRateLimit, async (req: AuthRequest, res) => {
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

  // 1. 确定或新建当前会话
  let conv
  if (convIdParam) {
    conv = getConversationById(Number(convIdParam))
    if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
    if (conv.user_id !== req.user!.userId) { res.status(403).json({ error: '无权限' }); return }
    if (conv.kb_id !== kbId) { res.status(400).json({ error: '对话不属于当前知识库' }); return }
  } else {
    conv = createConversation(req.user!.userId, kb.id)
  }

  // 2. 统计既有消息条数并构建经过安全防御清洗与窗口截断的上下文
  const prevCount = countMessages(conv.id)
  const trustedHistory = buildTrustedHistory(
    listMessages(conv.id),
    HISTORY_MAX_MESSAGES,
    HISTORY_MAX_CHARS,
  )

  // 3. 设置标准 SSE 流式响应协议标头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 禁用 Nginx 等反向代理的缓冲区
  res.flushHeaders()

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  // 每 15 秒发送 SSE 注释行保活，防止企业防火墙/网关因空闲超时强制关闭 TCP
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) }
  }, 15_000)

  // 客户端主动断开连接（如刷新或关闭页面）时，中止 LLM 执行器，防止无意义的后台算力空耗
  const abortCtrl = new AbortController()
  res.on('close', () => {
    abortCtrl.abort()
    clearInterval(keepalive)
  })

  const kbPath = path.join(STORAGE_PATH, `kb_${kb.id}`)

  // 4. 创建大语言模型 ReAct 推理执行器
  const executor = new LLMExecutor({
    baseUrl:      LLM_BASE_URL,
    apiKey:       LLM_API_KEY,
    model:        currentModel,
    kbPath,
    systemPrompt: buildSystemPrompt(kb.name, kbPath, kb.system_prompt),
    maxTurns:     MAX_TURNS,
    onEvent:      (e: QAEvent) => {
      if (!abortCtrl.signal.aborted) send(e)
    },
  })

  try {
    // 5. 启动 ReAct 工具调用问答循环
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executor.run(question, ALL_TOOLS, trustedHistory.messages as any, abortCtrl.signal)

    // 客户端若未断开，则持久化本轮产生的增量对话交互消息
    if (!abortCtrl.signal.aborted) {
      const newMsgs = (result.messages as unknown as Record<string, unknown>[]).slice(trustedHistory.messages.length)
      insertMessages(conv.id, newMsgs.map((m, i) => serializeMessage(m, prevCount + i)))
      touchConversation(conv.id)

      // 首轮对话：基于首个问题自动提炼标题
      if (prevCount === 0) {
        updateConversationTitle(conv.id, generateTitle(question))
      }

      // 6. 发送 done 结束事件，并包含提取的引用源定位与上下文使用统计
      send({
        type: 'done',
        turns: result.turns,
        messages: newMsgs,
        conversationId: conv.id,
        sources: extractSources(kbId, newMsgs as Record<string, unknown>[]),
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

/**
 * 跨知识库联合全局问答接口（一次性问答，无持久化对话历史）
 * 聚合当前用户有权限的所有知识库，执行预检索与全局分析
 */
app.post('/api/ask', requireAuth, qaRateLimit, async (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { question } = req.body as { question: string }
  if (!question?.trim()) { res.status(400).json({ error: '问题不能为空' }); return }

  const allKbs = listKbsForUser(userId)
  if (!allKbs.length) { res.status(400).json({ error: '没有可访问的知识库' }); return }

  // 并行检索各知识库中最相关的 5 条切片内容
  const RESULTS_PER_KB = 5
  const allResults = (await Promise.all(
    allKbs.map(kb => {
      try { return searchDocContent(kb.id, question, RESULTS_PER_KB) }
      catch { return [] }
    })
  )).flat()

  const kbPaths = allKbs.map(kb => `· ${kb.name}: ${kb.storage_path || path.join(STORAGE_PATH, `kb_${kb.id}`)}`).join('\n')
  const systemPrompt = `你是企业全局知识库的问答助手，可访问以下知识库：\n${kbPaths}\n\n回答时必须标注来源文件和行号。知识库中无相关内容时，明确说明"知识库中未找到相关内容"，不要猜测。`

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) } }, 15_000)
  const abortCtrl = new AbortController()
  res.on('close', () => { abortCtrl.abort(); clearInterval(keepalive) })

  const executor = new LLMExecutor({
    baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: currentModel,
    kbPath: STORAGE_PATH, systemPrompt, maxTurns: MAX_TURNS,
    onEvent: (e: QAEvent) => { if (!abortCtrl.signal.aborted) send(e) },
  })

  try {
    // 注入跨库检索前置结果
    const prefillContext = allResults.length
      ? `[跨库检索结果]\n${allResults.slice(0, 15).map(r => `[${r.original_name}:${r.chunk_line}] ${r.snippet}`).join('\n\n')}\n\n---\n`
      : ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executor.run(prefillContext + question, ALL_TOOLS, [] as any, abortCtrl.signal)
    if (!abortCtrl.signal.aborted) {
      send({ type: 'done', turns: result.turns, messages: result.messages, conversationId: null, context: { truncated: false } })
    }
  } catch (err) {
    if (!abortCtrl.signal.aborted) send({ type: 'error', message: (err as Error).message })
  } finally {
    clearInterval(keepalive)
    res.end()
  }
})

// ── 回答质量用户反馈路由 ──────────────────────────────

/**
 * 记录用户对问答结果的评分与原因反馈（好评 1，差评 -1）
 * 差评原因支持：文档缺失 (doc_missing)、回答错误 (wrong_answer)、未找到 (not_found)、其它 (other)
 */
app.post('/api/conversations/:id/feedback', requireAuth, (req: AuthRequest, res) => {
  const convId = Number(req.params.id)
  const conv = getConversationById(convId)
  if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
  if (conv.user_id !== req.user!.userId) { res.status(403).json({ error: '无权限' }); return }
  const { rating, reason, comment } = req.body as { rating: 1 | -1; reason?: string; comment?: string }
  if (rating !== 1 && rating !== -1) { res.status(400).json({ error: 'rating 必须为 1 或 -1' }); return }
  const validReasons = new Set(['doc_missing', 'wrong_answer', 'not_found', 'other'])
  const safeReason = reason && validReasons.has(reason) ? reason : null
  upsertFeedback(convId, req.user!.userId, rating, safeReason, comment)
  res.json({ ok: true })
})

// ── 知识库与会话全文搜索路由 ──────────────────────────

/**
 * 文档全文内容搜索接口（基于 SQLite FTS5 引擎）
 */
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

/**
 * 手动触发知识库全量重新索引（顺序重新解析文件文本、更新 FTS5 与向量切片）
 */
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

/**
 * 跨会话搜索接口（检索当前用户所有历史对话的标题与问答内容）
 */
app.get('/api/search/conversations', requireAuth, (req: AuthRequest, res) => {
  const q      = String(req.query.q ?? '').trim()
  const limit  = Math.min(Number(req.query.limit)  || 20, 50)
  const offset = Number(req.query.offset) || 0
  if (q.length < 2) { res.json({ items: [], total: 0 }); return }
  const result = searchConversations(req.user!.userId, q, limit, offset)
  res.json(result)
})

// ── 超级管理员专有管理路由 ────────────────────────────

/**
 * 分页与多维度查询系统审计日志 (Audit Events)
 * 支持按操作动作 action、操作者 username、关联知识库 kbId 等联合筛选
 */
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

/**
 * 获取指定知识库的用户评价统计与负向反馈明细（包含差评原因与详细描述）
 */
app.get('/api/admin/kbs/:id/feedback', requireAdmin, (req, res) => {
  const kbId = Number(req.params.id)
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
  const limit  = Math.min(Number(req.query.limit)  || 20, 100)
  const offset = Number(req.query.offset) || 0
  const stats  = getFeedbackStats(kbId)
  const { items, total } = listNegativeFeedback(kbId, limit, offset)
  res.json({ stats, items, total, hasMore: offset + items.length < total })
})

/**
 * 查询系统中所有注册用户列表
 */
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json(listUsers())
})

/**
 * 管理员开通新用户账户并分配角色 (admin / user)
 */
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

/**
 * 管理员删除指定用户账户
 * 安全限制：绝对不允许管理员删除自身当前正在登录的账户
 */
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

/**
 * 管理员修改指定用户的角色权限 (admin 或 user)
 * 安全限制：禁止管理员修改自身的角色（防止意外造成系统无有效管理员）
 */
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

/**
 * 管理员强行重置任意用户的登录密码
 */
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

// ── 服务端与大模型网关配置路由 ─────────────────────────

/**
 * 检测上游 LLM 模型服务是否在线且可正常通信
 *
 * @returns 在线状态布尔值
 */
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

/**
 * 获取系统当前运行时配置状态（供前端 UI 加载状态栏和配置看板）
 */
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

/**
 * 向模型提供商或网关动态拉取当前可供选择的模型清单
 */
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

/**
 * 管理员在线动态热切换系统当前主推理模型（无需重启 Node 服务）
 */
app.patch('/api/config/model', requireAdmin, (req: AuthRequest, res) => {
  const model = (req.body?.model as string | undefined)?.trim()
  if (!model) { res.status(400).json({ error: '模型名不能为空' }); return }
  currentModel = model
  console.log(`模型已切换为：${currentModel}`)
  audit(req, 'config.model_update', 'config', { detail: { model: currentModel } })
  res.json({ ok: true, model: currentModel })
})

// ── MCP (Model Context Protocol) 传输与 API Key ────────

import crypto from 'node:crypto'
import bcryptLib from 'bcryptjs'

/**
 * 从请求的 Authorization 标头中解析并校验 MCP API Key
 * 校验流程：
 * 1. 验证 Bearer ekb_... 格式
 * 2. 提取前 8 字符作为前缀索引快速命中数据库候选 Key 集合
 * 3. 使用 bcrypt.compare 严格校验完整哈希
 * 4. 刷新该 Key 的最后活跃时间戳并组装返回 McpContext 鉴权上下文
 *
 * @param req Express 请求对象
 * @returns 验证通过的 MCP 上下文，失败返回 null
 */
async function resolveMcpContext(req: Request): Promise<McpContext | null> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const apiKey = header.slice(7).trim()
  if (!apiKey || !apiKey.startsWith('ekb_')) return null
  const prefix = apiKey.slice(0, 8)
  const candidates = getMcpApiKeysByPrefix(prefix)
  for (const k of candidates) {
    if (bcryptLib.compareSync(apiKey, k.key_hash)) {
      touchMcpApiKey(k.id)
      const user = getUserById(k.user_id)
      if (!user) return null
      return {
        userId:   user.id,
        username: user.username,
        role:     user.role,
        kbIds:    JSON.parse(k.kb_ids || '[]') as number[],
      }
    }
  }
  return null
}

/**
 * MCP HTTP/SSE 协议传输服务入口
 * 支持各类 MCP Client（如 Claude Desktop、Cursor 等）通过 HTTP 传输协议连接并调用知识库资源与工具
 */
app.all('/mcp', async (req, res) => {
  const ctx = await resolveMcpContext(req)
  if (!ctx) { res.status(401).json({ error: '需要有效的 MCP API Key (Authorization: Bearer ekb_...)' }); return }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const mcpServer = createMcpServer(ctx)
  await mcpServer.connect(transport)
  await transport.handleRequest(req, res, req.body)
  await mcpServer.close()
})

// ── MCP API Key 凭据管理 ──────────────────────────────

/**
 * 获取当前登录用户拥有的所有 MCP API Keys（脱敏展示，不包含秘钥哈希）
 */
app.get('/api/mcp/keys', requireAuth, (req: AuthRequest, res) => {
  const keys = listMcpApiKeys(req.user!.userId)
  res.json(keys)
})

/**
 * 为当前用户生成全新的 MCP API Key
 * 安全规范：
 * - 生成格式：ekb_ + 24 字节加密安全伪随机数 (hex)
 * - 数据库仅保存前 8 位前缀索引与 bcrypt(10) 哈希值
 * - 仅在本次接口响应时返回一次明文密钥，后续无法再被查看
 */
app.post('/api/mcp/keys', requireAuth, (req: AuthRequest, res) => {
  const label  = (req.body?.label as string | undefined)?.slice(0, 100) || '未命名'
  const kbIds  = Array.isArray(req.body?.kb_ids) ? (req.body.kb_ids as number[]).filter(Number.isInteger) : []

  // 生成带有 ekb_ 专属前缀的 48 字符加密安全伪随机 API Key
  const rawKey   = 'ekb_' + crypto.randomBytes(24).toString('hex')
  const keyHash  = bcryptLib.hashSync(rawKey, 10)
  const keyPrefix = rawKey.slice(0, 8)

  const created = createMcpApiKey({
    keyHash,
    keyPrefix,
    userId: req.user!.userId,
    kbIds,
    label,
  })

  audit(req, 'mcp_key.create', 'mcp_key', { entityId: created.id, detail: { label, kbIds } })

  // 严格仅在创建成功响应中返回明文 key（之后任何界面不再显示）
  res.status(201).json({ ...created, key: rawKey })
})

/**
 * 撤销并物理删除指定的 MCP API Key
 */
app.delete('/api/mcp/keys/:id', requireAuth, (req: AuthRequest, res) => {
  const id = Number(req.params.id)
  const deleted = deleteMcpApiKey(id, req.user!.userId)
  if (!deleted) { res.status(404).json({ error: '密钥不存在或无权删除' }); return }
  audit(req, 'mcp_key.delete', 'mcp_key', { entityId: id })
  res.json({ ok: true })
})

// ── 服务健康检测与启动流水线 ──────────────────────────

/**
 * 启动时探活上游大语言模型服务并输出状态控制台日志
 */
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

/**
 * 在后台异步补建存量历史文档的 FTS5 全文索引与缺失的向量切片（不阻塞服务启动监听）
 */
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
        // 未建立 FTS 索引：推入索引队列
        enqueueDocIndex({ docId: doc.id, kbId: kb.id, originalName: doc.original_name, filePath })
        queued++
      } else if (isEmbeddingEnabled() && getDocVectorCount(doc.id) === 0) {
        // FTS 已就绪但向量缺失 — 后台异步补生成切片向量
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

// ── 全局未捕获错误异常处理中间件 ──────────────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return
  // 文件上传超限错误处理
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    res.status(status).json({ error: err.message })
    return
  }
  // 请求 JSON 格式解析畸变错误拦截
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON request body.' })
    return
  }
  console.error('[http] unhandled error:', err)
  res.status(500).json({ error: 'Internal server error.' })
})

/**
 * 启动 Express HTTP 服务并监听指定网络端口
 */
export function startServer(): void {
  app.listen(PORT, async () => {
    console.log('\n企业知识库系统已启动')
    console.log(`地址：http://localhost:${PORT}`)
    console.log(`模型：${currentModel}  (${LLM_BASE_URL})`)
    console.log(`存储：${STORAGE_PATH}`)
    console.log(`管理员账户：${ADMIN_USER}\n`)
    const stuck = resetStuckDocuments()
    if (stuck > 0) console.log(`[索引] 重置 ${stuck} 个僵尸文档 (processing → pending)`)
    await checkLLM()
    reindexExistingDocs().catch(e => console.warn('[FTS5] 补建索引出错:', e.message))
  })
}

/**
 * 判断当前文件是否作为 Node.js 进程的直接主入口执行
 */
function isDirectRun(): boolean {
  const entryPoint = process.argv[1]
  return Boolean(entryPoint && path.resolve(entryPoint) === url.fileURLToPath(import.meta.url))
}

// 若为主模块直接启动，则执行监听
if (isDirectRun()) startServer()

