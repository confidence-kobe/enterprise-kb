/**
 * Embedding 模块 — 调用 OpenAI 兼容的 /embeddings 接口
 * 若未配置 EMBEDDING_MODEL 则所有函数为空操作，向量搜索自动降级为纯 FTS5
 */

const EMBEDDING_BASE_URL = (process.env.EMBEDDING_BASE_URL?.trim() || process.env.LLM_BASE_URL?.trim() || '').replace(/\/+$/, '')
const EMBEDDING_API_KEY  = process.env.EMBEDDING_API_KEY?.trim()  || process.env.LLM_API_KEY?.trim()  || ''
const EMBEDDING_MODEL    = process.env.EMBEDDING_MODEL?.trim()    || ''
const BATCH_SIZE         = 32   // 每次 API 调用最多多少个文本

export function isEmbeddingEnabled(): boolean {
  return Boolean(EMBEDDING_MODEL && EMBEDDING_BASE_URL)
}

export function getEmbeddingModel(): string {
  return EMBEDDING_MODEL
}

/** 批量生成向量，一次 API 调用，保持输入顺序 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[] | null> {
  if (!isEmbeddingEnabled() || !texts.length) return null
  try {
    const response = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts.map(t => t.slice(0, 4000)),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      console.warn(`[embedding] API 返回 ${response.status}`)
      return null
    }
    const data = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> }
    if (!data.data?.length) return null
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return sorted.map(item => new Float32Array(item.embedding ?? []))
  } catch (err) {
    console.warn('[embedding] 向量生成失败:', (err as Error).message)
    return null
  }
}

/** 单条文本生成向量 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  const results = await generateEmbeddings([text])
  return results?.[0] ?? null
}

/** 对文档所有 chunk 批量生成向量（分批避免超时） */
export async function embedChunks(
  chunks: Array<{ content: string; startLine: number }>,
): Promise<Array<{ chunkLine: number; embedding: Float32Array }>> {
  const results: Array<{ chunkLine: number; embedding: Float32Array }> = []
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)
    const embeddings = await generateEmbeddings(batch.map(c => c.content))
    if (!embeddings) continue
    for (let j = 0; j < embeddings.length; j++) {
      if (embeddings[j].length > 0) {
        results.push({ chunkLine: batch[j].startLine, embedding: embeddings[j] })
      }
    }
  }
  return results
}
