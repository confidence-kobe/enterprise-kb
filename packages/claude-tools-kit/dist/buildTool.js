/**
 * buildTool 工厂函数
 * 精简自 claude-code 的 Tool.ts buildTool + TOOL_DEFAULTS
 *
 * 设计原则：
 * - isReadOnly 默认 false（fail-closed：假设会写入）
 * - isConcurrencySafe 默认 false（fail-closed：假设不安全）
 * - checkPermissions 默认 allow（权限由 permissionMode 决定）
 */
const TOOL_DEFAULTS = {
    isReadOnly: false,
    isConcurrencySafe: false,
    checkPermissions: async (_input, _ctx) => ({ behavior: 'allow' }),
};
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
export function buildTool(def) {
    return {
        ...TOOL_DEFAULTS,
        ...def,
    };
}
/**
 * 根据权限模式和工具属性决定是否允许执行
 */
export async function resolvePermission(tool, input, context) {
    // plan 模式：只读工具允许，写入工具拒绝
    if (context.permissionMode === 'plan') {
        if (!tool.isReadOnly) {
            return {
                behavior: 'deny',
                message: `[plan 模式] 工具 "${tool.name}" 需要写入权限，当前为只读计划模式`,
            };
        }
        return { behavior: 'allow' };
    }
    // bypassPermissions：跳过所有检查
    if (context.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow' };
    }
    // 调用工具自定义权限检查
    if (tool.checkPermissions) {
        const result = await tool.checkPermissions(input, context);
        // ask 行为：触发用户确认回调
        if (result.behavior === 'ask') {
            if (context.permissionMode === 'dontAsk') {
                return { behavior: 'allow' };
            }
            if (context.onPermissionRequest) {
                const approved = await context.onPermissionRequest(tool.name, result.message);
                return approved ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝' };
            }
            // 无回调且非 dontAsk：默认拒绝
            return { behavior: 'deny', message: result.message };
        }
        return result;
    }
    return { behavior: 'allow' };
}
//# sourceMappingURL=buildTool.js.map