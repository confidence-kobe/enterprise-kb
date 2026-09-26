/**
 * LLM 工具调用执行器与流式处理引擎 (LLM Executor & Stream Engine)
 *
 * 核心功能与设计架构：
 * 1. ReAct 智能体循环 (Reasoning + Acting Loop)：驱动大语言模型自主判断是否需要调用工具，并在多轮交互中自动执行工具与反馈结果；
 * 2. 思考链流式过滤器 (ReasoningStreamFilter)：针对 DeepSeek-R1、Qwen 等开源思维链模型，实时拦截并过滤 `<think>...</think>` 标签，
 *    确保推理过程不泄漏到前端文本流中，同时支持跨 Chunk 边界的不完整标签缓冲；
 * 3. 工具名称流式合并器 (mergeStreamedToolName)：兼容不同 LLM 服务端（如 vLLM、Ollama、FastChat）在流式返回 tool_call 名称时的切片差异；
 * 4. 全链路可观察性：通过 `QAEvent` 事件流回调实时派发文本增量、工具调用入参、工具执行结果及错误通知。
 */

import OpenAI from 'openai'
import type { LLMTool, QAEvent } from './tools.js'

type Message = OpenAI.Chat.ChatCompletionMessageParam

/**
 * LLM 执行器运行返回结果结构体
 */
export interface RunResult {
  /** 模型最终给出的文本回复内容 */
  response: string
  /** 智能体完成问答所消耗的轮数 (Turns) */
  turns: number
  /** 本轮问答产生的完整历史消息列表（包含 user、assistant、tool 结果，已剔除 system） */
  messages: Message[]
}

/**
 * 思考链标签流式过滤器 (ReasoningStreamFilter)
 *
 * 专门过滤大型推理模型生成的 `<think>...</think>` 内部思维链标记。
 *
 * 实现难点与策略：
 * - 流式切片往往在标签中间断开（例如 chunk 1 收到 "<thi"，chunk 2 收到 "nk>"）；
 * - 维护内部缓冲区 `buffer`，检测末尾可能匹配 `<think>` 前缀的残缺字符，将其保留至下一 chunk 判定；
 * - 只有脱离 `<think>` 区域的纯文本才会被作为 visible 字符实时发射给客户端。
 */
export class ReasoningStreamFilter {
  /** 内部字符暂存缓冲区 */
  private buffer = ''
  /** 当前是否处于 <think>...</think> 思考区间内 */
  private inThink = false

  /**
   * 推送新的流式文本块，返回剥离思考链后的可见正文增量
   *
   * @param chunk 模型返回的当前增量字符串
   * @returns 过滤后应展示给用户的安全文本
   */
  push(chunk: string): string {
    this.buffer += chunk
    let visible = ''

    while (this.buffer) {
      // 状态一：处于思考标签内部，寻找闭合标签 </think>
      if (this.inThink) {
        const close = this.buffer.indexOf('</think>')
        if (close === -1) {
          // 未找到闭合标签，且为了防止截断在 </think> 标签中间，仅保留最后 7 个字符
          this.buffer = this.buffer.slice(-7)
          break
        }
        // 找到闭合标签，跳过思考内容，恢复正常状态
        this.buffer = this.buffer.slice(close + 8)
        this.inThink = false
        continue
      }

      // 状态二：处于普通正文状态，寻找开启标签 <think>
      const open = this.buffer.indexOf('<think>')
      if (open !== -1) {
        // 将 <think> 之前的文本输出
        visible += this.buffer.slice(0, open)
        this.buffer = this.buffer.slice(open + 7)
        this.inThink = true
        continue
      }

      // 状态三：没有完整的 <think> 标签，但尾部可能是残缺的标签前缀（如 "<th"）
      const partialLength = this.partialOpeningTagLength()
      const emitLength = this.buffer.length - partialLength
      visible += this.buffer.slice(0, emitLength)
      this.buffer = this.buffer.slice(emitLength)
      break
    }

    return visible
  }

