/**
 * GrepTool — 文件内容搜索工具
 * 核心逻辑提取自 claude-code GrepTool.ts（使用 Node.js 原生实现，无需 ripgrep）
 */
import { z } from 'zod';
declare const inputSchema: z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    glob: z.ZodOptional<z.ZodString>;
    output_mode: z.ZodOptional<z.ZodEnum<["content", "files_with_matches", "count"]>>;
    '-A': z.ZodOptional<z.ZodNumber>;
    '-B': z.ZodOptional<z.ZodNumber>;
    '-i': z.ZodOptional<z.ZodBoolean>;
    head_limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    pattern: string;
    path?: string | undefined;
    glob?: string | undefined;
    output_mode?: "content" | "files_with_matches" | "count" | undefined;
    '-A'?: number | undefined;
    '-B'?: number | undefined;
    '-i'?: boolean | undefined;
    head_limit?: number | undefined;
}, {
    pattern: string;
    path?: string | undefined;
    glob?: string | undefined;
    output_mode?: "content" | "files_with_matches" | "count" | undefined;
    '-A'?: number | undefined;
    '-B'?: number | undefined;
    '-i'?: boolean | undefined;
    head_limit?: number | undefined;
}>;
export type GrepInput = z.infer<typeof inputSchema>;
export type GrepOutput = {
    mode: 'content' | 'files_with_matches' | 'count';
    results: string[];
    total: number;
    truncated: boolean;
    durationMs: number;
};
export declare const GrepTool: import("../types.js").Tool<z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    glob: z.ZodOptional<z.ZodString>;
    output_mode: z.ZodOptional<z.ZodEnum<["content", "files_with_matches", "count"]>>;
    '-A': z.ZodOptional<z.ZodNumber>;
    '-B': z.ZodOptional<z.ZodNumber>;
    '-i': z.ZodOptional<z.ZodBoolean>;
    head_limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    pattern: string;
    path?: string | undefined;
    glob?: string | undefined;
    output_mode?: "content" | "files_with_matches" | "count" | undefined;
    '-A'?: number | undefined;
    '-B'?: number | undefined;
    '-i'?: boolean | undefined;
    head_limit?: number | undefined;
}, {
    pattern: string;
    path?: string | undefined;
    glob?: string | undefined;
    output_mode?: "content" | "files_with_matches" | "count" | undefined;
    '-A'?: number | undefined;
    '-B'?: number | undefined;
    '-i'?: boolean | undefined;
    head_limit?: number | undefined;
}>, {
    mode: string;
    results: string[];
    total: number;
    truncated: boolean;
    durationMs: number;
}>;
export {};
//# sourceMappingURL=grep.d.ts.map