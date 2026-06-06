/**
 * FileEditTool — 文件精确编辑工具（字符串替换）
 * 核心逻辑提取自 claude-code FileEditTool
 */
import { z } from 'zod';
declare const inputSchema: z.ZodObject<{
    file_path: z.ZodString;
    old_string: z.ZodString;
    new_string: z.ZodString;
    replace_all: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean | undefined;
}, {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean | undefined;
}>;
export type EditInput = z.infer<typeof inputSchema>;
export type EditOutput = {
    filePath: string;
    replacements: number;
    oldContent: string;
    newContent: string;
};
export declare const FileEditTool: import("../types.js").Tool<z.ZodObject<{
    file_path: z.ZodString;
    old_string: z.ZodString;
    new_string: z.ZodString;
    replace_all: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean | undefined;
}, {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean | undefined;
}>, {
    filePath: string;
    replacements: number;
    oldContent: string;
    newContent: string;
}>;
export {};
//# sourceMappingURL=edit.d.ts.map