/**
 * 知识空白分析 — 把"AI 答不上来"的问题按知识库和问题归并，按出现次数排序
 */

import type { KnowledgeGapRow } from './db.js'

export interface KnowledgeGap {
  kb_id: number
  kb_name: string
  /** 最近一次的原始提问 */
  question: string
  count: number
  last_at: number
  sources: { ai_not_found: number; feedback_not_found: number }
}

/** 归并用的问题指纹：忽略大小写、空白和标点 */
export function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function groupKnowledgeGaps(rows: KnowledgeGapRow[], limit = 100): KnowledgeGap[] {
  const groups = new Map<string, KnowledgeGap>()
  for (const row of rows) {
    const question = row.question.trim().slice(0, 300)
    const fingerprint = normalizeQuestion(question)
    if (!fingerprint) continue
    const key = `${row.kb_id}:${fingerprint}`
    let gap = groups.get(key)
    if (!gap) {
      gap = { kb_id: row.kb_id, kb_name: row.kb_name, question, count: 0, last_at: 0,
        sources: { ai_not_found: 0, feedback_not_found: 0 } }
      groups.set(key, gap)
    }
    gap.count++
    gap.sources[row.source]++
    if (row.created_at >= gap.last_at) {
      gap.last_at = row.created_at
      gap.question = question
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.last_at - a.last_at)
    .slice(0, limit)
}
