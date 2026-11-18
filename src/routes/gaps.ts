/**
 * 待补知识（没找到答案的问题）的路由：列表、标记处理状态、重新验证、聊天首页的「最近补充」。
 * 业务规则（怎么归并、怎么判定状态）在 knowledgeGaps.ts，这里只管权限、参数和数据库读写。
 */

import type { Express } from 'express'
import { requireAuth, requireAdmin } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { audit, canManageKb } from '../access.js'
import { qaRateLimit } from '../rateLimit.js'
import {
  getKbById, canUserAccessKb, listKbsForUser, listKnowledgeGapRows, NOT_FOUND_MARKER,
  listGapStatuses, setGapStatus, clearGapStatus, listGapChecks, saveGapCheck,
} from '../db.js'
import type { KnowledgeBase } from '../db.js'
import { groupKnowledgeGaps, applyGapStatuses, gapFingerprint, isAnswerable, recentlyAnswered } from '../knowledgeGaps.js'
import type { GapState } from '../knowledgeGaps.js'
import type { LLMExecutor } from '../executor.js'
import type { QAEvent } from '../tools.js'
import { ALL_TOOLS } from '../tools.js'

export interface GapRouteDeps {
  /** 单个知识库的问答执行器（模型、工具范围由服务入口配置，这里只负责调用） */
  kbExecutor: (kb: KnowledgeBase, onEvent: (e: QAEvent) => void) => LLMExecutor
}

const GAP_FILTERS = ['open', 'resolved', 'dismissed', 'all'] as const

/**
 * 知识缺口：近 N 天没找到答案的问题，按出现次数排序，附带处理状态。
 * 管理员看全部（含跨全部知识库的）；普通用户只看自己是所有者的知识库，看不到别人的知识库，也看不到跨库的。
 * 缺口里只有问题原文，不带提问者身份。
 * 返回 null 表示无权查看指定的知识库。
 */
function listGapsForUser(user: NonNullable<AuthRequest['user']>, query: { days?: unknown; kbId?: unknown; status?: unknown }) {
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365)
  const kbId = Number(query.kbId) || undefined
  const filter = (GAP_FILTERS as readonly unknown[]).includes(query.status) ? query.status as typeof GAP_FILTERS[number] : 'open'
  const since = Math.floor(Date.now() / 1000) - days * 86400

  let rows = listKnowledgeGapRows(since, kbId)
  if (user.role !== 'admin') {
    const owned = new Set(listKbsForUser(user.userId).filter(kb => kb.owner_id === user.userId).map(kb => kb.id))
    if (kbId && !owned.has(kbId)) return null
    rows = rows.filter(row => row.kb_id != null && owned.has(row.kb_id))
  }
  const all = applyGapStatuses(groupKnowledgeGaps(rows, Infinity), listGapStatuses(), listGapChecks())
  const items = all.filter(gap => filter === 'all' || gap.status === filter)
  // 各状态的数量一起返回，页面上切换筛选时不用再请求
  const counts = { open: 0, resolved: 0, dismissed: 0 }
  for (const gap of all) counts[gap.status]++
  // total 是这些缺口被问到的次数合计（和以前一致），不是缺口条数
  return { days, status: filter, total: items.reduce((n, gap) => n + gap.count, 0), counts, items: items.slice(0, 100) }
}

