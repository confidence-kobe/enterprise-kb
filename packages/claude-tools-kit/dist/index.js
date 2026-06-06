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
// ── 核心框架 ───────────────────────────────────
export { buildTool } from './buildTool.js';
export { resolvePermission } from './buildTool.js';
export { toolToAnthropicSchema, zodToJsonSchema } from './types.js';
// ── 执行器 ────────────────────────────────────
// ── 内置工具 ──────────────────────────────────
export { BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, WebFetchTool, ALL_TOOLS, READ_ONLY_TOOLS, } from './tools/index.js';
// ── 工具函数 ──────────────────────────────────
export { isPathAllowed } from './utils/path.js';
//# sourceMappingURL=index.js.map
