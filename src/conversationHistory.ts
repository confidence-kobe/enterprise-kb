/**
 * 对话历史记录处理与上下文预算管理模块 (Conversation History & Context Budget)
 *
 * 核心设计与安全考量：
 * 1. 零信任客户端历史：永远从数据库服务端拉取可信的 MessageRow 记录，防止客户端伪造上下文或越权注入。
 * 2. 对话轮次 (Turn) 完整性保证：一个轮次严格从 'user' 消息开始，包含其后伴随的 'assistant'（可能含 tool_calls）
 *    及 'tool' 执行结果，确保 tool 消息永远不会孤立发送给模型，符合 LLM API 规范。
 * 3. 滑动窗口与字符预算截断：当对话超出条数 (maxMessages) 或字符上限 (maxChars) 时，优先保留最新的对话轮次；
 *    若单轮超长，则采用首尾保留策略压缩内容，防止上下文撑爆模型 Token 窗口。
 */

import type { MessageRow } from './db.js'

/**
 * 经过清洗、预算校验与截断后的可信对话历史数据
 */
export interface TrustedHistory {
  /** 最终送入 LLM 上下文的格式化消息列表 */
  messages: Record<string, unknown>[]
  /** 数据库中该对话的有效历史消息总条数（用于前端展示或统计） */
  totalMessages: number
  /** 是否发生了截断（因超出消息数上限、字符预算或内容被局部裁剪） */
  truncated: boolean
}

/**
 * 将数据库中的单行消息反序列化为 OpenAI 兼容的消息格式
 *
 * @param row 数据库 messages 表记录
 * @returns 格式化后的消息对象；若数据损坏或角色非法则返回 null
 */
function deserializeMessage(row: MessageRow): Record<string, unknown> | null {
  // 只允许系统标准的三种角色（system 角色由 buildSystemPrompt 单独注入）
  if (!['user', 'assistant', 'tool'].includes(row.role)) return null

  const message: Record<string, unknown> = {
    role: row.role,
    content: row.content ?? null,
  }

  // 反序列化 assistant 产生的工具调用定义
  if (row.tool_calls) {
    try {
      message.tool_calls = JSON.parse(row.tool_calls)
    } catch {
      return null // JSON 解析失败视为脏数据，予以丢弃
    }
  }

  // 记录 tool 结果对应的 tool_call_id
  if (row.tool_call_id) message.tool_call_id = row.tool_call_id
  return message
}

/**
 * 计算单条消息序列化后的字符占用大小（估算 Token 预算消耗）
 *
 * @param message 待计算的消息对象
 * @returns JSON 字符串长度
 */
function messageSize(message: Record<string, unknown>): number {
  return JSON.stringify(message).length
}

/**
 * 当单条文本内容超出限制时，保留头部与尾部关键信息，中间插入省略标记
 *
 * 策略：头部保留 60% 字符（包含提问或初始上下文），尾部保留 40% 字符（通常包含总结或最新结论）
 *
 * @param content 原始文本内容
 * @param limit 最大允许字符数
 * @returns 截断并拼接省略标记后的文本
 */
function trimContent(content: string, limit: number): string {
  if (content.length <= limit) return content
  const marker = '\n...[earlier content omitted]...\n'
  const available = Math.max(0, limit - marker.length)
  const headLength = Math.ceil(available * 0.6)
  const tailLength = available - headLength
  return content.slice(0, headLength) + marker + content.slice(-tailLength)
}

/**
 * 针对单个超长轮次进行字符预算压缩
 *
 * @param turn 属于同一个轮次的消息集合（如 [user, assistant(tool_call), tool, assistant]）
 * @param maxChars 当前轮次的最大字符预算配额
 * @returns 经过裁剪压缩后的消息列表
 */
function fitTurnToBudget(turn: Record<string, unknown>[], maxChars: number): Record<string, unknown>[] {
  // 若未超出预算则直接原样返回
  if (turn.reduce((sum, message) => sum + messageSize(message), 0) <= maxChars) return turn

  // 将预算均分给该轮次内的各条消息，保底单条至少 512 字符
  const contentLimit = Math.max(512, Math.floor(maxChars / Math.max(turn.length, 1)))
  return turn.map(message => ({
    ...message,
    content: typeof message.content === 'string'
      ? trimContent(message.content, contentLimit)
      : message.content,
  }))
}

/**
 * 构建可信的对话历史上下文 (buildTrustedHistory)
 *
 * 核心流程：
 * 1. 过滤并反序列化数据库消息；
 * 2. 将消息按轮次 (Turn) 分组：每个轮次必须以 'user' 消息起始，避免 tool 消息孤立；
 * 3. 从最新轮次倒序向前收集，直至达到消息数量或字符数上限；
 * 4. 如果连最新的一轮都超出了总字符配额，对其执行局部截断压缩；
 * 5. 组装并返回平铺的消息列表及截断状态。
 *
 * @param rows 数据库中按时间排序的原始历史消息行
 * @param maxMessages 最大允许纳入的历史消息条数，默认 40
 * @param maxChars 最大允许消耗的上下文总字符数，默认 40,000
 * @returns 经过修剪的安全对话历史结构体
 */
export function buildTrustedHistory(
  rows: MessageRow[],
  maxMessages = 40,
  maxChars = 40_000,
): TrustedHistory {
  // 1. 反序列化并过滤非法消息
  const validMessages = rows
    .map(deserializeMessage)
    .filter((message): message is Record<string, unknown> => message !== null)

  // 2. 按轮次分组（每个 turn 必然由 user 起始）
  const turns: Record<string, unknown>[][] = []
  for (const message of validMessages) {
    if (message.role === 'user') turns.push([message])
    else if (turns.length) turns[turns.length - 1].push(message)
  }

  // 3. 从最新的轮次开始往前纳入历史，维持滑动窗口
  const selected: Record<string, unknown>[][] = []
  let selectedCount = 0
  let selectedChars = 0

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const turnChars = turn.reduce((sum, message) => sum + messageSize(message), 0)
    // 检查加入该轮后是否会超过限制（至少保留最新的一轮）
    const exceedsLimit = selected.length > 0
      && (selectedCount + turn.length > maxMessages || selectedChars + turnChars > maxChars)
    if (exceedsLimit) break

    // 如果是仅有的最新一轮且超出总字符预算，压缩该轮内容以适应上限
    const selectedTurn = selected.length === 0 ? fitTurnToBudget(turn, maxChars) : turn
    selected.unshift(selectedTurn)
    selectedCount += selectedTurn.length
    selectedChars += selectedTurn.reduce((sum, message) => sum + messageSize(message), 0)
  }

  // 4. 将分组还原为一维消息数组
  const messages = selected.flat()
  return {
    messages,
    totalMessages: validMessages.length,
    truncated: messages.length < validMessages.length
      || messages.some(message => String(message.content ?? '').includes('[earlier content omitted]')),
  }
}
