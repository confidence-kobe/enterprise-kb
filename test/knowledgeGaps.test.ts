import { describe, expect, it } from 'vitest'
import { groupKnowledgeGaps, normalizeQuestion } from '../src/knowledgeGaps.js'
import type { KnowledgeGapRow } from '../src/db.js'

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
      sources: { ai_not_found: 1, feedback_not_found: 1 },
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
