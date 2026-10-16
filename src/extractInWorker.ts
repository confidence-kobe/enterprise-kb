/**
 * 在独立线程中提取文档文本，避免大 PDF / Office 文件阻塞服务；
 * 同时限制单个文件的解析时间与内存，损坏或恶意构造的文件不会拖垮整个进程。
 */

import { Worker } from 'node:worker_threads'

export interface ExtractOptions {
  /** 超时（毫秒），默认 120 秒 */
  timeoutMs?: number
  /** 工作线程堆内存上限（MB），默认 1024 */
  maxHeapMb?: number
}

// 以 TypeScript 源码运行（npm run dev / 测试）时，工作线程需先注册 tsx 加载器再载入入口
const isTsSource = import.meta.url.endsWith('.ts')
const workerEntry = new URL(isTsSource ? './extractWorker.ts' : './extractWorker.js', import.meta.url)
const TS_BOOTSTRAP = `
  const { workerData } = await import('node:worker_threads')
  const { register } = await import('tsx/esm/api')
  register()
  await import(workerData.entry)
`

export function extractDocumentTextInWorker(filePath: string, ext: string, options: ExtractOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000
  return new Promise((resolve, reject) => {
    const workerData = { filePath, ext, entry: workerEntry.href }
    const worker = new Worker(isTsSource ? TS_BOOTSTRAP : workerEntry, {
      eval: isTsSource,
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb ?? 1024 },
    })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`文档解析超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`))),
      timeoutMs,
    )
    worker.once('message', (msg: { text?: string; error?: string }) => {
      finish(() => (msg.error !== undefined ? reject(new Error(msg.error)) : resolve(msg.text ?? '')))
    })
    worker.once('error', err => {
      const message = (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? '文档过大，解析时内存不足'
        : err.message
      finish(() => reject(new Error(message)))
    })
    worker.once('exit', code => finish(() => reject(new Error(`文档解析进程异常退出（${code}）`))))
  })
}
