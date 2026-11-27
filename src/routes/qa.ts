/**
 * 问答：单个知识库的流式问答（SSE）和跨知识库联合问答。
 */

import type { Express } from 'express'
import * as path from 'node:path'
import { audit } from '../access.js'
import { requireAuth } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { HISTORY_MAX_CHARS, HISTORY_MAX_MESSAGES, LLM_API_KEY, LLM_BASE_URL, MAX_TURNS, STORAGE_PATH, llm } from '../config.js'
import { buildTrustedHistory } from '../conversationHistory.js'
import { NOT_FOUND_MARKER, canUserAccessKb, countMessages, createConversation, getConversationById, getKbById, insertMessages, listKbsForUser, listMessages, recordGapEvent, searchDocContent, touchConversation, updateConversationTitle } from '../db.js'
import { LLMExecutor } from '../executor.js'
import { kbExecutor } from '../kbExecutor.js'
import { serializeMessage } from '../messageCodec.js'
import { qaRateLimit } from '../rateLimit.js'
import type { ToolScope } from '../toolScope.js'
import { ALL_TOOLS } from '../tools.js'
import type { QAEvent } from '../tools.js'

// ── 问答路由（SSE） ───────────────────────────────────

/** 从用户首条消息生成对话标题，过滤代码块前缀和 Markdown 标记 */
function generateTitle(question: string): string {
  const cleaned = question
    .replace(/^```[\w]*\n?/m, '')
    .replace(/```[\s\S]*$/m, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*>]\s*/gm, '')
    .trim()
  const firstLine = cleaned.split('\n').map(l => l.trim()).find(l => l.length > 3) ?? cleaned
  return firstLine.slice(0, 30) + (firstLine.length > 30 ? '…' : '')
}

