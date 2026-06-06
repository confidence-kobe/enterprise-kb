/**
 * claude-tools-kit — 主入口
 *
 * 使用方式：
 *
 * import { ClaudeExecutor, ALL_TOOLS, BashTool, FileReadTool } from 'claude-tools-kit'
 *
 * const executor = new ClaudeExecutor({ apiKey: 'sk-ant-...' })
 * const result = await executor.run('列出当前目录的文件', ALL_TOOLS)
 * console.log(result.response)
 */
export { buildTool } from './buildTool.js';
export type { ToolDef } from './buildTool.js';
export { resolvePermission } from './buildTool.js';
export type { Tool, ToolContext, ToolResult, PermissionMode, PermissionBehavior, PermissionResult, ExecutorOptions, ExecutorResult, TurnEvent, AnyZodObject, } from './types.js';
export { toolToAnthropicSchema, zodToJsonSchema } from './types.js';
export { BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, WebFetchTool, ALL_TOOLS, READ_ONLY_TOOLS, } from './tools/index.js';
export type { BashInput, BashOutput, ReadInput, ReadOutput, WriteInput, WriteOutput, EditInput, EditOutput, GlobInput, GlobOutput, GrepInput, GrepOutput, WebFetchInput, WebFetchOutput, } from './tools/index.js';
export { isPathAllowed } from './utils/path.js';
//# sourceMappingURL=index.d.ts.map
