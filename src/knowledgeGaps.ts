/**
 * 知识空白分析 — 把"AI 答不上来"的问题按知识库和问题归并，按出现次数排序
 */

import type { GapCheckRow, GapStatusRow, KnowledgeGapRow, KnowledgeGapSource } from './db.js'

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

/** 最近一次「重新验证」的结果 */
export interface GapCheck {
  answerable: boolean
  answer: string
  checked_at: number
  checked_by: string | null
}

export interface KnowledgeGapWithStatus extends KnowledgeGap {
  /** 没验证过为 null */
  check: GapCheck | null
  status: GapState
  /** 标记"已补上"之后又有人问到同一个问题：补的内容没解决问题，缺口自动回到待处理 */
  reopened: boolean
  /** 已补上时是否显示在聊天页的「最近补充」里；没处理过的缺口为 true（没有意义，仅为字段齐全） */
  announce: boolean
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
 * 把处理状态和最近一次验证结果贴到缺口上。
 * 已补上的缺口如果之后又有人问到（最近一次提问晚于处理时间），说明补得不对或不够，自动回到待处理并标上 reopened。
 * 不需要补的缺口保持不动，要重新处理必须手动重新打开。
 */
export function applyGapStatuses(
  gaps: KnowledgeGap[],
  statuses: GapStatusRow[],
  checks: GapCheckRow[] = [],
): KnowledgeGapWithStatus[] {
  const statusByKey = new Map(statuses.map(s => [`${s.kb_id}:${s.fingerprint}`, s]))
  const checkByKey = new Map(checks.map(c => [`${c.kb_id}:${c.fingerprint}`, c]))
  return gaps.map(gap => {
    const key = `${gap.kb_id ?? 0}:${gapFingerprint(gap.question)}`
    const check = checkByKey.get(key)
    const checked: GapCheck | null = check
      ? { answerable: check.answerable === 1, answer: check.answer, checked_at: check.checked_at, checked_by: check.username }
      : null
    const record = statusByKey.get(key)
    if (!record) return { ...gap, check: checked, status: 'open', reopened: false, announce: true, status_at: null, status_by: null }
    const reopened = record.status === 'resolved' && gap.last_at > record.updated_at
    return {
      ...gap,
      check: checked,
      status: reopened ? 'open' : record.status,
      reopened,
      announce: record.announce !== 0,
      status_at: record.updated_at,
      status_by: record.username,
    }
  })
}

/**
 * 验证时模型的回答算不算"答上了"：有内容，并且没说"未找到相关内容"。
 * 这只能判断模型有没有放弃，判断不了答得对不对——答得对不对看回答原文，或者跑 npm run eval:qa。
 */
export function isAnswerable(answer: string, notFoundMarker: string): boolean {
  const text = answer.trim()
  return text.length > 0 && !text.includes(notFoundMarker)
}

export interface RecentAnswer {
  question: string
  resolved_at: number
}

/**
 * 聊天页「最近补充」要显示哪些问题：最近 days 天内标为已补上、没有关掉公开、之后没人再问到的缺口。
 * 如果标完之后又验证过、结果是仍答不上，就先不显示——别告诉大家"有答案了"却让他们点进去还是没有。
 * 只给问题原文和时间，不带任何人的信息。
 */
export function recentlyAnswered(gaps: KnowledgeGapWithStatus[], nowSeconds: number, days = 30, limit = 5): RecentAnswer[] {
  const since = nowSeconds - days * 86400
  return gaps
    .filter(gap => gap.status === 'resolved' && gap.announce && gap.status_at != null && gap.status_at >= since)
    .filter(gap => !(gap.check && !gap.check.answerable && gap.check.checked_at >= gap.status_at!))
    .sort((a, b) => b.status_at! - a.status_at!)
    .slice(0, limit)
    .map(gap => ({ question: gap.question, resolved_at: gap.status_at! }))
}
