/**
 * 文本提取工作线程入口：接收 { filePath, ext }，回传 { text } 或 { error }
 */

import { parentPort, workerData } from 'node:worker_threads'
import { extractDocumentText } from './documentText.js'

const { filePath, ext } = workerData as { filePath: string; ext: string }

extractDocumentText(filePath, ext)
  .then(text => parentPort!.postMessage({ text }))
  .catch((err: Error) => parentPort!.postMessage({ error: err?.message || String(err) }))
