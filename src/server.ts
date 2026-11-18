/**
 * Express 主服务：所有 HTTP 路由、后台索引队列和启动流程都在这个文件里。
 * 启动：npx tsx src/server.ts（开发）或 node dist/server.js（生产）
 *
 * 文件结构（按出现顺序，可以按分节标题跳着读）：
 *   配置 / 初始化          读取环境变量，生产环境检查弱密钥，打开数据库
 *   文件类型与同步设置      上传和同步允许的扩展名、各种上限
 *   文件夹同步：路径校验与扫描
 *   权限与审计的辅助函数
 *   文件上传（multer）
 *   后台索引队列与 OCR 队列  上传后的解析、分块、建索引都在这里排队进行
 *   文件夹同步：执行同步
 *   Express 应用           安全响应头、CORS、静态文件、登录限速
 *   各类路由               认证、密钥、知识库、成员、文档、统计、对话、
 *                          问答（SSE）、反馈、搜索、MCP、管理员、备份、配置
 *   启动                   补建旧文档索引、开始监听端口、启动自动备份
 *
 * 数据访问都在 db.ts，大模型调用在 executor.ts，认证在 auth.ts。
 */

import './nodeVersion.js'
import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as url from 'node:url'

import { initDb, ensureAdmin, getAllKbs, 
         
         
         listDocs, 
         
         
         
         
         isDocIndexed, 
         getDocVectorCount, 
         
         getConfig } from './db.js'
import { isEmbeddingEnabled } from './embedding.js'
import { configureProxyFromEnv } from './proxy.js'
import { IS_PRODUCTION, PORT, LLM_BASE_URL, LLM_PROVIDER, STORAGE_PATH, DB_PATH, BACKUP_DIR, BACKUP_KEEP, BACKUP_INTERVAL_HOURS, ADMIN_USER, ADMIN_PASS, corsOrigins, TRUST_PROXY, validateRuntimeConfig, llm } from './config.js'
import { sweepExpired } from './rateLimit.js'
import { registerGapRoutes } from './routes/gaps.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerKbRoutes } from './routes/kbs.js'
import { registerDocRoutes } from './routes/docs.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerQaRoutes } from './routes/qa.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { kbExecutor } from './kbExecutor.js'
import { enqueueDocIndex, generateAndStoreEmbeddings } from './indexQueue.js'
import { registerConversationRoutes } from './routes/conversations.js'
import { registerConfigRoutes, checkLlmOnline } from './routes/config.js'
import { registerApiKeyRoutes } from './routes/apiKeys.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerBackupRoutes, backupScheduler } from './routes/backups.js'

// 测试需要从入口取到它们
export { sweepExpired, backupScheduler }

const activeProxy = configureProxyFromEnv()
if (activeProxy) console.log(`[proxy] 出站请求使用代理：${activeProxy}`)

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// ── 配置 ──────────────────────────────────────────────

// ── 初始化 ────────────────────────────────────────────

validateRuntimeConfig()
if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true })
initDb(DB_PATH)
ensureAdmin(ADMIN_USER, ADMIN_PASS)
llm.model = getConfig('model') ?? llm.model

// ── 文件类型与同步设置 ────────────────────────────────

// ── Express 应用 ───────────────────────────────────────────

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
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : IS_PRODUCTION ? { origin: false } : undefined))
app.use(express.json({ limit: '4mb' }))
app.use(express.static(path.join(__dirname, '../public')))
app.get('/favicon.ico', (_req, res) => res.status(204).end())

// 前端第三方库从本地 node_modules 提供，不依赖外网 CDN（内网 / 国内网络可用）。
// 只暴露白名单中的文件，不把整个 node_modules 挂成静态目录。
const NODE_MODULES_DIR = path.join(__dirname, '../node_modules')
const VENDOR_SCRIPTS: Record<string, string> = {
  'marked.min.js': 'marked/lib/marked.umd.js',
  'purify.min.js': 'dompurify/dist/purify.min.js',
}
for (const [name, rel] of Object.entries(VENDOR_SCRIPTS)) {
  app.get(`/vendor/${name}`, (_req, res) => res.sendFile(path.join(NODE_MODULES_DIR, rel)))
}
const INTER_DIR = path.join(NODE_MODULES_DIR, '@fontsource-variable/inter')
app.get('/vendor/inter/wght.css', (_req, res) => res.sendFile(path.join(INTER_DIR, 'wght.css')))
app.use('/vendor/inter/files', express.static(path.join(INTER_DIR, 'files'), { maxAge: '30d', immutable: true }))

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

