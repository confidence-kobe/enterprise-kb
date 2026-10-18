/**
 * 在独立线程中提取文档文本，避免大 PDF / Office 文件阻塞服务；
 * 同时限制单个文件的解析时间与内存，损坏或恶意构造的文件不会拖垮整个进程。
 */

import { runInWorker } from './runInWorker.js'

export interface ExtractOptions {
  /** 超时（毫秒），默认 120 秒 */
  timeoutMs?: number
  /** 工作线程堆内存上限（MB），默认 1024 */
  maxHeapMb?: number
}

export async function extractDocumentTextInWorker(filePath: string, ext: string, options: ExtractOptions = {}): Promise<string> {
  const text = await runInWorker<string>('extractWorker', { filePath, ext }, {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxHeapMb: options.maxHeapMb ?? 1024,
    messages: {
      timeout: seconds => `文档解析超时（超过 ${seconds} 秒）`,
      outOfMemory: '文档过大，解析时内存不足',
      crashed: code => `文档解析进程异常退出（${code}）`,
    },
  })
  return text ?? ''
}
