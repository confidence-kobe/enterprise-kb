/**
 * GlobTool — 文件名模式匹配工具
 * 核心逻辑提取自 claude-code GlobTool.ts
 */
import { glob } from 'glob';
import * as path from 'node:path';
import { z } from 'zod';
import { buildTool } from '../buildTool.js';
const MAX_RESULTS = 1000;
const inputSchema = z.object({
    pattern: z.string().describe('Glob 模式，如 "**/*.ts"、"src/**/*.{ts,tsx}"、"*.json"'),
    path: z.string().optional().describe('搜索根目录（默认当前工作目录）'),
});
export const GlobTool = buildTool({
    name: 'Glob',
    description: `按文件名模式搜索文件，返回匹配的路径列表。
- 支持标准 Glob 语法：* ** ? {a,b} [0-9]
- 结果按修改时间降序排列（最近修改的在前）
- 最多返回 ${MAX_RESULTS} 条结果`,
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    async call(input, context) {
        const searchDir = input.path
            ? (path.isAbsolute(input.path) ? input.path : path.resolve(context.cwd, input.path))
            : context.cwd;
        const start = Date.now();
        let files;
        try {
            files = await glob(input.pattern, {
                cwd: searchDir,
                absolute: false,
                nodir: true,
                ignore: ['**/node_modules/**', '**/.git/**'],
            });
        }
        catch (err) {
            const e = err;
            return {
                data: { filenames: [], numFiles: 0, truncated: false, durationMs: Date.now() - start },
                isError: true,
            };
        }
        // 排序（按字典序，稳定）
        files.sort();
        const truncated = files.length > MAX_RESULTS;
        const result = truncated ? files.slice(0, MAX_RESULTS) : files;
        return {
            data: {
                filenames: result,
                numFiles: files.length,
                truncated,
                durationMs: Date.now() - start,
            },
        };
    },
    serializeResult(result) {
        const r = result;
        const header = `找到 ${r.numFiles} 个文件${r.truncated ? `（已截断，显示前 ${MAX_RESULTS} 条）` : ''}（耗时 ${r.durationMs}ms）`;
        if (r.filenames.length === 0)
            return `${header}\n（无匹配）`;
        return `${header}\n${r.filenames.join('\n')}`;
    },
});
//# sourceMappingURL=glob.js.map