  /**
   * 刷新并清空缓冲区，返回最后残留的可见文本
   *
   * @returns 缓冲区中非思考状态的剩余字符串
   */
  flush(): string {
    const visible = this.inThink ? '' : this.buffer
    this.buffer = ''
    return visible
  }

  /**
   * 计算缓冲区尾部与 `<think>` 前缀重合的字符长度
   */
  private partialOpeningTagLength(): number {
    const tag = '<think>'
    const max = Math.min(tag.length - 1, this.buffer.length)
    for (let length = max; length > 0; length--) {
      if (this.buffer.endsWith(tag.slice(0, length))) return length
    }
    return 0
  }
}

/**
 * 流式工具调用名称安全拼接函数
 *
 * 兼容不同推理引擎对 `delta.tool_calls[i].function.name` 的流式下发行为：
 * - 某些引擎（如 OpenAI 原生）只在第一个 chunk 发送完整名称；
 * - 某些引擎（如某些聚合代理）每个 chunk 重复发送完整名称；
 * - 某些引擎（如自建 vLLM）按 token 切片拼接名称（如 "Search" + "Docs"）。
 *
 * @param current 已累积的工具名
 * @param incoming 新到来的切片
 * @returns 规范合并后的工具名
 */
export function mergeStreamedToolName(current: string, incoming: string): string {
  if (!current) return incoming
  if (!incoming || incoming === current || current.endsWith(incoming)) return current
  if (incoming.startsWith(current)) return incoming
  return current + incoming
}

/**
 * LLM 核心执行器
 *
 * 负责通过 OpenAI 规范与底层模型进行多轮流式交互，调度工具执行与状态流转。
 */
export class LLMExecutor {
  /** OpenAI 客户端实例 */
  private client: OpenAI

  /**
   * @param config 执行器配置项
   * @param config.baseUrl 模型服务 API 地址
   * @param config.apiKey API 鉴权密钥
   * @param config.model 使用的模型标识符
   * @param config.kbPath 关联的知识库物理存储绝对路径
   * @param config.systemPrompt 系统预设提示词
   * @param config.maxTurns 允许的最大 ReAct 交互轮数，防死循环（默认 25 轮）
   * @param config.onEvent 交互过程中的事件回调钩子（文本流、工具调用、工具响应、报错）
   */
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

