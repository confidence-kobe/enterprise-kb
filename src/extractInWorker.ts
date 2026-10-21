/**
 * 在独立线程中提取文档文本，避免大 PDF / Office 文件阻塞服务；
 * 同时限制单个文件的解析时间与内存，损坏或恶意构造的文件不会拖垮整个进程。
 */

import { runInWorker } from './runInWorker.js'
import type { PdfText } from './pdfText.js'

export interface ExtractOptions {
  /** 超时（毫秒），默认 120 秒 */
  timeoutMs?: number
  /** 工作线程堆内存上限（MB），默认 1024 */
  maxHeapMb?: number
}

function runExtract<T>(data: Record<string, unknown>, options: ExtractOptions, what = '文档解析'): Promise<T> {
  return runInWorker<T>('extractWorker', data, {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxHeapMb: options.maxHeapMb ?? 1024,
    messages: {
      timeout: seconds => `${what}超时（超过 ${seconds} 秒）`,
      outOfMemory: '文档过大，解析时内存不足',
      crashed: code => `${what}进程异常退出（${code}）`,
    },
  })
}

export async function extractDocumentTextInWorker(filePath: string, ext: string, options: ExtractOptions = {}): Promise<string> {
  return (await runExtract<string>({ task: 'text', filePath, ext }, options)) ?? ''
}

/** PDF 全文及每页文字 */
export function extractPdfInWorker(filePath: string, options: ExtractOptions = {}): Promise<PdfText> {
  return runExtract<PdfText>({ task: 'pdf', filePath }, options)
}

/** OCR 识别图片，或 PDF 的指定页（页码从 1 开始）；返回每张图片/每页的文字 */
export function ocrInWorker(filePath: string, kind: 'image' | 'pdf', pages: number[], options: ExtractOptions = {}): Promise<string[]> {
  return runExtract<string[]>({ task: 'ocr', filePath, kind, pages }, options, '文字识别')
}