export function registerGapRoutes(app: Express, deps: GapRouteDeps): void {
  app.get('/api/gaps', requireAuth, (req: AuthRequest, res) => {
    const result = listGapsForUser(req.user!, req.query)
    if (!result) { res.status(403).json({ error: '只有知识库所有者可以查看待补知识' }); return }
    res.json(result)
  })

  /**
   * 聊天页的「最近补充」：最近补上了答案的问题。能访问这个知识库的人都能看到，所以只给问题原文和时间，
   * 不带谁问的、谁处理的；所有者标「已补上」时可以选择不公开。
   * 只看单个知识库，不做跨库汇总。
   */
  app.get('/api/kbs/:id/recent-answers', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    if (!getKbById(kbId)) { res.status(404).json({ error: '知识库不存在' }); return }
    const now = Math.floor(Date.now() / 1000)
    const rows = listKnowledgeGapRows(now - 90 * 86400, kbId)
    const gaps = applyGapStatuses(groupKnowledgeGaps(rows, Infinity), listGapStatuses(), listGapChecks())
    res.json({ items: recentlyAnswered(gaps, now) })
  })

  /**
   * 重新验证：补完文档后，把缺口的问题用真实模型重新问一遍，看现在能不能答上。
   * 和正常提问的区别：不建对话、不记缺口（验证失败不会让这个缺口的次数增加，也不会把"已补上"的缺口弹回待处理），
   * 只保存最近一次结果。要花模型费用，所以只在人点按钮时才跑，并受问答频率限制。
   * 必须指定知识库（跨全部知识库的缺口没法确定该问哪个库）；管理员或所有者可用；接口密钥不能用。
   */
  app.post('/api/gaps/verify', requireAuth, qaRateLimit, async (req: AuthRequest, res) => {
    const { kbId, question } = req.body as { kbId?: unknown; question?: unknown }
    if (typeof kbId !== 'number' || !Number.isInteger(kbId) || kbId <= 0) {
      res.status(400).json({ error: 'kbId 必须是知识库编号' }); return
    }
    if (typeof question !== 'string' || !gapFingerprint(question)) {
      res.status(400).json({ error: '问题不能为空' }); return
    }
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (!canManageKb(kb, req.user)) {
      res.status(403).json({ error: '只有知识库所有者或管理员可以验证待补知识' }); return
    }

    const abortCtrl = new AbortController()
    res.on('close', () => { if (!res.writableEnded) abortCtrl.abort() })
    try {
      const asked = question.trim().slice(0, 300)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await deps.kbExecutor(kb, () => {}).run(asked, ALL_TOOLS, [] as any, abortCtrl.signal)
      if (abortCtrl.signal.aborted) return
      const answer = result.response.trim()
      const answerable = isAnswerable(answer, NOT_FOUND_MARKER)
      saveGapCheck({
        kbId, fingerprint: gapFingerprint(asked), answerable, answer,
        userId: req.user!.userId, username: req.user!.username,
      })
      audit(req, 'gap.verify', 'kb', { entityId: kbId, kbId, detail: { question: asked.slice(0, 200), answerable } })
      res.json({ answerable, answer: answer.slice(0, 1000), checked_at: Math.floor(Date.now() / 1000) })
    } catch (err) {
      if (!abortCtrl.signal.aborted) res.status(502).json({ error: `验证失败：${(err as Error).message}` })
    }
  })

  /** 旧路径，管理员专用，行为与 /api/gaps 一致 */
  app.get('/api/admin/gaps', requireAdmin, (req: AuthRequest, res) => {
    res.json(listGapsForUser(req.user!, req.query))
  })

  /**
   * 标记缺口的处理状态：resolved 已补上、dismissed 不需要补、open 重新打开。
   * 管理员或知识库所有者可操作；跨全部知识库的缺口（kbId 为 null）只有管理员能处理。
   * 通过接口密钥调用会被 isApiKeyAllowed 拒绝（只允许 GET 和问答）。
   */
  app.put('/api/gaps/status', requireAuth, (req: AuthRequest, res) => {
    const { kbId, question, status, announce } = req.body as { kbId?: unknown; question?: unknown; status?: unknown; announce?: unknown }
    if (announce !== undefined && typeof announce !== 'boolean') {
      res.status(400).json({ error: 'announce 必须是 true 或 false' }); return
    }
    if (typeof question !== 'string' || !question.trim()) { res.status(400).json({ error: '问题不能为空' }); return }
    if (status !== 'open' && status !== 'resolved' && status !== 'dismissed') {
      res.status(400).json({ error: '状态只能是 open、resolved 或 dismissed' }); return
    }
    if (kbId !== null && (typeof kbId !== 'number' || !Number.isInteger(kbId) || kbId <= 0)) {
      res.status(400).json({ error: 'kbId 必须是知识库编号，或 null（跨全部知识库）' }); return
    }
    const user = req.user!
    if (kbId === null) {
      if (user.role !== 'admin') { res.status(403).json({ error: '只有管理员可以处理跨全部知识库的缺口' }); return }
    } else {
      const kb = getKbById(kbId)
      if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
      if (!canManageKb(kb, user)) { res.status(403).json({ error: '只有知识库所有者或管理员可以处理待补知识' }); return }
    }
    const fingerprint = gapFingerprint(question)
    if (!fingerprint) { res.status(400).json({ error: '问题不能为空' }); return }

    if (status === 'open') clearGapStatus(kbId, fingerprint)
    else setGapStatus({ kbId, fingerprint, status, announce: announce as boolean | undefined, userId: user.userId, username: user.username })
    audit(req, 'gap.status', 'kb', {
      entityId: kbId, kbId, detail: { question: question.trim().slice(0, 200), status: status as GapState, ...(announce === false ? { announce: false } : {}) },
    })
    res.json({ ok: true })
  })
}
