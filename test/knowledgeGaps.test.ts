import { describe, expect, it } from 'vitest'
import { applyGapStatuses, gapFingerprint, groupKnowledgeGaps, isAnswerable, normalizeQuestion, recentlyAnswered } from '../src/knowledgeGaps.js'
import type { GapCheckRow, GapStatusRow, KnowledgeGapRow } from '../src/db.js'

const DAY = 86400
const row = (kb_id: number, question: string, created_at: number, source: KnowledgeGapRow['source'] = 'ai_not_found'): KnowledgeGapRow =>
  ({ kb_id, kb_name: `KB${kb_id}`, question, created_at, source })

describe('normalizeQuestion', () => {
  it('ignores case, whitespace and punctuation', () => {
    expect(normalizeQuestion('  年假 有几天？ ')).toBe(normalizeQuestion('年假有几天?'))
    expect(normalizeQuestion('VPN, how?')).toBe('vpnhow')
  })
})

describe('groupKnowledgeGaps', () => {
  it('merges repeats per knowledge base, counts sources and sorts by frequency', () => {
    const gaps = groupKnowledgeGaps([
      row(1, '年假有几天？', 100),
      row(1, '年假 有几天', 300, 'feedback_not_found'),
      row(1, '报销流程是什么', 200),
      row(2, '年假有几天？', 150),
    ])
    expect(gaps[0]).toMatchObject({
      kb_id: 1, count: 2, last_at: 300, question: '年假 有几天',
      sources: { ai_not_found: 1, feedback_not_found: 1, search_empty: 0 },
    })
    expect(gaps).toHaveLength(3)
    expect(gaps.filter(g => g.kb_id === 2)).toHaveLength(1)
  })

  it('skips empty questions and respects the limit', () => {
    expect(groupKnowledgeGaps([row(1, '  ？ ', 1)])).toEqual([])
    const many = Array.from({ length: 5 }, (_, i) => row(1, `问题${i}`, i))
    expect(groupKnowledgeGaps(many, 2)).toHaveLength(2)
  })
})

describe('applyGapStatuses', () => {
  const gaps = () => groupKnowledgeGaps([row(1, '年假有几天？', 100), row(null as unknown as number, '全局问题', 100)])
  const record = (kb_id: number, question: string, status: GapStatusRow['status'], updated_at: number): GapStatusRow =>
    ({ kb_id, fingerprint: gapFingerprint(question), status, announce: 1, username: 'alice', updated_at })

  it('没有处理记录的缺口是待处理', () => {
    expect(applyGapStatuses(gaps(), []).every(g => g.status === 'open' && !g.reopened && g.status_by === null)).toBe(true)
  })

  it('换个标点再问，仍对得上同一条处理记录；跨全部知识库的缺口用 kb_id 0', () => {
    const result = applyGapStatuses(gaps(), [record(1, '年假 有几天?', 'resolved', 200), record(0, '全局问题', 'dismissed', 200)])
    expect(result.find(g => g.kb_id === 1)).toMatchObject({ status: 'resolved', reopened: false, status_by: 'alice', status_at: 200 })
    expect(result.find(g => g.kb_id === null)).toMatchObject({ status: 'dismissed' })
  })

  it('已补上之后又有人问到：回到待处理并标记 reopened；同一时刻不算', () => {
    const later = applyGapStatuses(groupKnowledgeGaps([row(1, '年假有几天？', 100), row(1, '年假有几天', 300)]), [record(1, '年假有几天', 'resolved', 200)])
    expect(later[0]).toMatchObject({ status: 'open', reopened: true })
    const same = applyGapStatuses(groupKnowledgeGaps([row(1, '年假有几天？', 200)]), [record(1, '年假有几天', 'resolved', 200)])
    expect(same[0]).toMatchObject({ status: 'resolved', reopened: false })
  })

  it('标记为不需要补的，之后再被问到也保持不变', () => {
    const result = applyGapStatuses(groupKnowledgeGaps([row(1, '年假有几天？', 900)]), [record(1, '年假有几天', 'dismissed', 200)])
    expect(result[0]).toMatchObject({ status: 'dismissed', reopened: false })
  })

  it('不同知识库里的同一个问题互不影响', () => {
    const result = applyGapStatuses(groupKnowledgeGaps([row(1, '年假有几天', 100), row(2, '年假有几天', 100)]), [record(1, '年假有几天', 'resolved', 200)])
    expect(result.find(g => g.kb_id === 1)?.status).toBe('resolved')
    expect(result.find(g => g.kb_id === 2)?.status).toBe('open')
  })
})

