import { describe, expect, it } from 'vitest'
import { mergeStreamedToolName, ReasoningStreamFilter } from '../src/executor.js'

describe('ReasoningStreamFilter', () => {
  it('hides complete and chunked think blocks', () => {
    const filter = new ReasoningStreamFilter()

    expect(filter.push('<thi')).toBe('')
    expect(filter.push('nk>internal reasoning')).toBe('')
    expect(filter.push('</think>\nFinal answer')).toBe('\nFinal answer')
    expect(filter.flush()).toBe('')
  })

  it('passes ordinary response text through', () => {
    const filter = new ReasoningStreamFilter()

    expect(filter.push('Hello ')).toBe('Hello ')
    expect(filter.push('world')).toBe('world')
    expect(filter.flush()).toBe('')
  })
})

describe('mergeStreamedToolName', () => {
  it('supports partial names and ignores repeated complete names', () => {
    expect(mergeStreamedToolName('', 'Search')).toBe('Search')
    expect(mergeStreamedToolName('Search', 'Docs')).toBe('SearchDocs')
    expect(mergeStreamedToolName('SearchDocs', 'SearchDocs')).toBe('SearchDocs')
  })
})
