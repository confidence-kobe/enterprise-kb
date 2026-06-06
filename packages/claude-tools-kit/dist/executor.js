/**
 * ClaudeExecutor — 将 Tool 集成到 Claude API 的执行器
 * 精简自 claude-code QueryEngine + query.ts 的核心循环
 *
 * 工作原理：
 *   1. 将 tools 的 inputSchema 转换为 Anthropic Tool 格式
 *   2. 调用 Claude API，Claude 在响应中可能包含 tool_use 块
 *   3. 找到对应工具，执行后将结果作为 tool_result 发回
 *   4. 循环直到 Claude 不再调用工具（stop_reason === 'end_turn'）
 */
import Anthropic from '@anthropic-ai/sdk';
import { resolvePermission } from './buildTool.js';
import { toolToAnthropicSchema } from './types.js';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 50;
export class ClaudeExecutor {
    client;
    options;
    constructor(options = {}) {
        this.client = new Anthropic({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
        });
        this.options = {
            apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
            baseURL: options.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? '',
            model: options.model ?? DEFAULT_MODEL,
            systemPrompt: options.systemPrompt ?? '',
            maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
            toolContext: options.toolContext,
            onTurn: options.onTurn,
        };
    }
    /**
     * 执行一轮对话（自动处理多轮工具调用）
     *
     * @param prompt  用户输入
     * @param tools   可用工具列表
     * @param history 对话历史（可选，用于多轮对话）
     */
    async run(prompt, tools = [], history = [], signal) {
        const toolContext = {
            cwd: process.cwd(),
            permissionMode: 'dontAsk',
            ...this.options.toolContext,
            signal,
        };
        const messages = [
            ...history,
            { role: 'user', content: prompt },
        ];
        const anthropicTools = tools.map(toolToAnthropicSchema);
        let responseText = '';
        let turns = 0;
        while (turns < this.options.maxTurns) {
            // 在每轮开始前检查中止信号
            if (signal?.aborted) {
                const e = new Error('Aborted');
                e.name = 'AbortError';
                throw e;
            }
            turns++;
            // 调用 API（signal 通过 RequestOptions 第二参数传入）
            const response = await this.client.messages.create({
                model: this.options.model,
                max_tokens: 8192,
                system: this.options.systemPrompt || undefined,
                tools: anthropicTools.length > 0 ? anthropicTools : undefined,
                messages,
            }, { signal });
            // 处理文本内容
            for (const block of response.content) {
                if (block.type === 'text') {
                    responseText += block.text;
                    this.options.onTurn?.({ type: 'text', text: block.text });
                }
            }
            // 追加 AI 响应到历史
            messages.push({ role: 'assistant', content: response.content });
            // 无工具调用 → 结束
            if (response.stop_reason === 'end_turn')
                break;
            // 处理工具调用
            const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
            if (toolUseBlocks.length === 0)
                break;
            // 执行所有工具（并发执行并发安全的工具）
            const toolResults = await this.executeTools(toolUseBlocks, tools, toolContext);
            // 将工具结果追加到对话
            messages.push({ role: 'user', content: toolResults });
        }
        return { response: responseText, turns, messages };
    }
    /**
     * 执行工具调用列表
     */
    async executeTools(toolUseBlocks, tools, context) {
        // 区分并发安全 vs 顺序执行
        const concurrentSafe = [];
        const sequential = [];
        for (const block of toolUseBlocks) {
            const tool = tools.find(t => t.name === block.name);
            if (tool?.isConcurrencySafe) {
                concurrentSafe.push(block);
            }
            else {
                sequential.push(block);
            }
        }
        const results = [];
        // 并发执行
        const concurrentResults = await Promise.all(concurrentSafe.map(block => this.executeSingleTool(block, tools, context)));
        results.push(...concurrentResults);
        // 顺序执行
        for (const block of sequential) {
            results.push(await this.executeSingleTool(block, tools, context));
        }
        return results;
    }
    /**
     * 执行单个工具调用
     */
    async executeSingleTool(block, tools, context) {
        const tool = tools.find(t => t.name === block.name);
        // 工具未找到
        if (!tool) {
            this.options.onTurn?.({
                type: 'tool_result',
                name: block.name,
                output: `工具不存在：${block.name}`,
                isError: true,
            });
            return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: `工具不存在：${block.name}`,
                is_error: true,
            };
        }
        const input = block.input;
        this.options.onTurn?.({ type: 'tool_call', name: tool.name, input });
        // 权限检查
        const permission = await resolvePermission(tool, input, context);
        if (permission.behavior === 'deny') {
            const msg = `权限拒绝：${permission.message}`;
            this.options.onTurn?.({ type: 'tool_result', name: tool.name, output: msg, isError: true });
            return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: msg,
                is_error: true,
            };
        }
        // 执行工具
        try {
            // 验证输入
            const parsed = tool.inputSchema.safeParse(input);
            if (!parsed.success) {
                const msg = `输入验证失败：${parsed.error.message}`;
                this.options.onTurn?.({ type: 'tool_result', name: tool.name, output: msg, isError: true });
                return {
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: msg,
                    is_error: true,
                };
            }
            const result = await tool.call(parsed.data, context);
            const output = tool.serializeResult(result.data);
            this.options.onTurn?.({
                type: 'tool_result',
                name: tool.name,
                output,
                isError: result.isError ?? false,
            });
            return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: output,
                is_error: result.isError ?? false,
            };
        }
        catch (err) {
            const msg = `工具执行错误：${err.message}`;
            this.options.onTurn?.({ type: 'tool_result', name: tool.name, output: msg, isError: true });
            return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: msg,
                is_error: true,
            };
        }
    }
}
/**
 * 便捷函数：快速创建执行器并运行
 */
export async function runWithClaude(prompt, tools, options = {}) {
    const executor = new ClaudeExecutor(options);
    return executor.run(prompt, tools);
}
//# sourceMappingURL=executor.js.map