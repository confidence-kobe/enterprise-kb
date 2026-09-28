/**
 * 工具适配器模块 (Tool Adapter)
 *
 * 核心设计与桥接架构：
 * 本模块负责将 `claude-tools-kit` 工具包中的只读工具（提取自 Claude Code 核心实现）
 * 转换为与 OpenAI Function Calling 标准兼容的 `LLMTool` 规范，实现跨生态工具复用。
 *
 * 协议映射关系：
 *   Claude Code KitTool                  OpenAI LLMTool
 *   ─────────────────────────────────    ─────────────────────────────────────────
 *   kitTool.name                      →  definition.name
 *   kitTool.description               →  definition.description
 *   zodToJsonSchema(kitTool.inputSchema) → definition.parameters (JSON Schema)
 *   kitTool.call(...) + serialize(...)→  execute(params, kbPath): Promise<string>
 *
 * 安全沙箱机制 (Security Sandbox)：
 * 1. 运行模式限制：设置 `permissionMode: 'plan'`，仅放行安全只读操作，任何写操作/执行命令操作均会被自动拦截；
 * 2. 目录范围收敛：设置 `allowedDirectories: [kbPath]`，严格限制工具文件访问路径，防止目录遍历攻击 (Directory Traversal)；
 * 3. 细粒度权限校验：在执行前统一经过 `resolvePermission` 决策，若返回 `deny` 则立即阻断并抛出异常。
 */

import type { Tool as KitTool, ToolContext } from '../packages/claude-tools-kit/dist/index.js'
import { zodToJsonSchema, resolvePermission } from '../packages/claude-tools-kit/dist/index.js'
import type { LLMTool } from './tools.js'

/**
 * 将单个 Claude Code 工具对象适配为 OpenAI 兼容的 LLMTool
 *
 * 适配流程：
 * 1. 利用 `zodToJsonSchema` 将 Zod 输入校验规则自动转换为标准 JSON Schema；
 * 2. 包装 `execute` 方法，在调用时注入沙箱配置（cwd, permissionMode, allowedDirectories）；
 * 3. 校验执行权限并调用原生工具逻辑；
 * 4. 统一调用 `serializeResult` 将结构化执行结果输出为适合 LLM 理解的字符串文本。
 *
 * @param kitTool 原生 claude-tools-kit 工具实例
 * @returns 适配后的 LLMTool 对象
 */
export function adaptTool(kitTool: KitTool): LLMTool {
  return {
    definition: {
      name:        kitTool.name,
      description: kitTool.description,
      parameters:  zodToJsonSchema(kitTool.inputSchema) as Record<string, unknown>,
    },

    async execute(params: Record<string, unknown>, kbPath: string): Promise<string> {
      // 构建工具运行时沙箱上下文
      const context: ToolContext = {
        cwd:                kbPath,
        permissionMode:     'plan',          // 强制只读规划模式
        allowedDirectories: [kbPath],        // 严格锁定在当前知识库目录内
      }

      // 权限合规预检（拦截任何破坏性操作）
      const permission = await resolvePermission(kitTool, params, context)
      if (permission.behavior === 'deny') {
        throw new Error(permission.message)
      }

      // 执行底层工具
      const result = await kitTool.call(params, context)

      // 格式化输出文本
      const text = kitTool.serializeResult(result.data)

      if (result.isError) {
        throw new Error(text)
      }

      return text
    },
  }
}

/**
 * 批量适配多个 Claude Code 原生工具
 *
 * @param kitTools 原生工具实例数组
 * @returns 适配后的 LLMTool 数组
 */
export function adaptTools(kitTools: KitTool[]): LLMTool[] {
  return kitTools.map(adaptTool)
}