  /**
   * 启动智能体问答执行循环
   *
   * 执行步骤：
   * 1. 组装初始上下文：[System Prompt, ...历史消息, 用户提问]；
   * 2. 将本地工具集注册为 OpenAI Function Calling 规范；
   * 3. 开启 while 循环，调用模型流式接口；
   * 4. 实时提取 chunk，过滤思考链并触发 onEvent 文本回调；
   * 5. 累积组装工具调用入参 (tool_calls)；
   * 6. 判断终止条件（模型输出自然文本且无需调用工具，或达到最大轮次）；
   * 7. 若有工具调用，依次在知识库沙箱环境中执行工具，并将执行结果作为 tool 角色消息追加至上下文；
   * 8. 继续下一轮推理，直到模型给出最终答复。
   *
   * @param question 用户的提问文本
   * @param tools 允许模型调用的工具集合
   * @param history 前序已验证的历史对话记录
   * @param signal 外部取消信号 (用于客户端断开连接时及时释放资源)
   * @returns 包含模型最终回复、消耗轮次及新历史消息的对象
   */
  async run(
    question: string,
    tools: LLMTool[],
    history: Message[] = [],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const { model, kbPath, systemPrompt, maxTurns = 25, onEvent } = this.config

    // 组装初始消息队列
    const messages: Message[] = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt } as Message] : []),
      ...history,
      { role: 'user', content: question },
    ]

    // 转换为 OpenAI 函数调用结构
    const toolDefs: OpenAI.Chat.ChatCompletionTool[] = tools.map(t => ({
      type: 'function',
      function: t.definition,
    }))

    let turns = 0
    let responseText = ''

    // 智能体 ReAct 交互循环
    while (turns < maxTurns) {
      if (signal?.aborted) break

      turns++

      // ── 发起流式推理请求 ──────────────────────────────────────
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
        const msg = `模型调用失败：${(err as Error).message}`
        onEvent?.({ type: 'error', message: msg })
        throw new Error(msg)
      }

      // ── 累积分块 chunks ───────────────────────────────
      let assistantContent = ''
      let finishReason: string | null = null
      const toolCallAcc: Map<number, { id: string; name: string; arguments: string }> = new Map()
      const reasoningFilter = new ReasoningStreamFilter()

      for await (const chunk of stream) {
        if (signal?.aborted) break

        const choice = chunk.choices[0]
        if (!choice) continue

        finishReason = choice.finish_reason ?? finishReason
        const delta = choice.delta

        // 文本增量 → 过滤思考链后实时推送给客户端
        if (delta.content) {
          assistantContent += delta.content
          const visible = reasoningFilter.push(delta.content)
          if (visible && (responseText || visible.trim())) {
            responseText += visible
            onEvent?.({ type: 'text', text: visible })
          }
        }

        // 工具调用增量 → 按 index 累积入参参数片段
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallAcc.has(tc.index)) {
              toolCallAcc.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' })
            }
            const entry = toolCallAcc.get(tc.index)!
            if (tc.id)              entry.id   = tc.id
            if (tc.function?.name) entry.name = mergeStreamedToolName(entry.name, tc.function.name)
            if (tc.function?.arguments) entry.arguments += tc.function.arguments
          }
        }
      }

      if (signal?.aborted) break

      // 清空流式过滤器的残留缓冲区
      const remainingVisible = reasoningFilter.flush()
      if (remainingVisible && (responseText || remainingVisible.trim())) {
        responseText += remainingVisible
        onEvent?.({ type: 'text', text: remainingVisible })
      }

      // ── 构建并持久化当前轮次的 assistant 消息 ────────────────────
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

      // ── 检查是否满足退出条件 ──────────────────────────────────────
      // 若 finishReason 为 stop 或模型没有发起任何工具调用，说明已得出最终回答
      if (finishReason === 'stop' || !toolCallsFinal?.length) break

      // ── 依次执行所有工具调用 ──────────────────────────────────
      const toolResults: Message[] = []

      for (const toolCall of toolCallsFinal) {
        if (signal?.aborted) break

        const toolName = toolCall.function.name
        const tool = tools.find(t => t.definition.name === toolName)

        // 解析模型输出的 JSON 参数
        let params: Record<string, unknown> = {}
        try {
          params = JSON.parse(toolCall.function.arguments)
        } catch {
          // 参数格式解析异常，仍传递空对象交由工具处理
        }

        // 派发工具调用开始事件
        onEvent?.({ type: 'tool_call', name: toolName, input: params })

        let output: string
        let isError = false

        if (!tool) {
          output  = `工具 "${toolName}" 不存在`
          isError = true
        } else {
          try {
            // 执行本地知识库工具逻辑
            output = await tool.execute(params, kbPath)
          } catch (err) {
            output  = `工具执行错误：${(err as Error).message}`
            isError = true
          }
        }

        // 派发工具执行结果事件
        onEvent?.({ type: 'tool_result', name: toolName, output, isError })

        // 封装为标准 tool 响应消息
        toolResults.push({
          role:         'tool',
          tool_call_id: toolCall.id,
          content:      output,
        })
      }

      if (signal?.aborted) break
      // 将工具结果加入对话流，驱动模型进入下一轮思考
      messages.push(...toolResults)
    }

    // 去掉开头的 system message，只返回属于实际交互历史的消息列表 (user / assistant / tool)
    const historyOut = messages.filter(m => m.role !== 'system')

    return { response: responseText, turns, messages: historyOut }
  }
}
