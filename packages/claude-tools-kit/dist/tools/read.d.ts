/**
 * FileReadTool — 文件读取工具
 * 核心逻辑提取自 claude-code FileReadTool.ts
 */
import { z } from 'zod';
declare const inputSchema: z.ZodObject<{
    file_path: z.ZodString;
    offset: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    file_path: string;
    offset?: number | undefined;
    limit?: number | undefined;
}, {
    file_path: string;
    offset?: number | undefined;
    limit?: number | undefined;
}>;
export type ReadInput = z.infer<typeof inputSchema>;
export type ReadOutput = {
    content: string;
    totalLines: number;
    truncated: boolean;
    filePath: string;
};
export declare const FileReadTool: import("../types.js").Tool<z.ZodObject<{
    file_path: z.ZodString;
    offset: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    file_path: string;
    offset?: number | undefined;
    limit?: number | undefined;
}, {
    file_path: string;
    offset?: number | undefined;
    limit?: number | undefined;
}>, {
    content: string;
    totalLines: number;
    truncated: boolean;
    filePath: string;
}>;
export {};
//# sourceMappingURL=read.d.ts.map