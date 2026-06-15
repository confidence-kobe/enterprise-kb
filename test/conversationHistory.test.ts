import { describe, expect, it } from 'vitest'
import { buildTrustedHistory } from '../src/conversationHistory.js'
import type { MessageRow } from '../src/db.js'

function row(
  seq: number,
  role: string,
  content: string | null,
  toolCalls: unknown = null,
  toolCallId: string | null = null,
): MessageRow {
  return {
    id: seq + 1,
    conversation_id: 1,
    role,
    content,
    tool_calls: toolCalls ? JSON.stringify(toolCalls) : null,
    tool_call_id: toolCallId,
    seq,
    created_at: 0,
  }
}

describe('buildTrustedHistory', () => {
  it('keeps the newest complete turns without orphaning tool messages', () => {
    const rows = [
      row(0, 'user', 'old question'),
      row(1, 'assistant', 'old answer'),
      row(2, 'user', 'new question'),
      row(3, 'assistant', null, [{ id: 'call_1', type: 'function', function: { name: 'SearchDocs', arguments: '{}' } }]),
      row(4, 'tool', 'result', null, 'call_1'),
      row(5, 'assistant', 'new answer'),
    ]

    const selected = buildTrustedHistory(rows, 4, 10_000)

    expect(selected.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(selected.messages[0].content).toBe('new question')
    expect(selected.truncated).toBe(true)
  })

  it('ignores invalid leading messages and trims an oversized newest turn', () => {
    const rows = [
      row(0, 'tool', 'orphan', null, 'missing'),
      row(1, 'user', 'question'),
      row(2, 'assistant', 'x'.repeat(10_000)),
    ]

    const selected = buildTrustedHistory(rows, 40, 2_000)

    expect(selected.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(String(selected.messages[1].content)).toContain('[earlier content omitted]')
    expect(selected.truncated).toBe(true)
  })
})
