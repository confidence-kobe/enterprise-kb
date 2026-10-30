/**
 * 对话历史裁剪：决定把哪些历史消息交给大模型。
 *
 * 两个约束：
 * - 不能太长，否则超出模型的上下文窗口，费用也高（按条数和字数两道上限）
 * - 不能把一次工具调用和它的结果拆开，否则 OpenAI 兼容接口会直接返回 400
 * 所以按"轮次"（从一条用户消息开始到下一条用户消息之前）整轮保留或整轮丢弃。
 *
 * 历史一律从数据库读取，客户端传来的历史不使用，防止有人伪造"之前的对话"来误导模型。
 */

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
 * 从数据库里保存的对话中选出最近几轮，不信任客户端传来的历史记录。
 * 每一轮都从用户消息开始，所以不会单独发出没有对应调用的工具消息。
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
