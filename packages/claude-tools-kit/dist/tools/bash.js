/**
 * BashTool — Shell 命令执行工具
 * 核心逻辑提取自 claude-code BashTool.tsx
 */
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildTool } from '../buildTool.js';
const exec = promisify(execCallback);
const DEFAULT_TIMEOUT_MS = 120_000; // 2 分钟
const MAX_TIMEOUT_MS = 600_000; // 10 分钟
const MAX_OUTPUT_LENGTH = 50_000; // 截断超长输出
const inputSchema = z.object({
    command: z.string().describe('要执行的 Shell 命令。支持管道、重定向等 Shell 特性。'),
    timeout: z.number().int().positive().optional().describe(`超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}）`),
    workingDir: z.string().optional().describe('命令执行目录（默认为 toolContext.cwd）'),
});
export const BashTool = buildTool({
    name: 'Bash',
    description: `在 Shell 中执行命令并返回输出。
- 支持管道、重定向、多命令（; && ||）
- stdout/stderr 均返回
- 超时后自动终止
- 不要用于交互式命令（如 vim、less）`,
    inputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    async checkPermissions(input, context) {
        // plan 模式：拒绝所有 Bash 操作
        if (context.permissionMode === 'plan') {
            return { behavior: 'deny', message: 'plan 模式下不允许执行 Shell 命令' };
        }
        // default 模式：询问
        if (context.permissionMode === 'default') {
            return {
                behavior: 'ask',
                message: `即将执行命令：\n  ${input.command}\n工作目录：${input.workingDir ?? context.cwd}`,
            };
        }
        return { behavior: 'allow' };
    },
    async call(input, context) {
        const cwd = input.workingDir ?? context.cwd;
        const timeoutMs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        try {
            const { stdout, stderr } = await exec(input.command, {
                cwd,
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024, // 10MB
                signal: context.signal,
            });
            return {
                data: {
                    stdout: truncate(stdout, MAX_OUTPUT_LENGTH),
                    stderr: truncate(stderr, MAX_OUTPUT_LENGTH),
                    exitCode: 0,
                    timedOut: false,
                },
            };
        }
        catch (err) {
            const error = err;
            return {
                data: {
                    stdout: truncate(error.stdout ?? '', MAX_OUTPUT_LENGTH),
                    stderr: truncate(error.stderr ?? '', MAX_OUTPUT_LENGTH),
                    exitCode: typeof error.code === 'number' ? error.code : 1,
                    timedOut: error.killed === true || error.signal === 'SIGTERM',
                },
                isError: true,
            };
        }
    },
    serializeResult(result) {
        const r = result;
        const parts = [];
        if (r.timedOut)
            parts.push('[命令超时]');
        if (r.stdout)
            parts.push(r.stdout);
        if (r.stderr)
            parts.push(`[stderr]\n${r.stderr}`);
        if (r.exitCode !== 0 && !r.timedOut)
            parts.push(`[退出码: ${r.exitCode}]`);
        return parts.join('\n') || '(无输出)';
    },
});
function truncate(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return text.slice(0, maxLength) + `\n... [输出已截断，共 ${text.length} 字符]`;
}
//# sourceMappingURL=bash.js.map