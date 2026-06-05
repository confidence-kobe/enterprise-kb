/**
 * 认证层 — JWT + bcrypt
 */

import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import type { Request, Response, NextFunction } from 'express'
import { getUserById } from './db.js'

const DEFAULT_JWT_SECRET = 'dev-secret-change-me'
const EXAMPLE_JWT_SECRET = 'change-this-to-a-random-secret-string-at-least-32-chars'

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction && (secret === DEFAULT_JWT_SECRET || secret === EXAMPLE_JWT_SECRET || secret.length < 32)) {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production.')
  }
  if (!isProduction && (secret === DEFAULT_JWT_SECRET || secret === EXAMPLE_JWT_SECRET)) {
    console.warn('[security] JWT_SECRET is using a development/example value. Replace it before production deployment.')
  }
  return secret
}

const JWT_SECRET   = resolveJwtSecret()
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN ?? '24h'

export interface JwtPayload {
  userId: number
  username: string
  role: 'admin' | 'user'
}

// ── Token ─────────────────────────────────────────────

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

// ── Express 中间件 ────────────────────────────────────

export interface AuthRequest extends Request {
  user?: JwtPayload
}

/** 验证 JWT，注入 req.user */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录，请先获取 Token' })
    return
  }

  try {
    const token = header.slice(7)
    req.user = verifyToken(token)
    next()
  } catch {
    res.status(401).json({ error: 'Token 已过期或无效，请重新登录' })
  }
}

/** 验证管理员身份 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '需要管理员权限' })
      return
    }
    next()
  })
}