export function registerQaRoutes(app: Express): void {
  /**
   * 单个知识库的问答，整个系统最核心的一条路由。步骤：
   *   1. 检查权限，找到或新建对话（对话只能属于本人、本知识库）
   *   2. 从数据库取历史并裁剪（buildTrustedHistory），不使用客户端传来的历史
   *   3. 开启 SSE，大模型的每段文字、每次工具调用都实时推给浏览器
   *   4. LLMExecutor 循环"调用模型 → 执行工具 → 再调用模型"，直到模型给出最终回答
   *   5. 只有完整结束时才保存新消息、自动命名对话、记审计；用户中途关掉页面则什么都不保存
   * 回答"未找到相关内容"的问题会出现在知识缺口报告里（从对话记录里统计）。
   */
  app.post('/api/kbs/:id/ask', requireAuth, qaRateLimit, async (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }

    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }

    const { question, conversationId: convIdParam } = req.body as {
      question: string; conversationId?: number | null
    }
    if (!question?.trim()) { res.status(400).json({ error: '问题不能为空' }); return }

    // 确定 conversation
    let conv
    if (convIdParam) {
      conv = getConversationById(Number(convIdParam))
      if (!conv) { res.status(404).json({ error: '对话不存在' }); return }
      if (conv.user_id !== req.user!.userId) { res.status(403).json({ error: '无权限' }); return }
      if (conv.kb_id !== kbId) { res.status(400).json({ error: '对话不属于当前知识库' }); return }
    } else {
      conv = createConversation(req.user!.userId, kb.id)
    }

    const prevCount = countMessages(conv.id)
    const trustedHistory = buildTrustedHistory(
      listMessages(conv.id),
      HISTORY_MAX_MESSAGES,
      HISTORY_MAX_CHARS,
    )

    // SSE 头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)

    // 每 15 秒发送 SSE 注释保活，防止企业代理因空闲超时断开连接
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) }
    }, 15_000)

    // 客户端断开时中止 executor，避免后台继续消耗资源
    const abortCtrl = new AbortController()
    res.on('close', () => {
      abortCtrl.abort()
      clearInterval(keepalive)
    })

    const executor = kbExecutor(kb, (e: QAEvent) => {
      if (!abortCtrl.signal.aborted) send(e)
    })

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executor.run(question, ALL_TOOLS, trustedHistory.messages as any, abortCtrl.signal)

      // 客户端已断开时不持久化未完成的对话
      if (!abortCtrl.signal.aborted) {
        const newMsgs = (result.messages as unknown as Record<string, unknown>[]).slice(trustedHistory.messages.length)
        insertMessages(conv.id, newMsgs.map((m, i) => serializeMessage(m, prevCount + i)))
        touchConversation(conv.id)

        // 首轮对话自动命题
        if (prevCount === 0) {
          updateConversationTitle(conv.id, generateTitle(question))
        }

        send({
          type: 'done',
          turns: result.turns,
          messages: newMsgs,
          conversationId: conv.id,
          context: {
            usedMessages: trustedHistory.messages.length,
            totalMessages: trustedHistory.totalMessages,
            truncated: trustedHistory.truncated,
          },
        })

        audit(req, 'qa.ask', 'kb', {
          entityId: kbId,
          kbId,
          detail: { question: question.slice(0, 200), turns: result.turns, convId: conv.id },
        })
      }
    } catch (err) {
      if (!abortCtrl.signal.aborted) {
        send({ type: 'error', message: (err as Error).message })
      }
    } finally {
      clearInterval(keepalive)
    }

    res.end()
  })

  // ── 跨知识库联合问答（无对话历史，一次性） ──────────────────
  app.post('/api/ask', requireAuth, qaRateLimit, async (req: AuthRequest, res) => {
    const userId = req.user!.userId
    const { question } = req.body as { question: string }
    if (!question?.trim()) { res.status(400).json({ error: '问题不能为空' }); return }

    const allKbs = listKbsForUser(userId)
    if (!allKbs.length) { res.status(400).json({ error: '没有可访问的知识库' }); return }

    const RESULTS_PER_KB = 5
    const allResults = (await Promise.all(
      allKbs.map(kb => {
        try { return searchDocContent(kb.id, question, RESULTS_PER_KB) }
        catch { return [] }
      })
    )).flat()

    // 工具只能访问该用户有权限的知识库目录（listKbsForUser 已做权限过滤）
    const kbDirs = allKbs.map(kb => path.join(STORAGE_PATH, `kb_${kb.id}`))
    const kbPaths = allKbs.map((kb, i) => `· ${kb.name}: ${kbDirs[i]}`).join('\n')
    const systemPrompt = `你是企业全局知识库的问答助手，可访问以下知识库：\n${kbPaths}\n\n回答时必须标注来源文件和行号。知识库中无相关内容时，明确说明"知识库中未找到相关内容"，不要猜测。`

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) } }, 15_000)
    const abortCtrl = new AbortController()
    res.on('close', () => { abortCtrl.abort(); clearInterval(keepalive) })

    const scope: ToolScope = { cwd: kbDirs[0], allowedDirs: kbDirs, kbIds: allKbs.map(kb => kb.id) }
    const executor = new LLMExecutor({
      baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: llm.model,
      kbPath: kbDirs[0], scope, systemPrompt, maxTurns: MAX_TURNS,
      onEvent: (e: QAEvent) => { if (!abortCtrl.signal.aborted) send(e) },
    })

    try {
      const prefillContext = allResults.length
        ? `[跨库检索结果]\n${allResults.slice(0, 15).map(r => `[${r.original_name}:${r.chunk_line}] ${r.snippet}`).join('\n\n')}\n\n---\n`
        : ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executor.run(prefillContext + question, ALL_TOOLS, [] as any, abortCtrl.signal)
      if (!abortCtrl.signal.aborted) {
        send({ type: 'done', turns: result.turns, messages: result.messages, conversationId: null, context: { truncated: false } })
        audit(req, 'qa.ask_global', 'global', {
          detail: { question: question.slice(0, 200), turns: result.turns, kbCount: allKbs.length },
        })
        // 跨库提问不保存对话，"没找到"单独记一笔，计入知识空白
        if (result.response.includes(NOT_FOUND_MARKER)) {
          recordGapEvent({ kbId: null, userId, question, source: 'ai_not_found', channel: 'global' })
        }
      }
    } catch (err) {
      if (!abortCtrl.signal.aborted) send({ type: 'error', message: (err as Error).message })
    } finally {
      clearInterval(keepalive)
      res.end()
    }
  })
}
