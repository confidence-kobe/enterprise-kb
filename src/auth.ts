/**
 * 认证与权限控制模块 (Authentication & Authorization)
 *
 * 核心功能：
 * 1. 基于 JWT (JSON Web Token) 的无状态用户身份凭证签发与验证
 * 2. 基于 bcrypt 的用户密码单向哈希与比对（工作因子 10）
 * 3. 生产环境安全合规检查：强制校验 JWT 密钥强度，杜绝默认/弱密钥上线
 * 4. Express 身份认证中间件：`requireAuth`（登录校验）与 `requireAdmin`（管理员权限校验）
 */

import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import type { Request, Response, NextFunction } from 'express'
import { getUserById } from './db.js'

/** 开发环境使用的默认 JWT 密钥 */
const DEFAULT_JWT_SECRET = 'dev-secret-change-me'
/** 示例/模板中的 JWT 密钥，禁止在生产环境直接使用 */
const EXAMPLE_JWT_SECRET = 'change-this-to-a-random-secret-string-at-least-32-chars'

/**
 * 解析并校验 JWT 密钥
 *
 * 安全策略：
 * - 在生产环境 (NODE_ENV === 'production') 下，必须显式配置 JWT_SECRET；
 * - 密钥长度不得低于 32 字符，且不能使用开发默认值或模板示例值，否则抛出异常阻止服务启动；
 * - 在非生产环境使用默认密钥时输出安全告警。
 *
 * @returns 经过校验的 JWT 密钥字符串
 * @throws {Error} 生产环境下未配置或密钥强度不足时抛出错误
 */
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

/** 全局生效的 JWT 签名密钥 */
const JWT_SECRET   = resolveJwtSecret()
/** JWT Token 有效期，默认 24 小时 */
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN ?? '24h'

/**
 * JWT 荷载 (Payload) 结构定义
 */
export interface JwtPayload {
  /** 用户唯一标识 ID */
  userId: number
  /** 用户登录名 */
  username: string
  /** 用户角色：admin (系统管理员) 或 user (普通用户) */
  role: 'admin' | 'user'
}

// ── Token 签发与验证 ─────────────────────────────────────────────

/**
 * 签发 JWT 认证令牌
 *
 * @param payload 包含用户 ID、用户名和角色的数据荷载
 * @returns 签名后的 JWT Token 字符串
 */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as jwt.SignOptions)
}

/**
 * 验证并解析 JWT 认证令牌
 *
 * @param token 客户端传入的 JWT 字符串
 * @returns 解析出的用户身份信息荷载
 * @throws {jwt.JsonWebTokenError} Token 签名无效、损坏或伪造时抛出异常
 * @throws {jwt.TokenExpiredError} Token 已超过有效期时抛出异常
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload
}

/**
 * 校验明文密码是否与数据库中的哈希散列匹配
 *
 * @param plain 用户输入的明文密码
 * @param hash 数据库存储的 bcrypt 密码散列值
 * @returns 密码是否正确
 */
export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash)
}

/**
 * 对明文密码进行单向 bcrypt 加盐哈希
 *
 * @param plain 待哈希的明文密码
 * @returns 经过加盐哈希的密码字符串（salt round = 10）
 */
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}

// ── Express 认证中间件 ────────────────────────────────────

/**
 * 扩展后的 Express 请求对象，附带经认证解析的用户身份信息
 */
export interface AuthRequest extends Request {
  /** 认证成功后注入的当前登录用户信息 */
  user?: JwtPayload
}

/**
 * 登录认证中间件 (requireAuth)
 *
 * 检查 HTTP Authorization 请求头中的 Bearer Token：
 * 1. 缺失或格式不符合 "Bearer <token>" 时，返回 401 提示未登录
 * 2. 校验 Token 签名和有效性，成功后将 JwtPayload 注入 `req.user`
 * 3. Token 过期或非法时，返回 401 提示重新登录
 */
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

/**
 * 管理员权限检查中间件 (requireAdmin)
 *
 * 执行流程：
 * 1. 先调用 `requireAuth` 验证用户是否登录
 * 2. 校验 `req.user.role` 是否为 'admin'
 * 3. 若非管理员，返回 403 拒绝访问；若为管理员，放行进入后续处理器
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '需要管理员权限' })
      return
    }
    next()
  })
}
