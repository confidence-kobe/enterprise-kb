/**
 * 认证层 — JWT + bcrypt
 */

import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import type { Request, Response, NextFunction } from 'express'
import { getApiKeyByHash, getUserById, touchApiKey } from './db.js'

const DEFAULT_JWT_SECRET = 'dev-secret-change-me'
const EXAMPLE_JWT_SECRET = 'change-this-to-a-random-secret-string-at-least-32-chars'

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction && (secret === DEFAULT_JWT_SECRET || secret === EXAMPLE_JWT_SECRET || secret.length < 32)) {
    throw new Error('生产环境必须把 JWT_SECRET 设置为至少 32 个字符的随机字符串。')
  }
  if (!isProduction && (secret === DEFAULT_JWT_SECRET || secret === EXAMPLE_JWT_SECRET)) {
    console.warn('[security] JWT_SECRET 仍是开发用的示例值，部署到生产环境前请更换。')
  }
  return secret
}

const JWT_SECRET   = resolveJwtSecret()
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN ?? '24h'

export interface JwtPayload {
  userId: number
  username: string
  role: 'admin' | 'user'
  /** 签发时的 token_version；与数据库不一致说明已改密/改角色，Token 作废 */
  tv?: number
}

// ── 登录 Token ─────────────────────────────────────────────

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as jwt.SignOptions)
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash)
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}

// ── 接口密钥 ──────────────────────────────────────────

/** 接口密钥统一以此开头，便于和登录 Token 区分，也便于密钥扫描工具识别 */
export const API_KEY_PREFIX = 'ekb_'

/**
 * 密钥用 SHA-256 哈希，而不是像密码那样用 bcrypt：密钥本身是 192 位随机数，不可能被暴力猜出，
 * 不需要故意算得很慢；而且每个请求都要校验一次，bcrypt 会拖慢每一次接口调用。
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** 生成新密钥：明文只返回给创建者一次，数据库只存哈希 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + randomBytes(24).toString('base64url')
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 6), hash: hashApiKey(key) }
}

/** 接口密钥只能查询和问答：允许 GET，以及下面几个只读性质的 POST */
const API_KEY_POST_ROUTES = [/^\/api\/kbs\/\d+\/ask$/, /^\/api\/ask$/, /^\/mcp$/]

/**
 * 密钥能调用哪些接口（白名单）。用白名单而不是黑名单：以后新增的写接口默认就不能用密钥调用，
 * 不会因为忘了加限制而被泄露的密钥修改数据。
 */
export function isApiKeyAllowed(method: string, rawPath: string): boolean {
  // Express 路由默认不区分大小写、允许结尾斜杠，这里先统一格式再判断
  const p = rawPath.toLowerCase().replace(/\/+$/, '')
  if (p.startsWith('/api/admin') || p.startsWith('/api/me/api-keys')) return false
  if (method === 'GET' || method === 'HEAD') return true
  return method === 'POST' && API_KEY_POST_ROUTES.some(r => r.test(p))
}

// ── Express 中间件 ────────────────────────────────────

export interface AuthRequest extends Request {
  user?: JwtPayload
  /** 通过接口密钥访问时存在 */
  apiKey?: { id: number; prefix: string }
}

/** 用 API 密钥认证：查哈希 → 检查过期 → 检查主人还在 → 检查接口在白名单里 → 以主人身份放行 */
function authenticateApiKey(req: AuthRequest, res: Response, next: NextFunction, key: string): void {
  const row = getApiKeyByHash(hashApiKey(key))
  if (!row || (row.expires_at != null && row.expires_at * 1000 <= Date.now())) {
    res.status(401).json({ error: 'API 密钥无效、已撤销或已过期' })
    return
  }
  const user = getUserById(row.user_id)
  if (!user) {
    res.status(401).json({ error: 'API 密钥无效、已撤销或已过期' })
    return
  }
  if (!isApiKeyAllowed(req.method, req.baseUrl + req.path)) {
    res.status(403).json({ error: 'API 密钥只能用于查询和问答，不能修改数据或访问管理功能' })
    return
  }
  touchApiKey(row.id)
  // 权限与密钥所有者一致，角色以数据库当前值为准
  req.user = { userId: user.id, username: user.username, role: user.role, tv: user.token_version }
  req.apiKey = { id: row.id, prefix: row.prefix }
  next()
}

/** 验证 JWT，注入 req.user */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录，请先获取 Token' })
    return
  }

  const credential = header.slice(7).trim()
  if (credential.startsWith(API_KEY_PREFIX)) {
    authenticateApiKey(req, res, next, credential)
    return
  }

  let payload: JwtPayload
  try {
    payload = verifyToken(credential)
  } catch {
    res.status(401).json({ error: 'Token 已过期或无效，请重新登录' })
    return
  }

  // 每次请求都以数据库为准：用户被删除、改密或改角色后，旧 Token 立即失效，角色取最新值
  const user = getUserById(payload.userId)
  if (!user || (user.token_version ?? 0) !== (payload.tv ?? 0)) {
    res.status(401).json({ error: '登录已失效，请重新登录' })
    return
  }
  req.user = { userId: user.id, username: user.username, role: user.role, tv: user.token_version }
  next()
}

/** 验证管理员身份 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.apiKey) {
      res.status(403).json({ error: 'API 密钥不能用于管理功能' })
      return
    }
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '需要管理员权限' })
      return
    }
    next()
  })
}
