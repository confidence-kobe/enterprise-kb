/**
 * GrepTool — 文件内容搜索工具
 * 核心逻辑提取自 claude-code GrepTool.ts（使用 Node.js 原生实现，无需 ripgrep）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { buildTool } from '../buildTool.js';
const MAX_RESULTS = 500;
const MAX_FILE_SIZE = 500 * 1024; // 500KB
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache']);
const inputSchema = z.object({
    pattern: z.string().describe('正则表达式搜索模式，如 "function\\s+\\w+"、"TODO:"'),
    path: z.string().optional().describe('搜索目录或文件（默认当前工作目录）'),
    glob: z.string().optional().describe('文件过滤 Glob，如 "*.ts"、"**/*.{js,ts}"'),
    output_mode: z.enum(['content', 'files_with_matches', 'count'])
        .optional()
        .describe('content：返回匹配行；files_with_matches：只返回文件路径；count：返回各文件匹配数'),
    '-A': z.number().int().nonnegative().optional().describe('匹配行之后显示 N 行'),
    '-B': z.number().int().nonnegative().optional().describe('匹配行之前显示 N 行'),
    '-i': z.boolean().optional().describe('是否忽略大小写'),
    head_limit: z.number().int().positive().optional().describe(`最多返回条数（默认 ${MAX_RESULTS}）`),
});
export const GrepTool = buildTool({
    name: 'Grep',
    description: `在文件内容中搜索正则表达式模式。
- pattern 使用 JavaScript 正则语法
- output_mode：
    content           — 返回匹配的行（含文件名和行号）
    files_with_matches — 只返回包含匹配的文件名（默认）
    count             — 返回每个文件的匹配行数
- 支持 -A/-B 上下文行、-i 忽略大小写`,
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    async call(input, context) {
        const start = Date.now();
        const searchPath = input.path
            ? (path.isAbsolute(input.path) ? input.path : path.resolve(context.cwd, input.path))
            : context.cwd;
        const flags = input['-i'] ? 'gi' : 'g';
        let regex;
        try {
            regex = new RegExp(input.pattern, flags);
        }
        catch {
            return {
                data: { mode: 'files_with_matches', results: [`无效的正则表达式: ${input.pattern}`], total: 0, truncated: false, durationMs: 0 },
                isError: true,
            };
        }
        const mode = input.output_mode ?? 'files_with_matches';
        const limit = input.head_limit ?? MAX_RESULTS;
        const globFilter = input.glob ? makeGlobRegex(input.glob) : null;
        const results = [];
        let total = 0;
        // 收集所有要搜索的文件
        const files = [];
        await collectFiles(searchPath, files, globFilter);
        for (const file of files) {
            if (results.length >= limit) {
                total += files.length - files.indexOf(file);
                break;
            }
            let content;
            try {
                const buf = await readFile(file);
                if (buf.length > MAX_FILE_SIZE)
                    continue;
                content = buf.toString('utf-8');
            }
            catch {
                continue;
            }
            const lines = content.split('\n');
            const matchingLines = [];
            for (let i = 0; i < lines.length; i++) {
                regex.lastIndex = 0;
                if (regex.test(lines[i]))
                    matchingLines.push(i);
            }
            if (matchingLines.length === 0)
                continue;
            total += matchingLines.length;
            const relPath = path.relative(context.cwd, file);
            if (mode === 'files_with_matches') {
                results.push(relPath);
            }
            else if (mode === 'count') {
                results.push(`${relPath}: ${matchingLines.length}`);
            }
            else {
                // content mode
                const before = input['-B'] ?? 0;
                const after = input['-A'] ?? 0;
                const shown = new Set();
                for (const idx of matchingLines) {
                    for (let j = Math.max(0, idx - before); j <= Math.min(lines.length - 1, idx + after); j++) {
                        shown.add(j);
                    }
                }
                for (const j of Array.from(shown).sort((a, b) => a - b)) {
                    const marker = matchingLines.includes(j) ? ':' : '-';
                    results.push(`${relPath}:${j + 1}${marker}${lines[j]}`);
                }
            }
        }
        const truncated = results.length >= limit;
        return {
            data: {
                mode,
                results: truncated ? results.slice(0, limit) : results,
                total,
                truncated,
                durationMs: Date.now() - start,
            },
        };
    },
    serializeResult(result) {
        const r = result;
        if (r.results.length === 0)
            return '（无匹配）';
        const header = `${r.total} 个匹配${r.truncated ? `（已截断至 ${r.results.length} 条）` : ''}（耗时 ${r.durationMs}ms）`;
        return `${header}\n${r.results.join('\n')}`;
    },
});
// ── 辅助函数 ─────────────────────────────────────
async function collectFiles(dir, out, globFilter) {
    let info;
    try {
        info = await stat(dir);
    }
    catch {
        return;
    }
    if (info.isFile()) {
        if (!globFilter || globFilter.test(path.basename(dir)))
            out.push(dir);
        return;
    }
    if (!info.isDirectory())
        return;
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (IGNORE_DIRS.has(entry))
            continue;
        await collectFiles(path.join(dir, entry), out, globFilter);
    }
}
/** 将 glob 字符串转为正则（只支持 * ? {a,b} 语法） */
function makeGlobRegex(glob) {
    const escaped = glob
        .split(',')
        .map(g => {
        // 处理 {a,b} 展开（嵌套不支持）
        return g
            .replace(/[.+^${}()|[\]\\]/g, c => ['(', ')'].includes(c) ? c : `\\${c}`)
            .replace(/\\\{/g, '{').replace(/\\\}/g, '}')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
    })
        .join('|');
    return new RegExp(`^(${escaped})$`);
}
//# sourceMappingURL=grep.js.map