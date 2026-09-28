/**
 * 模型上下文协议服务端实现 (Model Context Protocol / MCP Server)
 *
 * 核心设计与标准遵循：
 * 1. 遵循 Anthropic 提出的 MCP 标准规范，将企业知识库能力开放给任何兼容 MCP 的客户端（如 Claude Desktop、Cursor、Cline 等）；
 * 2. 双协议传输模式支持：既支持本地进程间标准输入输出 (stdio)，也支持远程基于 HTTP / SSE 的流式传输；
 * 3. 严格的多租户安全鉴权：基于 `McpContext` 判定用户对知识库的访问权限，支持通过 API Key 限定允许访问的特定知识库列表 (kbIds)；
 * 4. 工具与资源双重暴露：
 *    - Tools: `SearchDocs`（混合检索）、`ListKBDocs`（文件列表）、`ReadDoc`（文档精读）；
 *    - Resources: `kb://{kbId}/docs/{docId}`（支持通过 URI 直接载入文档内容）。
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  searchDocContent,
  getKbById,
  listDocs,
  getDocById,
  canUserAccessKb,
} from './db.js'
import { isEmbeddingEnabled, generateEmbedding } from './embedding.js'

/**
 * MCP 运行期鉴权上下文环境
 */
export interface McpContext {
  /** 发起调用的关联用户唯一标识 */
  userId: number
  /** 用户名 */
  username: string
  /** 角色：系统管理员 (admin) 或普通用户 (user) */
  role: 'admin' | 'user'
  /** 该 API Key 显式授权的知识库 ID 列表；若为空数组，则动态按用户的团队权限判定 */
  kbIds: number[]
}

/** 知识库文件在宿主机的物理根存储路径 */
const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH ?? 'storage')
/** Office 文档格式后缀集合（需要读取后台解构后的对应 .txt 文本） */
const OFFICE_EXTS  = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])
/** 文档单次读取的最大字符上限，超出时自动截断 */
const PREVIEW_MAX  = 40_000

/**
 * 校验 MCP 上下文中的用户是否拥有对指定知识库的访问权限
 *
 * 鉴权规则：
 * 1. 若当前上下文限定了 kbIds 范围且目标 kbId 不在其内，一律拒绝；
 * 2. 若用户为 admin 超级管理员，默认放行所有知识库；
 * 3. 普通用户必须是知识库创建者 (owner) 或成员 (kb_access)。
 *
 * @param ctx MCP 鉴权上下文
 * @param kbId 目标知识库 ID
 * @returns 是否有权访问
 */
function canAccessKb(ctx: McpContext, kbId: number): boolean {
  if (ctx.kbIds.length > 0 && !ctx.kbIds.includes(kbId)) return false
  if (ctx.role === 'admin') return true
  return canUserAccessKb(ctx.userId, kbId)
}

/**
 * 安全读取文档的纯文本内容
 *
 * 处理策略：
 * - 对于 PDF 及各类 Office 二进制文档，读取后台预解析生成的 `.txt` 纯文本缓存文件；
 * - 针对超大文档实施 40,000 字符硬性保护，防撑爆 MCP Client 的内存与上下文。
 *
 * @param kbId 知识库 ID
 * @param doc 包含物理文件名和原始文件名的文档信息
 * @returns 经过安全截断的文本内容
 */
function readDocContent(kbId: number, doc: { filename: string; original_name: string }): string {
  const origExt = path.extname(doc.original_name).toLowerCase()
  const kbDir   = path.join(STORAGE_PATH, `kb_${kbId}`)
  const readPath = (origExt === '.pdf' || OFFICE_EXTS.has(origExt))
    ? path.join(kbDir, doc.filename.replace(/\.[^.]+$/i, '.txt'))
    : path.join(kbDir, doc.filename)
  if (!fs.existsSync(readPath)) return '（文档内容暂不可读）'
  const raw = fs.readFileSync(readPath, 'utf-8')
  return raw.length > PREVIEW_MAX ? raw.slice(0, PREVIEW_MAX) + '\n…（内容已截断）' : raw
}

