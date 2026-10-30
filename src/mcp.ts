/**
 * MCP 服务端（Model Context Protocol，Streamable HTTP 无状态模式）
 *
 * Claude、Cursor 等 AI 客户端通过 POST /mcp 调用知识库工具，身份和权限与
 * 请求里的 API 密钥（或登录 Token）一致。只实现工具能力：
 * initialize / ping / tools/list / tools/call，每个请求独立处理，不保存会话。
 */

import type { KbSearchResult } from './tools.js'

/** 支持的协议版本，新的在前；客户端请求的版本不在其中时回复最新版本 */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<string>
}

/** 预期内的工具错误（参数不对、无权限、文档不存在），作为 isError 结果交给模型自行调整 */
export class McpToolError extends Error {}

export interface McpServerInfo {
  name: string
  title: string
  version: string
  instructions: string
}

type JsonRpcId = string | number | null

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: Record<string, unknown>
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * 处理一条 JSON-RPC 消息。通知和客户端发来的响应不需要回复，返回 null。
 */
export async function handleMcpMessage(message: unknown, info: McpServerInfo, tools: McpTool[]): Promise<object | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request')
  }
  const msg = message as JsonRpcMessage
  const id = msg.id ?? null
  if (msg.jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request')
  if (typeof msg.method !== 'string') return null
  if (msg.id === undefined) return null

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion
      const protocolVersion = typeof requested === 'string' && MCP_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSIONS[0]
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, title: info.title, version: info.version },
        instructions: info.instructions,
      })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        tools: tools.map(t => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })),
      })
    case 'tools/call': {
      const name = msg.params?.name
      const tool = tools.find(t => t.name === name)
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`)
      const rawArgs = msg.params?.arguments
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : {}
      try {
        const text = await tool.call(args)
        return rpcResult(id, { content: [{ type: 'text', text }], isError: false })
      } catch (err) {
        if (!(err instanceof McpToolError)) console.error(`[mcp] ${tool.name} 执行失败：`, err)
        const text = err instanceof McpToolError ? err.message : `执行失败：${(err as Error).message}`
        return rpcResult(id, { content: [{ type: 'text', text }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`)
  }
}

// ── 知识库工具 ────────────────────────────────────────

/** 工具需要的知识库操作；由服务端按当前用户的权限实现 */
export interface KnowledgeBaseAccess {
  listKbs(): Array<{ id: number; name: string; description: string | null; docCount: number }>
  canRead(kbId: number): boolean
  search(kbIds: number[], query: string, limit: number): Promise<KbSearchResult[]>
  /** 文档不存在或无法读取时抛出 McpToolError */
  readDoc(kbId: number, docId: number): { name: string; text: string }
  ask(kbId: number, question: string): Promise<string>
}

/** read_document 单次最多返回的字符数，避免一次塞满客户端的上下文 */
const READ_MAX_CHARS = 40_000

function requireText(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new McpToolError(`缺少参数 ${key}`)
  if (value.length > maxLength) throw new McpToolError(`参数 ${key} 最多 ${maxLength} 字`)
  return value.trim()
}

function readInt(args: Record<string, unknown>, key: string, opts: { min: number; max: number; fallback?: number }): number {
  const value = args[key] ?? opts.fallback
  if (value === undefined) throw new McpToolError(`缺少参数 ${key}`)
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new McpToolError(`参数 ${key} 必须是整数`)
  return Math.min(Math.max(n, opts.min), opts.max)
}

function requireReadableKb(kb: KnowledgeBaseAccess, args: Record<string, unknown>): number {
  const kbId = readInt(args, 'kb_id', { min: 1, max: Number.MAX_SAFE_INTEGER })
  if (!kb.canRead(kbId)) throw new McpToolError(`知识库 ${kbId} 不存在或无权访问，请先调用 list_knowledge_bases`)
  return kbId
}

/**
 * 创建 MCP 的四个知识库工具。工具不直接访问数据库，而是通过传进来的 KnowledgeBaseAccess，
 * 由 server.ts 按当前用户的权限实现。这样权限逻辑只有一份，mcp.ts 本身也不依赖数据库。
 * 工具的 description 是写给 AI 客户端看的，说明什么时候该用哪个工具。
 */
