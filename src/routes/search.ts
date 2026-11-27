/**
 * 搜索：知识库内文档内容搜索、重建索引、对话搜索。
 */

import type { Express } from 'express'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { audit } from '../access.js'
import { requireAuth } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { STORAGE_PATH } from '../config.js'
import { canUserAccessKb, getKbById, isDocIndexed, listDocs, searchConversations, searchDocContent } from '../db.js'
import { processDocIndexJob } from '../indexQueue.js'

export function registerSearchRoutes(app: Express): void {
  // ── 搜索路由 ──────────────────────────────────────────

  /** 文档内容全文搜索（FTS5） */
  app.get('/api/kbs/:id/search/docs', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    const q     = String(req.query.q ?? '').trim()
    const limit = Math.min(Number(req.query.limit) || 10, 30)
    if (q.length < 1) { res.json([]); return }
    res.json(searchDocContent(kbId, q, limit))
  })

  /** 手动触发知识库 FTS5 重建索引 */
  app.post('/api/kbs/:id/reindex', requireAuth, async (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }

    const docs  = listDocs(kbId)
    const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
    let indexed = 0
    let failed  = 0

    for (const doc of docs) {
      const filePath = path.join(kbDir, doc.filename)
      if (!fs.existsSync(filePath)) continue
      const { ocr } = await processDocIndexJob({ docId: doc.id, kbId, originalName: doc.original_name, filePath })
      await ocr
      if (isDocIndexed(doc.id)) indexed++
      else failed++
    }

    audit(req, 'doc.reindex', 'doc', { kbId, detail: { indexed, failed, total: docs.length } })
    res.json({ indexed, failed, total: docs.length })
  })

  app.get('/api/search/conversations', requireAuth, (req: AuthRequest, res) => {
    const q      = String(req.query.q ?? '').trim()
    const limit  = Math.min(Number(req.query.limit)  || 20, 50)
    const offset = Number(req.query.offset) || 0
    if (q.length < 2) { res.json({ items: [], total: 0 }); return }
    const result = searchConversations(req.user!.userId, q, limit, offset)
    res.json(result)
  })
}
