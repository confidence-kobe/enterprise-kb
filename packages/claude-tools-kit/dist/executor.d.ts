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
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { ExecutorOptions, ExecutorResult, Tool } from './types.js';
export declare class ClaudeExecutor {
    private client;
    private options;
    constructor(options?: ExecutorOptions);
    /**
     * 执行一轮对话（自动处理多轮工具调用）
     *
     * @param prompt  用户输入
     * @param tools   可用工具列表
     * @param history 对话历史（可选，用于多轮对话）
     */
    run(prompt: string, tools?: Tool[], history?: MessageParam[], signal?: AbortSignal): Promise<ExecutorResult>;
    /**
     * 执行工具调用列表
     */
    private executeTools;
    /**
     * 执行单个工具调用
     */
    private executeSingleTool;
}
/**
 * 便捷函数：快速创建执行器并运行
 */
export declare function runWithClaude(prompt: string, tools: Tool[], options?: ExecutorOptions): Promise<ExecutorResult>;
//# sourceMappingURL=executor.d.ts.map