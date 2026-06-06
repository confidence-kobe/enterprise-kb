/**
 * FileWriteTool — 文件写入工具
 * 核心逻辑提取自 claude-code FileWriteTool
 */
import { z } from 'zod';
declare const inputSchema: z.ZodObject<{
    file_path: z.ZodString;
    content: z.ZodString;
}, "strip", z.ZodTypeAny, {
    content: string;
    file_path: string;
}, {
    content: string;
    file_path: string;
}>;
export type WriteInput = z.infer<typeof inputSchema>;
export type WriteOutput = {
    filePath: string;
    bytesWritten: number;
};
export declare const FileWriteTool: import("../types.js").Tool<z.ZodObject<{
    file_path: z.ZodString;
    content: z.ZodString;
}, "strip", z.ZodTypeAny, {
    content: string;
    file_path: string;
}, {
    content: string;
    file_path: string;
}>, {
    filePath: string;
    bytesWritten: number;
}>;
export {};
//# sourceMappingURL=write.d.ts.map