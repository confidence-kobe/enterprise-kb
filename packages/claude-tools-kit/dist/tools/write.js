/**
 * FileWriteTool — 文件写入工具
 * 核心逻辑提取自 claude-code FileWriteTool
 */
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { buildTool } from '../buildTool.js';
import { isPathAllowed } from '../utils/path.js';
const inputSchema = z.object({
    file_path: z.string().describe('要写入的文件路径（绝对或相对）'),
    content: z.string().describe('要写入的完整文件内容'),
});
export const FileWriteTool = buildTool({
    name: 'Write',
    description: `将内容写入文件（覆盖已有内容）。
- 自动创建不存在的父目录
- 写入完整文件内容（不是追加）
- 如要追加内容，请先 Read 再 Write`,
    inputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    async checkPermissions(input, context) {
        const resolved = resolvePath(input.file_path, context.cwd);
        if (!isPathAllowed(resolved, context.cwd, context.allowedDirectories)) {
            return {
                behavior: 'ask',
                message: `写入文件超出工作目录范围：${resolved}`,
            };
        }
        if (context.permissionMode === 'default') {
            return {
                behavior: 'ask',
                message: `即将写入文件：${resolved}（${input.content.length} 字符）`,
            };
        }
        return { behavior: 'allow' };
    },
    async call(input, context) {
        const filePath = resolvePath(input.file_path, context.cwd);
        // 自动创建父目录
        await mkdir(path.dirname(filePath), { recursive: true });
        const buf = Buffer.from(input.content, 'utf-8');
        await writeFile(filePath, buf);
        return {
            data: { filePath, bytesWritten: buf.length },
        };
    },
    serializeResult(result) {
        const r = result;
        return `已写入 ${r.filePath}（${r.bytesWritten} 字节）`;
    },
});
function resolvePath(filePath, cwd) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}
//# sourceMappingURL=write.js.map