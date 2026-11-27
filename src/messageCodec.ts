/**
 * 对话消息在大模型格式和数据库行之间的转换。
 */

import type { MessageRow } from './db.js'

/**
 * 大模型消息 ⇄ 数据库行。tool_calls 是数组，存成 JSON 字符串；seq 是消息在对话里的顺序，
 * 读回来时按 seq 排序，保证工具调用和工具结果的先后不乱。
 */
export function serializeMessage(msg: Record<string, unknown>, seq: number) {
  return {
    role:         msg.role as string,
    content:      typeof msg.content === 'string' ? msg.content : (msg.content as string | null) ?? null,
    tool_calls:   ('tool_calls' in msg && msg.tool_calls) ? JSON.stringify(msg.tool_calls) : null,
    tool_call_id: ('tool_call_id' in msg) ? (msg.tool_call_id as string | null) ?? null : null,
    seq,
  }
}

export function deserializeMessage(row: MessageRow): Record<string, unknown> {
  const base: Record<string, unknown> = { role: row.role, content: row.content ?? null }
  if (row.tool_calls)   base.tool_calls   = JSON.parse(row.tool_calls)
  if (row.tool_call_id) base.tool_call_id = row.tool_call_id
  return base
}
