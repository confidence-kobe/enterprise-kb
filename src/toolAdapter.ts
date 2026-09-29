/**
 * toolAdapter.ts
 *
 * 将 claude-tools-kit（提取自 H:\claude-code-main）的 Tool 接口
 * 适配为 LLMExecutor 所需的 LLMTool（OpenAI function calling 格式）。
 *
 * 桥接关系：
 *   claude-tools-kit Tool           →  LLMTool (OpenAI format)
 *   ─────────────────────────────────────────────────────────
 *   tool.name                        →  definition.name
 *   tool.description                 →  definition.description
 *   zodToJsonSchema(tool.inputSchema)→  definition.parameters
 *   tool.call(params, context)       ┐
 *   + tool.serializeResult(data)     ┘  →  execute(params, scope): string
 *
 * 安全保证：
 *   - permissionMode: 'plan'  → 仅允许只读工具，写入工具自动拒绝（claude-tools-kit）
 *   - assertParamsInScope     → 路径访问限制在有权限的知识库目录内（本项目实现；
 *     kit 在 plan 模式下会跳过 allowedDirectories 检查，不能依赖它）
 */

import type { Tool as KitTool, ToolContext } from '../packages/claude-tools-kit/dist/index.js'
import { zodToJsonSchema, resolvePermission } from '../packages/claude-tools-kit/dist/index.js'
import type { LLMTool } from './tools.js'
import { assertParamsInScope } from './toolScope.js'
import type { ToolScope } from './toolScope.js'

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

    async execute(params: Record<string, unknown>, scope: ToolScope): Promise<string> {
      const context: ToolContext = {
        cwd:                scope.cwd,
        permissionMode:     'plan',             // 只读模式，继承自 claude-code
        allowedDirectories: scope.allowedDirs,  // 严格限制在有权限的知识库目录
      }

      // 路径边界：kit 在 plan 模式下不会检查 allowedDirectories，这里必须自行拦截
      assertParamsInScope(kitTool.name, params, scope)

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
