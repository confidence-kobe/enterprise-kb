import type { MessageRow } from './db.js'

export interface TrustedHistory {
  messages: Record<string, unknown>[]
  totalMessages: number
  truncated: boolean
}

function deserializeMessage(row: MessageRow): Record<string, unknown> | null {
  if (!['user', 'assistant', 'tool'].includes(row.role)) return null

  const message: Record<string, unknown> = {
    role: row.role,
    content: row.content ?? null,
  }

  if (row.tool_calls) {
    try {
      message.tool_calls = JSON.parse(row.tool_calls)
    } catch {
      return null
    }
  }
  if (row.tool_call_id) message.tool_call_id = row.tool_call_id
  return message
}

function messageSize(message: Record<string, unknown>): number {
  return JSON.stringify(message).length
}

function trimContent(content: string, limit: number): string {
  if (content.length <= limit) return content
  const marker = '\n...[earlier content omitted]...\n'
  const available = Math.max(0, limit - marker.length)
  const headLength = Math.ceil(available * 0.6)
  const tailLength = available - headLength
  return content.slice(0, headLength) + marker + content.slice(-tailLength)
}

function fitTurnToBudget(turn: Record<string, unknown>[], maxChars: number): Record<string, unknown>[] {
  if (turn.reduce((sum, message) => sum + messageSize(message), 0) <= maxChars) return turn

  const contentLimit = Math.max(512, Math.floor(maxChars / Math.max(turn.length, 1)))
  return turn.map(message => ({
    ...message,
    content: typeof message.content === 'string'
      ? trimContent(message.content, contentLimit)
      : message.content,
  }))
}

/**
 * Select recent persisted conversation turns without trusting client-provided history.
 * A turn always starts with a user message, so tool messages are never sent orphaned.
 */
export function buildTrustedHistory(
  rows: MessageRow[],
  maxMessages = 40,
  maxChars = 40_000,
): TrustedHistory {
  const validMessages = rows
    .map(deserializeMessage)
    .filter((message): message is Record<string, unknown> => message !== null)

  const turns: Record<string, unknown>[][] = []
  for (const message of validMessages) {
    if (message.role === 'user') turns.push([message])
    else if (turns.length) turns[turns.length - 1].push(message)
  }

  const selected: Record<string, unknown>[][] = []
  let selectedCount = 0
  let selectedChars = 0

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const turnChars = turn.reduce((sum, message) => sum + messageSize(message), 0)
    const exceedsLimit = selected.length > 0
      && (selectedCount + turn.length > maxMessages || selectedChars + turnChars > maxChars)
    if (exceedsLimit) break

    const selectedTurn = selected.length === 0 ? fitTurnToBudget(turn, maxChars) : turn
    selected.unshift(selectedTurn)
    selectedCount += selectedTurn.length
    selectedChars += selectedTurn.reduce((sum, message) => sum + messageSize(message), 0)
  }

  const messages = selected.flat()
  return {
    messages,
    totalMessages: validMessages.length,
    truncated: messages.length < validMessages.length
      || messages.some(message => String(message.content ?? '').includes('[earlier content omitted]')),
  }
}
