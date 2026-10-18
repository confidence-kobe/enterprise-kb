/**
 * 文本提取工作线程入口：接收 { filePath, ext }，回传 { result: 文本 } 或 { error }
 */

import { parentPort, workerData } from 'node:worker_threads'
import { extractDocumentText } from './documentText.js'
import { replyFromWorker } from './runInWorker.js'

const { filePath, ext } = workerData as { filePath: string; ext: string }

replyFromWorker(parentPort, () => extractDocumentText(filePath, ext))
