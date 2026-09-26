/**
 * 文本向量化模块 (Embedding Module)
 *
 * 核心功能：
 * 1. 对接 OpenAI 兼容的 `/embeddings` 接口，支持本地部署模型（如 Ollama、Text-Embeddings-Inference、vLLM）或商业云 API；
 * 2. 自动降级与容错设计：若系统未配置 `EMBEDDING_MODEL` 或 `EMBEDDING_BASE_URL`，向量生成自动短路返回 null，
 *    上层知识库检索系统无缝降级为纯 SQLite FTS5 全文检索；
 * 3. 性能优化与批处理：单次批量请求最多 32 个文本块，设置 30s 超时控制，自动维持返回向量的顺序一致性；
 * 4. 浮点序列化：将返回的向量转换为高精度紧凑的 `Float32Array`，方便直接存入 SQLite BLOB 字段。
 */

/** 向量模型服务基础地址，优先读取 EMBEDDING_BASE_URL，回退到 LLM_BASE_URL，去除末尾斜杠 */
const EMBEDDING_BASE_URL = (process.env.EMBEDDING_BASE_URL?.trim() || process.env.LLM_BASE_URL?.trim() || '').replace(/\/+$/, '')
/** 向量模型 API 密钥 */
const EMBEDDING_API_KEY  = process.env.EMBEDDING_API_KEY?.trim()  || process.env.LLM_API_KEY?.trim()  || ''
/** 向量模型名称（如 text-embedding-3-small, bge-m3 等），未配置时停用向量检索 */
const EMBEDDING_MODEL    = process.env.EMBEDDING_MODEL?.trim()    || ''
/** 单次 API 请求并发切片上限，避免请求体过大或网关超时 */
const BATCH_SIZE         = 32

/**
 * 判断当前系统是否启用了向量 Embedding 功能
 *
 * @returns 当且仅当同时配置了 EMBEDDING_MODEL 与 EMBEDDING_BASE_URL 时返回 true
 */
export function isEmbeddingEnabled(): boolean {
  return Boolean(EMBEDDING_MODEL && EMBEDDING_BASE_URL)
}

/**
 * 获取当前配置的向量模型名称
 *
 * @returns 向量模型名称字符串
 */
export function getEmbeddingModel(): string {
  return EMBEDDING_MODEL
}

/**
 * 批量生成文本向量 (generateEmbeddings)
 *
 * 发送单次 POST /embeddings HTTP 请求：
 * 1. 自动对单条输入截断至 4,000 字符，防止超出 Embedding 模型的最大 Token 限制；
 * 2. 根据响应体中的 `index` 字段严格重新排序，确保输出数组与输入文本数组一一对应；
 * 3. 将原始 number[] 数组转换为高效紧凑的 Float32Array。
 *
 * @param texts 待向量化的文本字符串数组
 * @returns 对应文本顺序的 Float32Array 向量数组；若未启用或调用出错则返回 null
 */
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
      signal: AbortSignal.timeout(30_000), // 30秒请求超时控制
    })
    if (!response.ok) {
      console.warn(`[embedding] API 返回 ${response.status}`)
      return null
    }
    const data = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> }
    if (!data.data?.length) return null
    // 按原始输入 index 严格排序，避免部分服务并发乱序返回
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return sorted.map(item => new Float32Array(item.embedding ?? []))
  } catch (err) {
    console.warn('[embedding] 向量生成失败:', (err as Error).message)
    return null
  }
}

/**
 * 生成单条文本的向量表示
 *
 * @param text 待向量化的文本内容
 * @returns Float32Array 向量；未启用或失败时返回 null
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  const results = await generateEmbeddings([text])
  return results?.[0] ?? null
}

/**
 * 对文档的所有切片 (Chunks) 进行分批向量化处理
 *
 * 处理逻辑：
 * - 按照 BATCH_SIZE (32条) 划分批次逐批请求；
 * - 将生成的向量与其在源文档中的物理行号 chunkLine 绑定；
 * - 供后台索引持久化到 SQLite `doc_chunk_vectors` 表中。
 *
 * @param chunks 包含文本内容与起始行号的切片数组
 * @returns 包含行号与向量的切片结果列表
 */
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
