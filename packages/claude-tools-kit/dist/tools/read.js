/**
 * FileReadTool — 文件读取工具
 * 核心逻辑提取自 claude-code FileReadTool.ts
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { buildTool } from '../buildTool.js';
import { isPathAllowed } from '../utils/path.js';
const MAX_LINES = 2000;
const MAX_SIZE_BYTES = 1 * 1024 * 1024; // 1MB
const inputSchema = z.object({
    file_path: z.string().describe('要读取的文件绝对路径或相对路径'),
    offset: z.number().int().nonnegative().optional().describe('从第几行开始读取（0-indexed，默认 0）'),
    limit: z.number().int().positive().optional().describe(`最多读取行数（默认 ${MAX_LINES}）`),
});
export const FileReadTool = buildTool({
    name: 'Read',
    description: `读取文件内容并返回带行号的文本。
- 支持文本文件（自动检测编码）
- 可通过 offset/limit 分页读取大文件
- 返回内容带行号前缀，格式：{行号}\\t{内容}`,
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    async checkPermissions(input, context) {
        const resolved = resolvePath(input.file_path, context.cwd);
        if (!isPathAllowed(resolved, context.cwd, context.allowedDirectories)) {
            return {
                behavior: 'ask',
                message: `读取文件超出工作目录范围：${resolved}`,
            };
        }
        return { behavior: 'allow' };
    },
    async call(input, context) {
        const filePath = resolvePath(input.file_path, context.cwd);
        let rawContent;
        try {
            const buf = await readFile(filePath);
            if (buf.length > MAX_SIZE_BYTES) {
                return {
                    data: {
                        content: `[文件过大：${(buf.length / 1024).toFixed(1)}KB，超过 ${MAX_SIZE_BYTES / 1024}KB 限制]`,
                        totalLines: 0,
                        truncated: true,
                        filePath,
                    },
                    isError: true,
                };
            }
            rawContent = buf.toString('utf-8');
        }
        catch (err) {
            const e = err;
            const msg = e.code === 'ENOENT'
                ? `文件不存在：${filePath}`
                : `读取失败：${e.message}`;
            return { data: { content: msg, totalLines: 0, truncated: false, filePath }, isError: true };
        }
        const allLines = rawContent.split('\n');
        const offset = input.offset ?? 0;
        const limit = input.limit ?? MAX_LINES;
        const slice = allLines.slice(offset, offset + limit);
        const truncated = allLines.length > offset + limit;
        const withLineNumbers = slice
            .map((line, i) => `${offset + i + 1}\t${line}`)
            .join('\n');
        return {
            data: {
                content: withLineNumbers,
                totalLines: allLines.length,
                truncated,
                filePath,
            },
        };
    },
    serializeResult(result) {
        const r = result;
        if (r.truncated) {
            return `${r.content}\n\n[显示 ${r.content.split('\n').length} 行，文件共 ${r.totalLines} 行]`;
        }
        return r.content;
    },
});
function resolvePath(filePath, cwd) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
//# sourceMappingURL=read.js.map