/**
 * 创建并配置 MCP Server 实例
 *
 * 注册核心能力：
 * 1. `SearchDocs`：用于全文和语义混合检索知识库段落；
 * 2. `ListKBDocs`：用于列出知识库文档清单；
 * 3. `ReadDoc`：用于阅读目标文档正文；
 * 4. 资源模板：注册 `kb://{kbId}/docs/{docId}` 资源路径，支持 Claude 等客户端将文档作为直接上下文引用。
 *
 * @param ctx 经身份验证注入的 MCP 上下文
 * @returns 配置就绪的 McpServer 实例
 */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'enterprise-kb', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {} } },
  )

  // ── Tool: SearchDocs ────────────────────────────────
  server.registerTool(
    'SearchDocs',
    {
      description: '在企业知识库中进行混合全文+语义检索，返回最相关的文档片段。支持中文，适合作为第一步定位工具。',
      inputSchema: {
        kb_id: z.number().int().describe('知识库 ID（必填）'),
        query: z.string().min(1).describe('检索关键词或自然语言问题'),
        limit: z.number().int().min(1).max(20).optional().describe('返回结果上限，默认 8，最大 20'),
      },
    },
    async ({ kb_id, query, limit }) => {
      // 访问权限校验
      if (!canAccessKb(ctx, kb_id)) {
        return { content: [{ type: 'text', text: '无权访问该知识库（kb_id=' + kb_id + '）' }], isError: true }
      }
      const kb = getKbById(kb_id)
      if (!kb) return { content: [{ type: 'text', text: '知识库不存在' }], isError: true }

      // 提取查询语义向量
      let queryEmbedding: Float32Array | undefined
      if (isEmbeddingEnabled()) {
        const emb = await generateEmbedding(query)
        if (emb) queryEmbedding = emb
      }

      // 执行全文检索 + 向量语义检索
      const results = searchDocContent(kb_id, query, Math.min(limit ?? 8, 20), queryEmbedding)
      if (!results.length) {
        return { content: [{ type: 'text', text: '未找到匹配内容，请尝试换用其他关键词' }] }
      }

      // 组装返回文本
      const text = results
        .map(r => `【${r.original_name}】（行 ${r.chunk_line}）\n${r.snippet}`)
        .join('\n\n────\n\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── Tool: ListKBDocs ────────────────────────────────
  server.registerTool(
    'ListKBDocs',
    {
      description: '列出知识库中的所有文档（文件名、大小、索引状态）。',
      inputSchema: {
        kb_id: z.number().int().describe('知识库 ID'),
      },
    },
    ({ kb_id }) => {
      if (!canAccessKb(ctx, kb_id)) {
        return { content: [{ type: 'text', text: '无权访问该知识库' }], isError: true }
      }
      const docs = listDocs(kb_id)
      if (!docs.length) return { content: [{ type: 'text', text: '该知识库暂无文档' }] }
      const lines = docs.map(d =>
        `[${d.id}] ${d.original_name}  ${(d.size / 1024).toFixed(1)} KB  状态:${d.index_status}`,
      )
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  )

  // ── Tool: ReadDoc ───────────────────────────────────
  server.registerTool(
    'ReadDoc',
    {
      description: '读取知识库中指定文档的全文内容（最多 40,000 字符）。',
      inputSchema: {
        kb_id:  z.number().int().describe('知识库 ID'),
        doc_id: z.number().int().describe('文档 ID（可由 ListKBDocs 或 SearchDocs 获取）'),
      },
    },
    ({ kb_id, doc_id }) => {
      if (!canAccessKb(ctx, kb_id)) {
        return { content: [{ type: 'text', text: '无权访问该知识库' }], isError: true }
      }
      const doc = getDocById(doc_id)
      if (!doc || doc.kb_id !== kb_id) {
        return { content: [{ type: 'text', text: '文档不存在' }], isError: true }
      }
      const content = readDocContent(kb_id, doc)
      return { content: [{ type: 'text', text: `# ${doc.original_name}\n\n${content}` }] }
    },
  )

  // ── Resources: kb://{kbId}/docs/{docId} ────────────
  server.registerResource(
    'knowledge-base-document',
    new ResourceTemplate('kb://{kbId}/docs/{docId}', { list: undefined }),
    { description: '企业知识库文档内容', mimeType: 'text/plain' },
    (uri, { kbId, docId }) => {
      const kbIdNum  = Number(kbId)
      const docIdNum = Number(docId)
      if (!canAccessKb(ctx, kbIdNum)) {
        throw new Error('无权访问该知识库')
      }
      const doc = getDocById(docIdNum)
      if (!doc || doc.kb_id !== kbIdNum) throw new Error('文档不存在')
      const content = readDocContent(kbIdNum, doc)
      return {
        contents: [{
          uri: uri.href,
          text: `# ${doc.original_name}\n\n${content}`,
          mimeType: 'text/plain',
        }],
      }
    },
  )

  return server
}