export function createKnowledgeBaseTools(kb: KnowledgeBaseAccess): McpTool[] {
  return [
    {
      name: 'list_knowledge_bases',
      title: '列出知识库',
      description: '列出当前用户可以访问的企业知识库（kb_id、名称、描述、文档数）。其他工具需要的 kb_id 从这里获得。',
      inputSchema: { type: 'object', properties: {} },
      async call() {
        const kbs = kb.listKbs()
        if (!kbs.length) return '当前账号没有可访问的知识库。'
        return kbs
          .map(k => `- kb_id=${k.id}  ${k.name}（${k.docCount} 份文档）${k.description ? `：${k.description}` : ''}`)
          .join('\n')
      },
    },
    {
      name: 'search_documents',
      title: '检索文档',
      description: [
        '在企业知识库里全文检索，返回匹配的文档片段和出处（kb_id、doc_id、行号）。',
        '片段中 >>>…<<< 标出命中的词。需要上下文时用 read_document 从对应行号开始读原文。',
        '不传 kb_id 时检索全部可访问的知识库。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词或短语，多个词用空格分隔，如「年假 天数」' },
          kb_id: { type: 'integer', description: '只在这个知识库里检索（可选）' },
          limit: { type: 'integer', description: '返回结果数，默认 10，最多 30', minimum: 1, maximum: 30 },
        },
        required: ['query'],
      },
      async call(args) {
        const query = requireText(args, 'query', 200)
        const limit = readInt(args, 'limit', { min: 1, max: 30, fallback: 10 })
        const kbs = kb.listKbs()
        const kbIds = args.kb_id === undefined ? kbs.map(k => k.id) : [requireReadableKb(kb, args)]
        if (!kbIds.length) return '当前账号没有可访问的知识库。'
        const results = await kb.search(kbIds, query, limit)
        if (!results.length) return `没有找到与「${query}」相关的内容，可以换个说法或拆成更短的关键词再试。`
        const kbNames = new Map(kbs.map(k => [k.id, k.name]))
        // 索引里的行号从 0 开始，对外统一从 1 开始，与 read_document 一致
        return results
          .map((r, i) => [
            `${i + 1}. 《${r.original_name}》 知识库：${kbNames.get(r.kb_id) ?? r.kb_id}（kb_id=${r.kb_id}, doc_id=${r.doc_id}, 第 ${r.chunk_line + 1} 行）`,
            r.snippet,
          ].join('\n'))
          .join('\n\n')
      },
    },
    {
      name: 'read_document',
      title: '读取文档',
      description: '按行读取知识库文档的原文（PDF、Word 等为提取出的文字），每行前带行号，方便引用出处。长文档可以用 start_line 分段读取。',
      inputSchema: {
        type: 'object',
        properties: {
          kb_id: { type: 'integer', description: '知识库 ID' },
          doc_id: { type: 'integer', description: '文档 ID（来自 search_documents 的结果）' },
          start_line: { type: 'integer', description: '从第几行开始，默认 1', minimum: 1 },
          max_lines: { type: 'integer', description: '最多读取多少行，默认 200，最多 1000', minimum: 1, maximum: 1000 },
        },
        required: ['kb_id', 'doc_id'],
      },
      async call(args) {
        const kbId = requireReadableKb(kb, args)
        const docId = readInt(args, 'doc_id', { min: 1, max: Number.MAX_SAFE_INTEGER })
        const start = readInt(args, 'start_line', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 })
        const maxLines = readInt(args, 'max_lines', { min: 1, max: 1000, fallback: 200 })
        const doc = kb.readDoc(kbId, docId)
        const lines = doc.text.split(/\r?\n/)
        if (start > lines.length) throw new McpToolError(`《${doc.name}》只有 ${lines.length} 行`)

        const out: string[] = []
        let chars = 0
        let end = start - 1
        while (end < lines.length && out.length < maxLines) {
          const line = `${end + 1}\t${lines[end]}`
          if (out.length && chars + line.length > READ_MAX_CHARS) break
          out.push(line)
          chars += line.length + 1
          end++
        }
        const header = `《${doc.name}》第 ${start}–${end} 行（共 ${lines.length} 行）`
        const more = end < lines.length ? `\n\n还有更多内容，可用 start_line=${end + 1} 继续读取。` : ''
        return `${header}\n\n${out.join('\n')}${more}`
      },
    },
    {
      name: 'ask_knowledge_base',
      title: '向知识库提问',
      description: [
        '让知识库内置的 AI 检索资料并回答问题，返回带出处的答案。通常需要几十秒。',
        '如果你能自己检索和阅读，优先用 search_documents 和 read_document，结果更可控。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          kb_id: { type: 'integer', description: '知识库 ID' },
          question: { type: 'string', description: '要问的问题，用完整的一句话' },
        },
        required: ['kb_id', 'question'],
      },
      async call(args) {
        const kbId = requireReadableKb(kb, args)
        const question = requireText(args, 'question', 2000)
        return kb.ask(kbId, question)
      },
    },
  ]
}
