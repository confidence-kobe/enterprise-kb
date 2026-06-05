/**
 * OllamaExecutor — OpenAI 兼容接口的工具调用循环（流式输出）
 * 连接 Ollama 本地大模型，执行 Glob/Grep/Read 工具
 */

import OpenAI from 'openai'
import type { LLMTool, QAEvent } from './tools.js'

type Message = OpenAI.Chat.ChatCompletionMessageParam

export interface RunResult {
  response: string
  turns: number
  messages: Message[]
}

export class OllamaExecutor {
  private client: OpenAI

  constructor(private config: {
    baseUrl: string
    apiKey: string
    model: string
    kbPath: string
    systemPrompt?: string
    maxTurns?: number
    onEvent?: (e: QAEvent) => void
  }) {
    this.client = new OpenAI({
      baseURL: config.baseUrl.replace(/\/$/, ''),
      apiKey: config.apiKey,
    })
  }

  async run(
    question: string,
    tools: LLMTool[],
    history: Message[] = [],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const { model, kbPath, systemPrompt, maxTurns = 25, onEvent } = this.config

    const messages: Message[] = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt } as Message] : []),
      ...history,
      { role: 'user', content: question },
    ]

    const toolDefs: OpenAI.Chat.ChatCompletionTool[] = tools.map(t => ({
      type: 'function',
      function: t.definition,
    }))

    let turns = 0
    let responseText = ''

    while (turns < maxTurns) {
      if (signal?.aborted) break

      turns++

      // ── 流式调用 ──────────────────────────────────────
      let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
      try {
        stream = await this.client.chat.completions.create(
          {
            model,
            messages,
            tools:       toolDefs.length > 0 ? toolDefs : undefined,
            tool_choice: toolDefs.length > 0 ? 'auto'  : undefined,
            stream: true,
          },
          { signal }
        )
      } catch (err) {
        if (signal?.aborted) break
        const msg = `Ollama 调用失败：${(err as Error).message}`
        onEvent?.({ type: 'error', message: msg })
        throw new Error(msg)
      }

      // ── 累积流式 chunks ───────────────────────────────
      let assistantContent = ''
      let finishReason: string | null = null
      const toolCallAcc: Map<number, { id: string; name: string; arguments: string }> = new Map()

      for await (const chunk of stream) {
        if (signal?.aborted) break

        const choice = chunk.choices[0]
        if (!choice) continue

        finishReason = choice.finish_reason ?? finishReason

        const delta = choice.delta

        // 文本增量 → 实时推送
        if (delta.content) {
          assistantContent += delta.content
          responseText     += delta.content
          onEvent?.({ type: 'text', text: delta.content })
        }

        // 工具调用增量 → 按 index 累积
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallAcc.has(tc.index)) {
              toolCallAcc.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' })
            }
            const entry = toolCallAcc.get(tc.index)!
            if (tc.id)              entry.id   = tc.id
            if (tc.function?.name) entry.name += tc.function.name
            if (tc.function?.arguments) entry.arguments += tc.function.arguments
          }
        }
      }

      if (signal?.aborted) break

      // ── 构建 assistant message ────────────────────────
      const toolCallsFinal = toolCallAcc.size > 0
        ? Array.from(toolCallAcc.values()).map((tc, i) => ({
            id:       tc.id || `call_${i}`,
            type:     'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }))
        : undefined

      const assistantMsg: Message = {
        role:       'assistant',
        content:    assistantContent || null,
        ...(toolCallsFinal ? { tool_calls: toolCallsFinal } : {}),
      } as Message
      messages.push(assistantMsg)

      // ── 结束条件 ──────────────────────────────────────
      if (finishReason === 'stop' || !toolCallsFinal?.length) break

      // ── 执行工具调用 ──────────────────────────────────
      const toolResults: Message[] = []

      for (const toolCall of toolCallsFinal) {
        if (signal?.aborted) break

        const toolName = toolCall.function.name
        const tool = tools.find(t => t.definition.name === toolName)

        let params: Record<string, unknown> = {}
        try {
          params = JSON.parse(toolCall.function.arguments)
        } catch {
          // ignore
        }

        onEvent?.({ type: 'tool_call', name: toolName, input: params })

        let output: string
        let isError = false

        if (!tool) {
          output  = `工具 "${toolName}" 不存在`
          isError = true
        } else {
          try {
            output = await tool.execute(params, kbPath)
          } catch (err) {
            output  = `工具执行错误：${(err as Error).message}`
            isError = true
          }
        }

        onEvent?.({ type: 'tool_result', name: toolName, output, isError })

        toolResults.push({
          role:         'tool',
          tool_call_id: toolCall.id,
          content:      output,
        })
      }

      if (signal?.aborted) break
      messages.push(...toolResults)
    }

    // 去掉 system message，只返回对话历史（user/assistant/tool）
    const historyOut = messages.filter(m => m.role !== 'system')

    return { response: responseText, turns, messages: historyOut }
  }
}
