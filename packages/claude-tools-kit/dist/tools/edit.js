/**
 * FileEditTool — 文件精确编辑工具（字符串替换）
 * 核心逻辑提取自 claude-code FileEditTool
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { buildTool } from '../buildTool.js';
import { isPathAllowed } from '../utils/path.js';
const inputSchema = z.object({
    file_path: z.string().describe('要编辑的文件路径'),
    old_string: z.string().describe('要替换的原始字符串。必须在文件中唯一存在，否则报错。'),
    new_string: z.string().describe('替换后的新字符串（可为空字符串表示删除）'),
    replace_all: z.boolean().optional().describe('是否替换所有匹配（默认 false，即只替换第一个）'),
});
export const FileEditTool = buildTool({
    name: 'Edit',
    description: `对文件进行精确字符串替换。
- old_string 必须在文件中唯一存在（否则报错）
- 保留缩进和换行风格
- 适合小范围修改；大范围重写请用 Write 工具
- replace_all=true 时替换所有匹配项`,
    inputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    async checkPermissions(input, context) {
        const resolved = resolvePath(input.file_path, context.cwd);
        if (!isPathAllowed(resolved, context.cwd, context.allowedDirectories)) {
            return {
                behavior: 'ask',
                message: `编辑文件超出工作目录范围：${resolved}`,
            };
        }
        if (context.permissionMode === 'default') {
            return {
                behavior: 'ask',
                message: `即将编辑：${resolved}\n替换：${preview(input.old_string)} → ${preview(input.new_string)}`,
            };
        }
        return { behavior: 'allow' };
    },
    async call(input, context) {
        const filePath = resolvePath(input.file_path, context.cwd);
        let oldContent;
        try {
            oldContent = (await readFile(filePath)).toString('utf-8');
        }
        catch (err) {
            const e = err;
            return {
                data: { filePath, replacements: 0, oldContent: '', newContent: '' },
                isError: true,
            };
        }
        const { old_string, new_string, replace_all } = input;
        // 唯一性检查（非 replace_all 模式）
        if (!replace_all) {
            const count = countOccurrences(oldContent, old_string);
            if (count === 0) {
                return {
                    data: { filePath, replacements: 0, oldContent, newContent: oldContent },
                    isError: true,
                };
            }
            if (count > 1) {
                return {
                    data: { filePath, replacements: 0, oldContent, newContent: oldContent },
                    isError: true,
                };
            }
        }
        const newContent = replace_all
            ? oldContent.split(old_string).join(new_string)
            : oldContent.replace(old_string, new_string);
        const replacements = replace_all
            ? countOccurrences(oldContent, old_string)
            : (newContent !== oldContent ? 1 : 0);
        await writeFile(filePath, newContent, 'utf-8');
        return {
            data: { filePath, replacements, oldContent, newContent },
        };
    },
    serializeResult(result) {
        const r = result;
        if (r.replacements === 0) {
            return `编辑失败：未找到目标字符串或存在多处匹配（${r.filePath}）`;
        }
        return `已编辑 ${r.filePath}（替换 ${r.replacements} 处）`;
    },
});
function resolvePath(filePath, cwd) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
function countOccurrences(haystack, needle) {
    if (!needle)
        return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        count++;
        pos += needle.length;
    }
    return count;
}
function preview(s, maxLen = 40) {
    const single = s.replace(/\n/g, '↵');
    return single.length > maxLen ? single.slice(0, maxLen) + '…' : single;
}
//# sourceMappingURL=edit.js.map