/**
 * 文本提取工作线程入口，回传 { result } 或 { error }。任务：
 * - text：{ filePath, ext } → 文本
 * - pdf：{ filePath } → { text, pages }（每页文字）
 * - ocr：{ filePath, kind, pages? } → 每张图片/每页识别出的文字
 */

import { parentPort, workerData } from 'node:worker_threads'
import { extractDocumentText } from './documentText.js'
import { extractPdf } from './pdfText.js'
import { ocrDocument } from './ocr.js'
import { replyFromWorker } from './runInWorker.js'

const data = workerData as {
  task?: 'text' | 'pdf' | 'ocr'
  filePath: string
  ext: string
  kind: 'image' | 'pdf'
  pages?: number[]
}

replyFromWorker(parentPort, async () => {
  switch (data.task ?? 'text') {
    case 'pdf': return extractPdf(data.filePath)
    case 'ocr': return ocrDocument(data.filePath, data.kind, data.pages)
    default: return extractDocumentText(data.filePath, data.ext)
  }
})
