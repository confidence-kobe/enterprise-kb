/**
 * buildTool 工厂函数
 * 精简自 claude-code 的 Tool.ts buildTool + TOOL_DEFAULTS
 *
 * 设计原则：
 * - isReadOnly 默认 false（fail-closed：假设会写入）
 * - isConcurrencySafe 默认 false（fail-closed：假设不安全）
 * - checkPermissions 默认 allow（权限由 permissionMode 决定）
 */
import type { AnyZodObject, Tool, ToolContext, PermissionResult } from './types.js';
type DefaultableKeys = 'isReadOnly' | 'isConcurrencySafe' | 'checkPermissions';
/**
 * 工具定义（可省略带默认值的字段）
 */
export type ToolDef<Input extends AnyZodObject = AnyZodObject, Output = unknown> = Omit<Tool<Input, Output>, DefaultableKeys> & Partial<Pick<Tool<Input, Output>, DefaultableKeys>>;
/**
 * 构建完整 Tool 对象，自动填充默认值
 *
 * @example
 * ```ts
 * export const GreetTool = buildTool({
 *   name: 'Greet',
 *   description: '问候用户',
 *   inputSchema: z.object({ name: z.string() }),
 *   async call(input) {
 *     return { data: `你好, ${input.name}!` }
 *   },
 *   serializeResult: (r) => String(r),
 *   isReadOnly: true,
 * })
 * ```
 */
export declare function buildTool<Input extends AnyZodObject, Output = unknown>(def: ToolDef<Input, Output>): Tool<Input, Output>;
/**
 * 根据权限模式和工具属性决定是否允许执行
 */
export declare function resolvePermission(tool: Tool, input: Record<string, unknown>, context: ToolContext): Promise<PermissionResult>;
export {};
//# sourceMappingURL=buildTool.d.ts.map