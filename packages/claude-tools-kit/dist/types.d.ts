/**
 * 核心类型定义
 * 精简自 claude-code 的 Tool.ts / types/permissions.ts / types/message.ts
 */
import type { z } from 'zod';
import type { MessageParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages.js';
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan';
export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type PermissionResult = {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
} | {
    behavior: 'deny';
    message: string;
} | {
    behavior: 'ask';
    message: string;
};
export type ToolContext = {
    /** 当前工作目录 */
    cwd: string;
    /** 权限模式 */
    permissionMode: PermissionMode;
    /** 额外允许的目录（权限检查时额外允许访问这些目录） */
    allowedDirectories?: string[];
    /** 用户确认回调（permissionMode === 'default' 时调用） */
    onPermissionRequest?: (toolName: string, message: string) => Promise<boolean>;
    /** AbortSignal（用于取消长时操作） */
    signal?: AbortSignal;
};
export type ToolResult<T = unknown> = {
    data: T;
    /** 工具执行是否出错 */
    isError?: boolean;
};
export type AnyZodObject = z.ZodType<Record<string, unknown>>;
export type Tool<Input extends AnyZodObject = AnyZodObject, Output = unknown> = {
    /** 工具名称（LLM 调用时使用） */
    name: string;
    /** 工具描述（提供给 LLM） */
    description: string;
    /** 输入参数的 Zod Schema */
    inputSchema: Input;
    /** 执行工具 */
    call(input: z.infer<Input>, context: ToolContext): Promise<ToolResult<Output>>;
    /** 将结果序列化为 API 格式 */
    serializeResult(result: Output): string;
    /** 是否只读（只读工具在 plan 模式下也允许执行） */
    isReadOnly?: boolean;
    /** 是否可安全并发执行 */
    isConcurrencySafe?: boolean;
    /** 权限检查（可选，不提供则由 permissionMode 决定） */
    checkPermissions?(input: z.infer<Input>, context: ToolContext): Promise<PermissionResult>;
};
export type ExecutorOptions = {
    /** Anthropic API Key */
    apiKey?: string;
    /** Anthropic-compatible API base URL */
    baseURL?: string;
    /** 使用的模型 */
    model?: string;
    /** 系统提示词 */
    systemPrompt?: string;
    /** 最大轮次（防止无限循环） */
    maxTurns?: number;
    /** 工具执行上下文 */
    toolContext?: Partial<ToolContext>;
    /** 每轮回调（用于打印进度） */
    onTurn?: (turn: TurnEvent) => void;
};
export type TurnEvent = {
    type: 'text';
    text: string;
} | {
    type: 'tool_call';
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    name: string;
    output: string;
    isError: boolean;
};
export type ExecutorResult = {
    /** 最终响应文本 */
    response: string;
    /** 总轮次 */
    turns: number;
    /** 所有消息历史 */
    messages: MessageParam[];
};
export declare function toolToAnthropicSchema(tool: Tool): AnthropicTool;
/**
 * 将 Zod schema 转换为 JSON Schema（简化版，覆盖常用类型）
 */
export declare function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown>;
//# sourceMappingURL=types.d.ts.map