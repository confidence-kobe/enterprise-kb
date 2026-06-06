/**
 * WebFetchTool — 网页内容获取工具
 * 核心逻辑提取自 claude-code WebFetchTool.ts
 */
import { z } from 'zod';
import { buildTool } from '../buildTool.js';
const MAX_CONTENT_LENGTH = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const inputSchema = z.object({
    url: z.string().url().describe('要获取的 URL（必须是合法 http/https 地址）'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().describe('HTTP 方法（默认 GET）'),
    headers: z.record(z.string(), z.string()).optional().describe('自定义请求头（如 {"Authorization": "Bearer token"}）'),
    body: z.string().optional().describe('POST/PUT 请求体（字符串格式）'),
});
export const WebFetchTool = buildTool({
    name: 'WebFetch',
    description: `获取网页或 API 内容。
- 返回响应体文本（HTML/JSON/纯文本）
- 超长内容自动截断（最多 ${MAX_CONTENT_LENGTH} 字符）
- 支持自定义请求头和请求体`,
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    async call(input, context) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        // 合并外部 signal
        if (context.signal) {
            context.signal.addEventListener('abort', () => controller.abort());
        }
        try {
            const response = await fetch(input.url, {
                method: input.method ?? 'GET',
                headers: {
                    'User-Agent': 'claude-tools-kit/1.0',
                    ...input.headers,
                },
                body: input.body,
                signal: controller.signal,
            });
            const text = await response.text();
            const contentType = response.headers.get('content-type') ?? 'text/plain';
            const truncated = text.length > MAX_CONTENT_LENGTH;
            return {
                data: {
                    url: input.url,
                    statusCode: response.status,
                    contentType,
                    content: truncated ? text.slice(0, MAX_CONTENT_LENGTH) + '\n... [内容已截断]' : text,
                    truncated,
                },
                isError: response.status >= 400,
            };
        }
        catch (err) {
            const e = err;
            const isTimeout = e.name === 'AbortError';
            return {
                data: {
                    url: input.url,
                    statusCode: 0,
                    contentType: '',
                    content: isTimeout ? `请求超时（>${DEFAULT_TIMEOUT_MS}ms）` : `请求失败：${e.message}`,
                    truncated: false,
                },
                isError: true,
            };
        }
        finally {
            clearTimeout(timer);
        }
    },
    serializeResult(result) {
        const r = result;
        const status = r.statusCode ? `HTTP ${r.statusCode}` : '连接失败';
        const type = r.contentType ? ` [${r.contentType.split(';')[0]}]` : '';
        const trunc = r.truncated ? '（已截断）' : '';
        return `${status}${type}${trunc}\n${r.content}`;
    },
});
//# sourceMappingURL=webfetch.js.map