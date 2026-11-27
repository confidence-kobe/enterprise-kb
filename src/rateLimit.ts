/**
 * 限速：登录按"IP + 用户名"、问答按用户。计数放在内存里，单实例部署够用。
 */

import type { NextFunction, Request, Response } from 'express'
import type { AuthRequest } from './auth.js'
import { envValue, parsePositiveInt } from './env.js'

const LOGIN_WINDOW_MS = parsePositiveInt(envValue('LOGIN_RATE_WINDOW_MS'), 15 * 60 * 1000, 'LOGIN_RATE_WINDOW_MS')
const LOGIN_MAX_ATTEMPTS = parsePositiveInt(envValue('LOGIN_RATE_MAX'), 10, 'LOGIN_RATE_MAX')
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

/**
 * 登录限速：按"IP + 用户名"计数，时间窗口内超过次数返回 429。成功的登录也计数，规则简单、不易绕过。
 * 计数放在内存里：单实例部署够用，重启清零也可以接受；如果以后多实例部署，需要改成共享存储。
 */
export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
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
    res.status(429).json({ error: '登录尝试次数过多，请稍后再试。' })
    return
  }
  state.count++
  next()
}

const QA_WINDOW_MS  = parsePositiveInt(envValue('QA_RATE_WINDOW_MS'), 60_000, 'QA_RATE_WINDOW_MS')
const QA_MAX        = parsePositiveInt(envValue('QA_RATE_MAX'), 20, 'QA_RATE_MAX')
const qaAttempts    = new Map<number, { count: number; resetAt: number }>()

/** 按用户计数的问答次数限制（网页、接口和 MCP 共用同一份额度）；超限返回 false */
export function takeQaQuota(userId: number): boolean {
  const now = Date.now()
  const state = qaAttempts.get(userId)
  if (!state || state.resetAt <= now) {
    qaAttempts.set(userId, { count: 1, resetAt: now + QA_WINDOW_MS })
    return true
  }
  if (state.count >= QA_MAX) return false
  state.count++
  return true
}

/** 问答路由用的中间件版本；限制的是大模型调用费用，防止脚本或泄露的密钥刷接口 */
export function qaRateLimit(req: AuthRequest, res: Response, next: NextFunction): void {
  const userId = req.user?.userId
  if (userId && !takeQaQuota(userId)) {
    res.status(429).json({ error: '请求过于频繁，请稍后再试' }); return
  }
  next()
}

/** 删掉已过期的计数，否则每个新 IP + 用户名组合都会在内存里留一条，长期运行越积越多 */
export function sweepExpired(map: Map<unknown, { resetAt: number }>, now = Date.now()): void {
  for (const [key, state] of map) if (state.resetAt <= now) map.delete(key)
}
setInterval(() => { sweepExpired(loginAttempts); sweepExpired(qaAttempts) }, 60_000).unref()
