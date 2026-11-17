import { describe, expect, it } from 'vitest'
import { applyGapStatuses, gapFingerprint, groupKnowledgeGaps, normalizeQuestion } from '../src/knowledgeGaps.js'
import type { GapStatusRow, KnowledgeGapRow } from '../src/db.js'

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
    ({ kb_id, fingerprint: gapFingerprint(question), status, username: 'alice', updated_at })

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
