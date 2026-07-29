import { describe, expect, it } from 'vitest'
import { chunkDocument } from '../src/documentChunker.js'

describe('chunkDocument', () => {
  it('keeps headings with subsequent chunks and accurate line starts', () => {
    const text = [
      '# Installation',
      '',
      'Install the package before starting the service.',
      '',
      'A'.repeat(180),
      '',
      '## Troubleshooting',
      '',
      'Check the service logs and network port.',
    ].join('\n')

    const chunks = chunkDocument(text, 140, 1)

    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0]).toMatchObject({ heading: 'Installation', startLine: 0 })
    expect(chunks.some(chunk => chunk.heading === 'Installation' && chunk.content.startsWith('# Installation'))).toBe(true)
    expect(chunks.at(-1)).toMatchObject({ heading: 'Troubleshooting', startLine: 6 })
  })

  it('normalizes CRLF and skips tiny empty fragments', () => {
    const chunks = chunkDocument('# 标题\r\n\r\n这是足够长的正文内容，用于检索测试。\r\n')

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('这是足够长的正文内容')
    expect(chunks[0].startLine).toBe(0)
  })

  it('does not index headings that have no body content', () => {
    const chunks = chunkDocument('# Empty section\n\n## Useful section\n\nUseful body content for retrieval.')

    expect(chunks).toHaveLength(1)
    expect(chunks[0].heading).toBe('Useful section')
    expect(chunks[0].content).not.toContain('Empty section')
  })
})
