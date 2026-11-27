/**
 * 服务端配置（供前端读取）：当前模型、可选模型、切换模型，以及大模型服务是否在线。
 */

import type { Express } from 'express'
import { requireAuth, requireAdmin } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { setConfig } from '../db.js'
import { audit } from '../access.js'
import { isEmbeddingEnabled, getEmbeddingModel } from '../embedding.js'
import { NODE_ENV, IS_OLLAMA, OLLAMA_URL, LLM_BASE_URL, LLM_API_KEY, LLM_PROVIDER, llm } from '../config.js'

/**
 * 大模型服务是否可用（/readyz 和顶栏状态用）。Ollama 查 /api/tags；其他服务查当前模型的
 * /models/<模型名>，顺带确认模型名没填错。超时很短，避免拖慢健康检查。
 */
export async function checkLlmOnline(): Promise<boolean> {
  if (NODE_ENV === 'test') return true
  try {
    if (IS_OLLAMA) {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
      return r.ok
    }
    const r = await fetch(`${LLM_BASE_URL}/models/${encodeURIComponent(llm.model)}`, {
      headers: { Authorization: `Bearer ${LLM_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    })
    return r.ok
  } catch { return false }
}

export function registerConfigRoutes(app: Express): void {
  app.get('/api/config', async (_req, res) => {
    const llmOnline = await checkLlmOnline()
    res.json({
      model: llm.model,
      provider: LLM_PROVIDER,
      llmOnline,
      ollamaOnline: llmOnline,
      embeddingEnabled: isEmbeddingEnabled(),
      embeddingModel: getEmbeddingModel() || null,
    })
  })

  app.get('/api/config/models', requireAuth, async (_req, res) => {
    try {
      if (IS_OLLAMA) {
        const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
        if (r.ok) {
          const data = await r.json() as { models?: Array<{ name: string }> }
          const models = (data.models ?? []).map((m: { name: string }) => m.name)
          res.json({ models: models.length ? models : [llm.model], current: llm.model }); return
        }
      } else {
        const r = await fetch(`${LLM_BASE_URL}/models`, {
          headers: { Authorization: `Bearer ${LLM_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        })
        if (r.ok) {
          const data = await r.json() as { data?: Array<{ id?: string }> }
          const models = (data.data ?? []).map(m => m.id).filter((id): id is string => Boolean(id))
          res.json({ models: models.length ? models : [llm.model], current: llm.model }); return
        }
      }
      res.json({ models: [llm.model], current: llm.model })
    } catch {
      res.json({ models: [llm.model], current: llm.model })
    }
  })

  app.patch('/api/config/model', requireAdmin, (req: AuthRequest, res) => {
    const model = (req.body?.model as string | undefined)?.trim()
    if (!model) { res.status(400).json({ error: '模型名不能为空' }); return }
    llm.model = model
    setConfig('model', model)
    console.log(`模型已切换为：${llm.model}`)
    audit(req, 'config.model_update', 'config', { detail: { model: llm.model } })
    res.json({ ok: true, model: llm.model })
  })
}
