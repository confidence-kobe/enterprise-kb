/**
 * 登录、查看当前用户、修改自己的密码。
 */

import type { Express } from 'express'
import { requireAuth, signToken, verifyPassword, verifyLogin, hashPassword } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { getUserByUsername, getUserById, updateUserPassword } from '../db.js'
import { audit } from '../access.js'
import { loginRateLimit } from '../rateLimit.js'

export function registerAuthRoutes(app: Express): void {
  app.post('/api/auth/login', loginRateLimit, async (req, res) => {
    const { username, password } = req.body as { username: unknown; password: unknown }
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: '用户名和密码不能为空' }); return
    }

    const user = getUserByUsername(username)
    if (!await verifyLogin(password, user?.password_hash) || !user) {
      audit(req, 'auth.login_failed', 'auth', {
        userId: user?.id ?? null,
        username: username || null,
        detail: { username },
      })
      res.status(401).json({ error: '用户名或密码错误' }); return
    }

    const token = signToken({ userId: user.id, username: user.username, role: user.role, tv: user.token_version })
    audit(req, 'auth.login', 'auth', { userId: user.id, username: user.username })
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
  })

  app.get('/api/me', requireAuth, (req: AuthRequest, res) => {
    res.json(req.user)
  })

  app.patch('/api/me/password', requireAuth, async (req: AuthRequest, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string; newPassword: string
    }
    if (!currentPassword || !newPassword || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: '请填写当前密码和新密码' }); return
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: '新密码至少 6 位' }); return
    }

    const user = getUserById(req.user!.userId)
    if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
      res.status(401).json({ error: '当前密码错误' }); return
    }

    updateUserPassword(req.user!.userId, await hashPassword(newPassword))
    audit(req, 'user.password_changed', 'user', { entityId: req.user!.userId })
    // 改密会使所有旧 Token 失效（含其他设备）；为当前会话签发新 Token
    const updated = getUserById(req.user!.userId)!
    const token = signToken({ userId: updated.id, username: updated.username, role: updated.role, tv: updated.token_version })
    res.json({ ok: true, token })
  })
}
