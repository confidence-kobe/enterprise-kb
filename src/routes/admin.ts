/**
 * 管理员接口：回答反馈统计、审计日志、用户管理。全部需要 requireAdmin。
 * （知识缺口在 gaps.ts，接口密钥在 apiKeys.ts，备份在 backups.ts。）
 */

import type { Express } from 'express'
import { requireAdmin } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { audit } from '../access.js'
import {
  getAllFeedbackStats, getNegativeFeedbackReasons, listNegativeFeedback, FEEDBACK_REASONS,
  listAuditEvents, listUserActivity, listUsers, getUserByUsername, getUserById, createUser, deleteUser, updateUserPassword, updateUserRole,
} from '../db.js'
import { hashPassword } from '../auth.js'
import { STATS_DAYS } from '../config.js'

export function registerAdminRoutes(app: Express): void {
  app.get('/api/admin/feedback', requireAdmin, (_req, res) => {
    const items = getAllFeedbackStats()
    const total_positive = items.reduce((s, i) => s + i.positive, 0)
    const total_negative = items.reduce((s, i) => s + i.negative, 0)
    const total = total_positive + total_negative
    const satisfaction = total > 0 ? Math.round((total_positive / total) * 100) : null
    res.json({ items, total_positive, total_negative, satisfaction, reasons: getNegativeFeedbackReasons() })
  })

  app.get('/api/admin/feedback/negative', requireAdmin, (req, res) => {
    const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const reasonParam = String(req.query.reason ?? '').trim()
    let reason: (typeof FEEDBACK_REASONS)[number] | 'none' | undefined
    if (reasonParam === 'none') reason = 'none'
    else if (reasonParam) {
      if (!(FEEDBACK_REASONS as readonly string[]).includes(reasonParam)) {
        res.status(400).json({ error: '无效的差评原因' }); return
      }
      reason = reasonParam as (typeof FEEDBACK_REASONS)[number]
    }
    res.json(listNegativeFeedback({ limit, offset, reason }))
  })

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
    const activity = listUserActivity(Math.floor(Date.now() / 1000) - STATS_DAYS * 86400)
    res.json(listUsers().map(u => ({
      ...u,
      last_active_at: activity.get(u.id)?.last_active_at ?? null,
      questions_30d: activity.get(u.id)?.questions ?? 0,
    })))
  })

  app.post('/api/admin/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body as {
      username: string; password: string; role?: 'admin' | 'user'
    }
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      res.status(400).json({ error: '用户名和密码不能为空' }); return
    }
    if (password.length < 6) {
      res.status(400).json({ error: '密码至少 6 位' }); return
    }
    if (role != null && role !== 'admin' && role !== 'user') {
      res.status(400).json({ error: '角色值无效' }); return
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
    if (!target) { res.status(404).json({ error: '用户不存在' }); return }
    // 他名下的知识库转给执行删除的管理员，文档和对话都保留
    const transferredKbs = deleteUser(id, req.user!.userId)
    audit(req, 'admin.user_delete', 'user', {
      entityId: id,
      detail: { username: target.username, transferredKbs },
    })
    res.json({ ok: true, transferredKbs })
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

  app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    const id = Number(req.params.id)
    const { newPassword } = req.body as { newPassword: unknown }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      res.status(400).json({ error: '新密码至少 6 位' }); return
    }
    if (!getUserById(id)) { res.status(404).json({ error: '用户不存在' }); return }
    updateUserPassword(id, await hashPassword(newPassword))
    audit(req, 'admin.user_password_reset', 'user', { entityId: id })
    res.json({ ok: true })
  })
}
