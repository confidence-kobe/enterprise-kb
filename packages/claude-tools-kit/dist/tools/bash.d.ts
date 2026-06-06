/**
 * BashTool — Shell 命令执行工具
 * 核心逻辑提取自 claude-code BashTool.tsx
 */
import { z } from 'zod';
declare const inputSchema: z.ZodObject<{
    command: z.ZodString;
    timeout: z.ZodOptional<z.ZodNumber>;
    workingDir: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    command: string;
    timeout?: number | undefined;
    workingDir?: string | undefined;
}, {
    command: string;
    timeout?: number | undefined;
    workingDir?: string | undefined;
}>;
export type BashInput = z.infer<typeof inputSchema>;
export type BashOutput = {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
};
export declare const BashTool: import("../types.js").Tool<z.ZodObject<{
    command: z.ZodString;
    timeout: z.ZodOptional<z.ZodNumber>;
    workingDir: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    command: string;
    timeout?: number | undefined;
    workingDir?: string | undefined;
}, {
    command: string;
    timeout?: number | undefined;
    workingDir?: string | undefined;
}>, {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
}>;
export {};
//# sourceMappingURL=bash.d.ts.map