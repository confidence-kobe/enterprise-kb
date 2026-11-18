/**
 * 单个知识库的问答执行器：工具只能读取该知识库目录。
 */

import * as path from 'node:path'
import { LLM_API_KEY, LLM_BASE_URL, MAX_TURNS, STORAGE_PATH, llm } from './config.js'
import { scopeForKbPath } from './tools.js'
import type { KnowledgeBase } from './db.js'
import { LLMExecutor } from './executor.js'
import { buildSystemPrompt } from './prompt.js'
import type { QAEvent } from './tools.js'

/** 单个知识库的问答执行器：工具只能读取该知识库目录 */
export function kbExecutor(kb: KnowledgeBase, onEvent: (e: QAEvent) => void): LLMExecutor {
  const kbPath = path.join(STORAGE_PATH, `kb_${kb.id}`)
  return new LLMExecutor({
    baseUrl:      LLM_BASE_URL,
    apiKey:       LLM_API_KEY,
    model:        llm.model,
    kbPath,
    scope:        scopeForKbPath(kbPath, kb.id),
    systemPrompt: buildSystemPrompt(kb.name, kbPath, kb.system_prompt),
    maxTurns:     MAX_TURNS,
    onEvent,
  })
}
