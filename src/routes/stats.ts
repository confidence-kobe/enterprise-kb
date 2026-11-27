/**
 * 知识库统计：文档情况、近期问答、满意度、待补知识数量（聊天页「知识库概况」用）。
 */

import type { Express } from 'express'
import * as path from 'node:path'
import { canManageKb } from '../access.js'
import { requireAuth } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { STATS_DAYS, STORAGE_PATH } from '../config.js'
import { canUserAccessKb, getDocVectorCount, getKbById, getKbHealth, listDocs, listGapStatuses, listKnowledgeGapRows } from '../db.js'
import { isEmbeddingEnabled } from '../embedding.js'
import { applyGapStatuses, groupKnowledgeGaps } from '../knowledgeGaps.js'
import { collectKbStats } from '../tools.js'

export function registerStatsRoutes(app: Express): void {
  // ── 统计路由 ──────────────────────────────────────────


  app.get('/api/kbs/:id/stats', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }

    const kb   = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '不存在' }); return }

    const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
    const fileStats = collectKbStats(kbDir)
    const docs = listDocs(kbId)

    // 格式化为可读文本（与 KBStatsTool 输出格式一致）
    const lines: string[] = [
      `📚 知识库：${kb.name}`,
      `─────────────────────────`,
      `文档总数：${docs.length}（已上传文件）`,
      `可索引文件：${fileStats.totalFiles}`,
      `总行数：${fileStats.totalLines.toLocaleString()}`,
      `总大小：${fileStats.totalSizeKB.toFixed(1)} KB`,
    ]

    if (Object.keys(fileStats.byExtension).length > 0) {
      lines.push(``, `按文件类型分布：`)
      const sorted = Object.entries(fileStats.byExtension).sort((a, b) => b[1].count - a[1].count)
      for (const [ext, info] of sorted) {
        lines.push(`  ${ext.padEnd(14)}${String(info.count).padStart(4)} 个文件  ${info.lines.toLocaleString()} 行`)
      }
    }

    const vectoredDocs = docs.filter(d => getDocVectorCount(d.id) > 0).length
    const since = Math.floor(Date.now() / 1000) - STATS_DAYS * 86400
    const health = getKbHealth(kbId, since)
    if (isEmbeddingEnabled()) {
      lines.push(``, `向量覆盖：${vectoredDocs}/${docs.length} 个文档已向量化`)
    }

    res.json({
      name: kb.name,
      stats: lines.join('\n'),
      totalDocs: docs.length,
      totalFiles: fileStats.totalFiles,
      totalLines: fileStats.totalLines,
      totalSizeKB: Math.round(fileStats.totalSizeKB),
      byExtension: fileStats.byExtension,
      vectoredDocs,
      embeddingEnabled: isEmbeddingEnabled(),
      days: STATS_DAYS,
      health: {
        ...health,
        // 只给数量：知识空白里是其他人的提问，公开知识库的读者不应看到原文
        gaps: applyGapStatuses(groupKnowledgeGaps(listKnowledgeGapRows(since, kbId), Infinity), listGapStatuses())
          .filter(gap => gap.status === 'open').length,
        canManage: canManageKb(kb, req.user),
      },
    })
  })
}