app.get('/readyz', async (_req, res) => {
  res.json({ status: 'ok', llmOnline: await checkLlmOnline(), model: llm.model })
})

// 根路径重定向到登录页
app.get('/', (_req, res) => res.redirect('/login.html'))


// ── 认证路由 ──────────────────────────────────────────

registerAuthRoutes(app)
registerKbRoutes(app)
registerDocRoutes(app)
registerStatsRoutes(app)

registerConversationRoutes(app)
registerQaRoutes(app)
registerSearchRoutes(app)
registerMcpRoutes(app)

// ── 管理员路由 ────────────────────────────────────────

registerApiKeyRoutes(app)
registerAdminRoutes(app)
registerGapRoutes(app, { kbExecutor })
registerBackupRoutes(app)

registerConfigRoutes(app)

// ── LLM 健康检查 ───────────────────────────────────

async function checkLLM(): Promise<void> {
  try {
    const online = await checkLlmOnline()
    if (online) {
      console.log(`✓  ${LLM_PROVIDER} 模型服务在线，当前模型 "${llm.model}"`)
    } else {
      console.warn(`⚠  ${LLM_PROVIDER} 模型服务连接失败 (${LLM_BASE_URL})`)
    }
  } catch (err) {
    console.warn(`⚠  无法连接模型服务 (${LLM_BASE_URL})：${(err as Error).message}`)
  }
}

// ── 启动时补建历史文档 FTS5 索引（后台，不阻塞启动） ────────────

/**
 * 启动时扫一遍所有文档：没有索引的重新排队（重启前没处理完的、上次失败的、旧版本升级后
 * 需要重建的），已有索引但缺向量的补生成向量。磁盘上找不到文件的文档跳过。
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
    const messages: Partial<Record<multer.ErrorCode, string>> = {
      LIMIT_FILE_SIZE: '文件超过 50 MB，本次上传未保存',
      LIMIT_FILE_COUNT: '一次最多上传 20 个文件',
      LIMIT_UNEXPECTED_FILE: '一次最多上传 20 个文件',
    }
    res.status(status).json({ error: messages[err.code] ?? `上传失败：${err.message}` })
    return
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: '请求内容不是有效的 JSON。' })
    return
  }
  console.error('[http] 未处理的错误：', err)
  res.status(500).json({ error: '服务器内部错误，请稍后重试。' })
})

export function startServer(): void {
  app.listen(PORT, async () => {
  console.log('\n企业知识库系统已启动')
  console.log(`地址：http://localhost:${PORT}`)
  console.log(`模型：${llm.model}  (${LLM_BASE_URL})`)
  console.log(`存储：${STORAGE_PATH}`)
  console.log(`管理员账户：${ADMIN_USER}\n`)
  await checkLLM()
  reindexExistingDocs().catch(e => console.warn('[FTS5] 补建索引出错:', e.message))
  if (backupScheduler.enabled) {
    backupScheduler.start()
    console.log(`[backup] 自动备份已开启：每 ${BACKUP_INTERVAL_HOURS} 小时一次，保留最近 ${BACKUP_KEEP} 份（${BACKUP_DIR}）`)
  }
  })
}

/**
 * 直接运行这个文件时才启动服务器；被测试 import 时不监听端口，
 * 测试用导出的 app 配合 supertest 发请求。
 */
function isDirectRun(): boolean {
  const entryPoint = process.argv[1]
  return Boolean(entryPoint && path.resolve(entryPoint) === url.fileURLToPath(import.meta.url))
}

if (isDirectRun()) startServer()
