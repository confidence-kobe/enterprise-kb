/**
 * 对话历史（列表、读取、重命名、置顶、删除）和对回答的评价（👍/👎）。
 * 对话只属于创建它的用户，管理员也能查看和删除。
 */

import type { Express } from 'express'
import { requireAuth } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import {
  canUserAccessKb, countConversations, listConversations, createConversation, getConversationById,
  listMessages, deleteConversation, updateConversationTitle, pinConversation, upsertFeedback, FEEDBACK_REASONS,
} from '../db.js'
import { audit } from '../access.js'
import { deserializeMessage } from '../messageCodec.js'

export function registerConversationRoutes(app: Express): void {
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
    audit(req, 'conversation.batch_delete', 'conversation', { detail: { requested: ids.length, deleted } })
    res.json({ deleted })
  })

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

  app.post('/api/conversations/:id/feedback', requireAuth, (req: AuthRequest, res) => {
    const convId = Number(req.params.id)
    const conv = getConversationById(convId)
    if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
    if (conv.user_id !== req.user!.userId) { res.status(403).json({ error: '无权限' }); return }
    const { rating, reason, comment } = req.body as { rating: 1 | -1; reason?: unknown; comment?: unknown }
    if (rating !== 1 && rating !== -1) { res.status(400).json({ error: 'rating 必须为 1 或 -1' }); return }
    if (reason != null && !(FEEDBACK_REASONS as readonly unknown[]).includes(reason)) {
      res.status(400).json({ error: '无效的差评原因' }); return
    }
    if (comment != null && (typeof comment !== 'string' || comment.length > 500)) {
      res.status(400).json({ error: '补充说明最多 500 字' }); return
    }
    upsertFeedback(convId, req.user!.userId, rating, {
      reason: reason as (typeof FEEDBACK_REASONS)[number] | undefined,
      comment: comment as string | undefined,
    })
    res.json({ ok: true })
  })
}