describe('验证结果', () => {
  const check = (kb_id: number, question: string, answerable: number): GapCheckRow =>
    ({ kb_id, fingerprint: gapFingerprint(question), answerable, answer: '年假 5 天', username: 'alice', checked_at: 500 })

  it('贴到对应的缺口上，没验证过的是 null', () => {
    const result = applyGapStatuses(
      groupKnowledgeGaps([row(1, '年假有几天？', 100), row(1, '报销流程', 100)]), [], [check(1, '年假有几天', 1)])
    expect(result.find(g => g.question === '年假有几天？')?.check)
      .toEqual({ answerable: true, answer: '年假 5 天', checked_at: 500, checked_by: 'alice' })
    expect(result.find(g => g.question === '报销流程')?.check).toBeNull()
  })

  it('不传验证结果也能用（旧调用方式）', () => {
    expect(applyGapStatuses(groupKnowledgeGaps([row(1, '年假', 100)]), [])[0].check).toBeNull()
  })

  it('isAnswerable：有内容且没说未找到才算答上', () => {
    expect(isAnswerable('年假每年 5 天，见 `请假制度.md:3`', '未找到相关内容')).toBe(true)
    expect(isAnswerable('抱歉，知识库中未找到相关内容。', '未找到相关内容')).toBe(false)
    expect(isAnswerable('  \n ', '未找到相关内容')).toBe(false)
  })
})

describe('recentlyAnswered（聊天页的「最近补充」）', () => {
  const NOW = 10_000_000
  const status = (question: string, over: Partial<GapStatusRow> = {}): GapStatusRow =>
    ({ kb_id: 1, fingerprint: gapFingerprint(question), status: 'resolved', announce: 1, username: 'alice', updated_at: NOW - DAY, ...over })
  const make = (questions: Array<[string, Partial<GapStatusRow>?]>, checks: GapCheckRow[] = [], lastAsked = NOW - 5 * DAY) =>
    applyGapStatuses(
      groupKnowledgeGaps(questions.map(([q]) => row(1, q, lastAsked))),
      questions.map(([q, over]) => status(q, over)),
      checks,
    )

  it('只给问题原文和时间，不带任何人的信息', () => {
    const items = recentlyAnswered(make([['年假怎么算']]), NOW)
    expect(items).toEqual([{ question: '年假怎么算', resolved_at: NOW - DAY }])
  })

  it('只显示已补上、公开、最近 30 天内的；按处理时间从新到旧，最多 5 条', () => {
    const gaps = make([
      ['问题一', { updated_at: NOW - 3 * DAY }],
      ['问题二', { updated_at: NOW - 1 * DAY }],
      ['已过期', { updated_at: NOW - 31 * DAY }],
      ['不需要补', { status: 'dismissed' }],
      ['不公开', { announce: 0 }],
      ['问题三', { updated_at: NOW - 2 * DAY }],
      ['问题四', { updated_at: NOW - 4 * DAY }],
      ['问题五', { updated_at: NOW - 5 * DAY }],
      ['问题六', { updated_at: NOW - 6 * DAY }],
    ])
    expect(recentlyAnswered(gaps, NOW).map(i => i.question)).toEqual(['问题二', '问题三', '问题一', '问题四', '问题五'])
  })

  it('补上之后又有人问到的不显示（已回到待处理）', () => {
    const gaps = make([['年假怎么算', { updated_at: NOW - 3 * DAY }]], [], NOW - DAY)
    expect(gaps[0]).toMatchObject({ status: 'open', reopened: true })
    expect(recentlyAnswered(gaps, NOW)).toEqual([])
  })

  it('标完之后验证过、结果仍答不上的先不显示；验证在标记之前的不影响', () => {
    const q = '年假怎么算'
    const check = (answerable: number, checked_at: number): GapCheckRow =>
      ({ kb_id: 1, fingerprint: gapFingerprint(q), answerable, answer: '', username: 'alice', checked_at })
    expect(recentlyAnswered(make([[q]], [check(0, NOW - DAY / 2)]), NOW)).toEqual([])
    expect(recentlyAnswered(make([[q]], [check(0, NOW - 2 * DAY)]), NOW)).toHaveLength(1)
    expect(recentlyAnswered(make([[q]], [check(1, NOW - DAY / 2)]), NOW)).toHaveLength(1)
  })
})
