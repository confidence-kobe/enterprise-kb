/**
 * 知识空白分析 — 把"AI 答不上来"的问题按知识库和问题归并，按出现次数排序
 */

import type { GapStatusRow, KnowledgeGapRow, KnowledgeGapSource } from './db.js'

export interface KnowledgeGap {
  /** null 表示跨全部知识库（网页跨库提问、MCP 不指定知识库的检索） */
  kb_id: number | null
  kb_name: string | null
  /** 最近一次的原始提问 */
  question: string
  count: number
  last_at: number
  sources: Record<KnowledgeGapSource, number>
}

/** open = 待处理；resolved = 已补上；dismissed = 不需要补 */
export type GapState = 'open' | 'resolved' | 'dismissed'

export interface KnowledgeGapWithStatus extends KnowledgeGap {
  status: GapState
  /** 标记"已补上"之后又有人问到同一个问题：补的内容没解决问题，缺口自动回到待处理 */
  reopened: boolean
  status_at: number | null
  status_by: string | null
}

/** 归并用的问题指纹：忽略大小写、空白和标点 */
export function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 缺口的指纹：和归并时用的完全一致（先截断到 300 字再去标点），处理状态靠它对上号 */
export function gapFingerprint(question: string): string {
  return normalizeQuestion(question.trim().slice(0, 300))
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
        sources: { ai_not_found: 0, feedback_not_found: 0, search_empty: 0 } }
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

/**
 * 把处理状态贴到缺口上。
 * 已补上的缺口如果之后又有人问到（最近一次提问晚于处理时间），说明补得不对或不够，自动回到待处理并标上 reopened。
 * 不需要补的缺口保持不动，要重新处理必须手动重新打开。
 */
export function applyGapStatuses(gaps: KnowledgeGap[], statuses: GapStatusRow[]): KnowledgeGapWithStatus[] {
  const byKey = new Map(statuses.map(s => [`${s.kb_id}:${s.fingerprint}`, s]))
  return gaps.map(gap => {
    const record = byKey.get(`${gap.kb_id ?? 0}:${gapFingerprint(gap.question)}`)
    if (!record) return { ...gap, status: 'open', reopened: false, status_at: null, status_by: null }
    const reopened = record.status === 'resolved' && gap.last_at > record.updated_at
    return {
      ...gap,
      status: reopened ? 'open' : record.status,
      reopened,
      status_at: record.updated_at,
      status_by: record.username,
    }
  })
}
