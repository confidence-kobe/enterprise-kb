/**
 * WebFetchTool — 网页内容获取工具
 * 核心逻辑提取自 claude-code WebFetchTool.ts
 */
import { z } from 'zod';
declare const inputSchema: z.ZodObject<{
    url: z.ZodString;
    method: z.ZodOptional<z.ZodEnum<["GET", "POST", "PUT", "DELETE", "PATCH"]>>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    body: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
}, {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
}>;
export type WebFetchInput = z.infer<typeof inputSchema>;
export type WebFetchOutput = {
    url: string;
    statusCode: number;
    contentType: string;
    content: string;
    truncated: boolean;
};
export declare const WebFetchTool: import("../types.js").Tool<z.ZodObject<{
    url: z.ZodString;
    method: z.ZodOptional<z.ZodEnum<["GET", "POST", "PUT", "DELETE", "PATCH"]>>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    body: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
}, {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
}>, {
    url: string;
    statusCode: number;
    contentType: string;
    content: string;
    truncated: boolean;
}>;
export {};
//# sourceMappingURL=webfetch.d.ts.map