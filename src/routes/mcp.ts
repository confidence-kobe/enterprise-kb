/**
 * MCP 服务（Model Context Protocol）：让 AI 工具（Claude Code、Cursor 等）检索和提问知识库。
 */

import type { Express, Request, Response } from 'express'
import * as fs from 'node:fs'
import { audit } from '../access.js'
import { requireAuth } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { APP_VERSION } from '../config.js'
import { NOT_FOUND_MARKER, canUserAccessKb, countDocs, getAllKbs, getDocById, getKbById, listKbsForUser, recordGapEvent } from '../db.js'
import { docTextFile } from '../documentStore.js'
import { TEXT_PREVIEWABLE_EXTS } from '../fileTypes.js'
import { kbExecutor } from '../kbExecutor.js'
import { MCP_PROTOCOL_VERSIONS, McpToolError, createKnowledgeBaseTools, handleMcpMessage } from '../mcp.js'
import { takeQaQuota } from '../rateLimit.js'
import { ALL_TOOLS, searchAcrossKbs } from '../tools.js'
import { corsOrigins } from '../config.js'

// ── MCP 服务（Model Context Protocol） ─────────────────────

const MCP_INFO = {
  name: 'enterprise-kb',
  title: '企业知识库',
  version: APP_VERSION,
  instructions: [
    '这是企业内部知识库。回答公司制度、流程、产品资料等问题时，先用 search_documents 检索，',
    '再用 read_document 阅读原文核实，引用时注明文档名和行号。知识库里没有的内容要明确说明，不要猜测。',
  ].join(''),
}

const MCP_READ_MAX_BYTES = 20 * 1024 * 1024

/** 防 DNS 重绑定：浏览器发来的请求必须来自本站或 CORS_ORIGIN 白名单；命令行和桌面客户端不带 Origin */
function isAllowedMcpOrigin(req: Request): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (corsOrigins.includes(origin)) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function mcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set('Allow', 'POST').json({ error: 'MCP 接口只接受 POST 请求' })
}

export function registerMcpRoutes(app: Express): void {
  app.get('/mcp', mcpMethodNotAllowed)

  app.delete('/mcp', mcpMethodNotAllowed)

  app.post('/mcp', (req, res, next) => {
    if (!isAllowedMcpOrigin(req)) { res.status(403).json({ error: '不允许的来源' }); return }
    const version = req.headers['mcp-protocol-version']
    if (typeof version === 'string' && !MCP_PROTOCOL_VERSIONS.includes(version)) {
      res.status(400).json({ error: `不支持的 MCP 协议版本：${version}` }); return
    }
    if (!req.headers.authorization) {
      res.status(401).set('WWW-Authenticate', 'Bearer realm="enterprise-kb"')
        .json({ error: '请在请求头中提供 Authorization: Bearer <API 密钥>' })
      return
    }
    next()
  }, requireAuth, async (req: AuthRequest, res) => {
    const user = req.user!
    const abortCtrl = new AbortController()
    res.on('close', () => abortCtrl.abort())
    const canRead = (kbId: number) => user.role === 'admin' ? Boolean(getKbById(kbId)) : canUserAccessKb(user.userId, kbId)

    const tools = createKnowledgeBaseTools({
      listKbs: () => (user.role === 'admin' ? getAllKbs() : listKbsForUser(user.userId))
        .map(kb => ({ id: kb.id, name: kb.name, description: kb.description, docCount: countDocs(kb.id) })),
      canRead,
      search: async (kbIds, query, limit) => {
        const results = await searchAcrossKbs(kbIds, query, limit)
        // AI 助手检索不到内容，说明知识库可能缺这部分资料
        if (!results.length) {
          recordGapEvent({ kbId: kbIds.length === 1 ? kbIds[0] : null, userId: user.userId, question: query, source: 'search_empty', channel: 'mcp' })
        }
        return results
      },
      readDoc: (kbId, docId) => {
        const doc = getDocById(docId)
        if (!doc || doc.kb_id !== kbId) throw new McpToolError(`知识库 ${kbId} 中没有 doc_id=${docId} 的文档`)
        const { readPath, displayExt, extracted } = docTextFile(kbId, doc)
        if (!TEXT_PREVIEWABLE_EXTS.has(displayExt)) throw new McpToolError(`《${doc.original_name}》不是文本类文档，无法读取`)
        if (!fs.existsSync(readPath)) {
          throw new McpToolError(extracted ? `《${doc.original_name}》的文字还在提取中或提取失败` : `《${doc.original_name}》的文件不存在`)
        }
        if (fs.statSync(readPath).size > MCP_READ_MAX_BYTES) throw new McpToolError(`《${doc.original_name}》太大，请用 search_documents 定位后再读`)
        return { name: doc.original_name, text: fs.readFileSync(readPath, 'utf-8') }
      },
      ask: async (kbId, question) => {
        if (!takeQaQuota(user.userId)) throw new McpToolError('提问过于频繁，请稍后再试')
        const kb = getKbById(kbId)!
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await kbExecutor(kb, () => {}).run(question, ALL_TOOLS, [] as any, abortCtrl.signal)
        audit(req, 'qa.ask', 'kb', {
          entityId: kbId, kbId, detail: { question: question.slice(0, 200), turns: result.turns, channel: 'mcp' },
        })
        if (result.response.includes(NOT_FOUND_MARKER)) {
          recordGapEvent({ kbId, userId: user.userId, question, source: 'ai_not_found', channel: 'mcp' })
        }
        return result.response.trim() || '（模型没有给出回答）'
      },
    })

    const body = req.body as unknown
    const messages = Array.isArray(body) ? body : [body]
    const replies = (await Promise.all(messages.map(m => handleMcpMessage(m, MCP_INFO, tools)))).filter(Boolean)
    if (!replies.length) { res.status(202).end(); return }
    res.json(Array.isArray(body) ? replies : replies[0])
  })
}
