/**
 * GlobTool — 文件名模式匹配工具
 * 核心逻辑提取自 claude-code GlobTool.ts
 */
import { z } from 'zod';
declare const inputSchema: z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    pattern: string;
    path?: string | undefined;
}, {
    pattern: string;
    path?: string | undefined;
}>;
export type GlobInput = z.infer<typeof inputSchema>;
export type GlobOutput = {
    filenames: string[];
    numFiles: number;
    truncated: boolean;
    durationMs: number;
};
export declare const GlobTool: import("../types.js").Tool<z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    pattern: string;
    path?: string | undefined;
}, {
    pattern: string;
    path?: string | undefined;
}>, {
    filenames: string[];
    numFiles: number;
    truncated: boolean;
    durationMs: number;
}>;
export {};
//# sourceMappingURL=glob.d.ts.map