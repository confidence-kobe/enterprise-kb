/**
 * toolAdapter.ts
 *
 * 将 claude-tools-kit（提取自 H:\claude-code-main）的 Tool 接口
 * 适配为 OllamaExecutor 所需的 LLMTool（OpenAI function calling 格式）。
 *
 * 桥接关系：
 *   claude-tools-kit Tool           →  LLMTool (OpenAI format)
 *   ─────────────────────────────────────────────────────────
 *   tool.name                        →  definition.name
 *   tool.description                 →  definition.description
 *   zodToJsonSchema(tool.inputSchema)→  definition.parameters
 *   tool.call(params, context)       ┐
 *   + tool.serializeResult(data)     ┘  →  execute(params, kbPath): string
 *
 * 安全保证（继承自 claude-tools-kit）：
 *   - permissionMode: 'plan'  → 仅允许只读工具，写入工具自动拒绝
 *   - allowedDirectories: [kbPath] → 路径访问限制在知识库目录内
 */

import type { Tool as KitTool, ToolContext } from '../packages/claude-tools-kit/dist/index.js'
import { zodToJsonSchema, resolvePermission } from '../packages/claude-tools-kit/dist/index.js'
import type { LLMTool } from './tools.js'

/**
 * 将单个 claude-tools-kit Tool 适配为 LLMTool
 */
export function adaptTool(kitTool: KitTool): LLMTool {
  return {
    definition: {
      name:        kitTool.name,
      description: kitTool.description,
      parameters:  zodToJsonSchema(kitTool.inputSchema) as Record<string, unknown>,
    },

    async execute(params: Record<string, unknown>, kbPath: string): Promise<string> {
      const context: ToolContext = {
        cwd:                kbPath,
        permissionMode:     'plan',          // 只读模式，继承自 claude-code
        allowedDirectories: [kbPath],        // 严格限制在知识库目录
      }

      // 权限检查（复用 claude-tools-kit 的 resolvePermission 逻辑）
      const permission = await resolvePermission(kitTool, params, context)
      if (permission.behavior === 'deny') {
        throw new Error(permission.message)
      }

      // 执行工具
      const result = await kitTool.call(params, context)

      // 序列化结果（使用 claude-tools-kit 的 serializeResult）
      const text = kitTool.serializeResult(result.data)

      if (result.isError) {
        throw new Error(text)
      }

      return text
    },
  }
}

/**
 * 将多个 claude-tools-kit 工具批量适配
 */
export function adaptTools(kitTools: KitTool[]): LLMTool[] {
  return kitTools.map(adaptTool)
}
