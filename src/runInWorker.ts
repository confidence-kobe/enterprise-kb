/**
 * 在独立线程中执行耗时任务（文档解析、备份），避免阻塞服务主线程；
 * 可限制执行时间与内存，任务出错或崩溃不会拖垮整个进程。
 *
 * 工作线程入口需回传 { result } 或 { error }。
 */

import { Worker } from 'node:worker_threads'

export interface RunInWorkerOptions {
  /** 超时（毫秒）；不设置则不限时 */
  timeoutMs?: number
  /** 工作线程堆内存上限（MB） */
  maxHeapMb?: number
  /** 各类失败时的提示文案 */
  messages: {
    timeout: (seconds: number) => string
    outOfMemory: string
    crashed: (exitCode: number) => string
  }
}

// 以 TypeScript 源码运行（npm run dev / 测试）时，工作线程需先注册 tsx 加载器再载入入口
const isTsSource = import.meta.url.endsWith('.ts')
const TS_BOOTSTRAP = `
  const { workerData } = await import('node:worker_threads')
  const { register } = await import('tsx/esm/api')
  register()
  await import(workerData.entry)
`

/** entryName 为 src/ 下的入口文件名（不含扩展名），如 'extractWorker' */
export function runInWorker<T>(entryName: string, data: Record<string, unknown>, options: RunInWorkerOptions): Promise<T> {
  const entry = new URL(`./${entryName}${isTsSource ? '.ts' : '.js'}`, import.meta.url)
  return new Promise((resolve, reject) => {
    const worker = new Worker(isTsSource ? TS_BOOTSTRAP : entry, {
      eval: isTsSource,
      workerData: { ...data, entry: entry.href },
      resourceLimits: options.maxHeapMb ? { maxOldGenerationSizeMb: options.maxHeapMb } : undefined,
    })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      void worker.terminate()
      fn()
    }
    const timer = options.timeoutMs
      ? setTimeout(
        () => finish(() => reject(new Error(options.messages.timeout(Math.round(options.timeoutMs! / 1000))))),
        options.timeoutMs,
      )
      : undefined
    worker.once('message', (msg: { result?: T; error?: string }) => {
      finish(() => (msg.error !== undefined ? reject(new Error(msg.error)) : resolve(msg.result as T)))
    })
    worker.once('error', err => {
      const message = (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? options.messages.outOfMemory
        : err.message
      finish(() => reject(new Error(message)))
    })
    worker.once('exit', code => finish(() => reject(new Error(options.messages.crashed(code)))))
  })
}

/** 工作线程侧：执行任务并按约定格式回传结果 */
export function replyFromWorker(port: { postMessage(msg: unknown): void } | null, task: () => Promise<unknown>): void {
  task()
    .then(result => port!.postMessage({ result }))
    .catch((err: Error) => port!.postMessage({ error: err?.message || String(err) }))
}
