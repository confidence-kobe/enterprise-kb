/**
 * 运行配置：从环境变量读取一次，其他模块直接引用，不要再各自读 process.env。
 * 唯一会变的是当前使用的模型（llm.model），管理员可以在页面上切换。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import * as url from 'node:url'
import { envValue, parsePositiveInt } from './env.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

export const NODE_ENV      = process.env.NODE_ENV ?? 'development'
export const IS_PRODUCTION = NODE_ENV === 'production'
const DEFAULT_ADMIN_PASSWORD  = 'Admin@123'
const EXAMPLE_ADMIN_PASSWORD  = 'change-this-admin-password'
const DEFAULT_JWT_SECRET      = 'dev-secret-change-me'
const EXAMPLE_JWT_SECRET      = 'change-this-to-a-random-secret-string-at-least-32-chars'

function isOllamaEndpoint(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1/.test(baseUrl) && baseUrl.includes('11434')
}

/** Ollama 的 OpenAI 兼容接口在 /v1 下，用户常常只填 http://localhost:11434，这里自动补上 */
function normalizeLlmBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  if (isOllamaEndpoint(trimmed) && !trimmed.endsWith('/v1')) return `${trimmed}/v1`
  return trimmed
}

export const PORT         = parsePositiveInt(envValue('PORT'), 8080, 'PORT')
export const LLM_BASE_URL = normalizeLlmBaseUrl(envValue('LLM_BASE_URL', 'OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1')
export const LLM_API_KEY  = envValue('LLM_API_KEY', 'OLLAMA_API_KEY') ?? 'ollama'
export const MAX_TURNS    = parsePositiveInt(envValue('LLM_MAX_TURNS', 'OLLAMA_MAX_TURNS'), 8, 'LLM_MAX_TURNS')
export const HISTORY_MAX_MESSAGES = parsePositiveInt(envValue('HISTORY_MAX_MESSAGES'), 40, 'HISTORY_MAX_MESSAGES')
export const HISTORY_MAX_CHARS    = parsePositiveInt(envValue('HISTORY_MAX_CHARS'), 40_000, 'HISTORY_MAX_CHARS')
export const OLLAMA_URL   = LLM_BASE_URL.replace(/\/v1\/?$/, '')
export const IS_OLLAMA    = isOllamaEndpoint(LLM_BASE_URL)
export const LLM_PROVIDER = (() => {
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
export const PROJECT_ROOT = path.join(__dirname, '..')
/** 相对路径按项目根目录解析，而不是按启动命令所在的目录，避免换个目录启动就找不到数据 */
function resolveFromProject(envVal: string | undefined, fallback: string): string {
  const val = envVal ?? fallback
  return path.isAbsolute(val) ? val : path.resolve(PROJECT_ROOT, val)
}
export const STORAGE_PATH = resolveFromProject(process.env.STORAGE_PATH, 'storage')
export const DB_PATH      = resolveFromProject(process.env.DB_PATH,      'data/enterprise-kb.db')
export const BACKUP_DIR   = resolveFromProject(envValue('BACKUP_DIR'), 'backups')
export const BACKUP_KEEP  = parsePositiveInt(envValue('BACKUP_KEEP'), 7, 'BACKUP_KEEP')
/** 自动备份间隔（小时），0 或不设置表示关闭 */
export const BACKUP_INTERVAL_HOURS = envValue('BACKUP_INTERVAL_HOURS') === '0'
  ? 0
  : parsePositiveInt(envValue('BACKUP_INTERVAL_HOURS'), 0, 'BACKUP_INTERVAL_HOURS')
export const APP_VERSION  = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')).version as string }
  catch { return 'unknown' }
})()
export const ADMIN_USER   = process.env.ADMIN_USERNAME   ?? 'admin'
export const ADMIN_PASS   = process.env.ADMIN_PASSWORD   ?? 'Admin@123'
export const CORS_ORIGIN  = envValue('CORS_ORIGIN')
/** 允许跨域访问的来源列表（CORS_ORIGIN，逗号分隔）；空表示不额外放开 */
export const corsOrigins = CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) ?? []
export const TRUST_PROXY  = /^(1|true|yes)$/i.test(envValue('TRUST_PROXY') ?? '')

/** 生产环境拒绝默认或示例密钥：这些值写在公开的代码和 .env.example 里，用了等于没设密码 */
export function validateRuntimeConfig(): void {
  const jwtSecret = process.env.JWT_SECRET
  if (IS_PRODUCTION) {
    if (!jwtSecret || jwtSecret === DEFAULT_JWT_SECRET || jwtSecret === EXAMPLE_JWT_SECRET || jwtSecret.length < 32) {
      throw new Error('生产环境必须把 JWT_SECRET 设置为至少 32 个字符的随机字符串。')
    }
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === EXAMPLE_ADMIN_PASSWORD) {
      throw new Error('部署到生产环境前必须修改 ADMIN_PASSWORD。')
    }
  }
}

/** 统计面板和用户列表里"近期"的天数 */
export const STATS_DAYS = 30

/** 大模型服务的连接信息。model 可以在运行中切换，所以放在对象里，大家读 llm.model 拿到的永远是最新的 */
export const llm = {
  baseUrl: LLM_BASE_URL,
  apiKey:  LLM_API_KEY,
  model:   envValue('LLM_MODEL', 'OLLAMA_MODEL') ?? 'qwen2.5:7b',
}
