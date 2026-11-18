/**
 * 后台索引队列与 OCR 队列。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { llm, LLM_BASE_URL, LLM_API_KEY } from './config.js'
import { getDocById, indexDocContentInBatches, removeDocFromIndex, storeChunkVectors, updateDocIndexStatus, updateDocOcrPages, updateDocSummary } from './db.js'
import { chunkDocument } from './documentChunker.js'
import { BINARY_DOCUMENT_EXTS } from './documentText.js'
import { embedChunks, isEmbeddingEnabled } from './embedding.js'
import { extractDocumentTextInWorker, extractPdfInWorker, ocrInWorker } from './extractInWorker.js'
import { EXTRACT_TIMEOUT_MS, OCR_ENABLED, OCR_MAX_PAGES, OCR_PAGE_TIMEOUT_MS } from './fileTypes.js'
import { OCR_IMAGE_EXTS, isScannedPageText } from './ocr.js'

//
// 上传只负责把文件写到磁盘、在数据库里记一条 pending 的文档，马上返回；
// 解析、分块、建索引放进下面的队列，在后台一份一份地做：
//
//   enqueueDocIndex → drainDocIndexQueue → processDocIndexJob
//                                           ├─ 文本文件：直接读
//                                           ├─ PDF / Office：在工作线程里提取文字
//                                           └─ 扫描页 / 图片：交给 OCR 队列（enqueueOcr）
//                                         → finishDocIndex：写索引、生成向量和摘要
//
// 队列一次只处理一份，是有意为之：解析很吃 CPU 和内存，并发处理会拖慢正在进行的问答。
// 队列在内存里，服务重启会丢失；启动时 reindexExistingDocs() 会把还没有索引的文档
// （包括上次失败的）重新排队，所以重启不会让文档永远停在"解析中"。

interface DocIndexJob {
  docId: number
  kbId: number
  originalName: string
  filePath: string
}

const docIndexQueue: DocIndexJob[] = []
let docIndexWorkerRunning = false

function ocrTimeoutMs(pages: number): number {
  return EXTRACT_TIMEOUT_MS + pages * OCR_PAGE_TIMEOUT_MS
}

/**
 * 需要 OCR 的文档在单独的队列里识别：识别一份长扫描件要几分钟，
 * 不能让后面上传的普通文档跟着一起等。
 */
interface OcrJob extends DocIndexJob {
  kind: 'image' | 'pdf'
  /** 要识别的页码（从 1 开始）；图片为空 */
  pages: number[]
  /** PDF 每页已有的文字，识别结果替换其中的扫描页 */
  pdfPages: string[]
  /** 扫描页总数（可能多于 OCR_MAX_PAGES） */
  scannedTotal: number
}

const ocrQueue: Array<{ job: OcrJob; done: () => void }> = []
let ocrWorkerRunning = false

/** 加入 OCR 队列；返回的 Promise 在这份文档识别完成（或失败）后结束，重建索引的接口会等它 */
function enqueueOcr(job: OcrJob): Promise<void> {
  return new Promise(resolve => {
    ocrQueue.push({ job, done: resolve })
    void drainOcrQueue()
  })
}

/** 依次处理 OCR 队列；ocrWorkerRunning 保证同一时间只有一个循环在跑 */
async function drainOcrQueue(): Promise<void> {
  if (ocrWorkerRunning) return
  ocrWorkerRunning = true
  try {
    while (ocrQueue.length) {
      const { job, done } = ocrQueue.shift()!
      await processOcrJob(job)
      done()
    }
  } finally {
    ocrWorkerRunning = false
  }
}

/** 识别一份文档。PDF 只识别扫描页，识别结果替换回对应页，其余页保留原有文字 */
async function processOcrJob(job: OcrJob): Promise<void> {
  // 排队期间文档可能已被删除
  if (!getDocById(job.docId)) return
  try {
    let text: string
    let ocrPages: number
    if (job.kind === 'image') {
      const [result] = await ocrInWorker(job.filePath, 'image', [], { timeoutMs: ocrTimeoutMs(1) })
      if (!result?.trim()) throw new Error('图片中没有识别到文字')
      text = result
      ocrPages = 1
    } else {
      const texts = await ocrInWorker(job.filePath, 'pdf', job.pages, { timeoutMs: ocrTimeoutMs(job.pages.length) })
      const merged = [...job.pdfPages]
      job.pages.forEach((num, i) => { if (texts[i]?.trim()) merged[num - 1] = texts[i] })
      if (job.scannedTotal > job.pages.length) {
        console.warn(`[ocr] ${job.originalName} 有 ${job.scannedTotal} 页扫描页，只识别了前 ${job.pages.length} 页（OCR_MAX_PAGES）`)
      }
      text = merged.join('\n\n')
      ocrPages = texts.filter(t => t.trim()).length
    }
    await finishDocIndex(job, text, ocrPages, true)
  } catch (err) {
    markDocIndexFailed(job, err)
  }
}

/** 写出提取的文字（extracted 时存为同名 .txt）并建立索引、向量和摘要 */
async function finishDocIndex(job: DocIndexJob, text: string, ocrPages: number, extracted: boolean): Promise<void> {
  if (!text.trim()) {
    throw new Error(OCR_ENABLED ? '文档没有可索引文本' : '文档没有可索引文本（可能是扫描件，服务器关闭了 OCR）')
  }
  const indexPath = extracted ? job.filePath.replace(/\.[^.]+$/i, '.txt') : job.filePath
  if (extracted) fs.writeFileSync(indexPath, text, 'utf-8')
  updateDocOcrPages(job.docId, ocrPages || null)
  await indexDocContentInBatches(job.docId, job.kbId, job.originalName, indexPath, text)

  if (isEmbeddingEnabled()) {
    void generateAndStoreEmbeddings(job.docId, job.kbId, job.originalName, indexPath, text)
  }
  void generateDocSummary(job.docId, job.originalName, text)
}

/** 标记索引失败：清掉可能已写入一半的索引，错误信息存进数据库，文档列表里会显示 */
function markDocIndexFailed(job: DocIndexJob, err: unknown): void {
  removeDocFromIndex(job.docId)
  const message = (err as Error).message || '索引失败'
  updateDocIndexStatus(job.docId, 'error', message.slice(0, 500))
  console.warn(`[index] 文档解析失败 ${job.originalName}: ${message}`)
}

/**
 * 解析文档并建立索引。需要 OCR 时交给识别队列，返回的 ocr 在识别完成后结束；
 * 解析队列不等它，直接处理下一份文档。
 */
export async function processDocIndexJob(job: DocIndexJob): Promise<{ ocr?: Promise<void> }> {
  if (!getDocById(job.docId)) return {}
  updateDocIndexStatus(job.docId, 'processing')
  const ext = path.extname(job.originalName).toLowerCase()

  try {
    if (OCR_IMAGE_EXTS.has(ext)) {
      if (!OCR_ENABLED) throw new Error('图片需要文字识别，但服务器关闭了 OCR（OCR_ENABLED=false）')
      return { ocr: enqueueOcr({ ...job, kind: 'image', pages: [], pdfPages: [], scannedTotal: 1 }) }
    }
    if (ext === '.pdf') {
      // 先提取文字层，文字太少的页（扫描页）再识别
      const pdf = await extractPdfInWorker(job.filePath, { timeoutMs: EXTRACT_TIMEOUT_MS })
      const scanned = pdf.pages.flatMap((text, i) => (isScannedPageText(text) ? [i + 1] : []))
      if (OCR_ENABLED && scanned.length) {
        return {
          ocr: enqueueOcr({
            ...job, kind: 'pdf', pages: scanned.slice(0, OCR_MAX_PAGES), pdfPages: pdf.pages, scannedTotal: scanned.length,
          }),
        }
      }
      await finishDocIndex(job, pdf.text, 0, true)
    } else if (BINARY_DOCUMENT_EXTS.has(ext)) {
      await finishDocIndex(job, await extractDocumentTextInWorker(job.filePath, ext, { timeoutMs: EXTRACT_TIMEOUT_MS }), 0, true)
    } else {
      await finishDocIndex(job, fs.readFileSync(job.filePath, 'utf-8'), 0, false)
    }
  } catch (err) {
    markDocIndexFailed(job, err)
  }
  return {}
}

/** 生成分块向量（只在配置了 EMBEDDING_MODEL 时调用）。失败只记日志，全文检索照常可用 */
export async function generateAndStoreEmbeddings(
  docId: number,
  kbId: number,
  originalName: string,
  filePath: string,
  text: string,
): Promise<void> {
  try {
    const chunks = chunkDocument(text)
    const vectors = await embedChunks(chunks)
    if (vectors.length) {
      storeChunkVectors(docId, kbId, vectors.map(v => ({
        chunkLine:    v.chunkLine,
        embedding:    v.embedding,
        originalName,
        filePath,
      })))
      console.log(`[embedding] ${originalName}: ${vectors.length} 个 chunk 向量化完成`)
    }
  } catch (err) {
    console.warn(`[embedding] 向量生成失败 ${originalName}: ${(err as Error).message}`)
  }
}

/** 用大模型给文档生成一两句话的摘要，显示在文档列表里。只取前 3000 字，控制费用和耗时 */
async function generateDocSummary(docId: number, originalName: string, text: string): Promise<void> {
  try {
    const excerpt = text.slice(0, 3000).trim()
    if (!excerpt) return
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: '你是文档摘要助手。用1-2句话（不超过100字）概括文档的核心内容，不加引导语，直接输出摘要。' },
          { role: 'user', content: `文档名：${originalName}\n\n内容：\n${excerpt}` },
        ],
        max_tokens: 150,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) return
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] }
    const summary = data.choices?.[0]?.message?.content?.trim()
    if (summary) {
      updateDocSummary(docId, summary)
      console.log(`[summary] ${originalName}: 摘要已生成`)
    }
  } catch {
    // 摘要生成失败不影响正常索引流程
  }
}

/** 加入索引队列并确保队列在处理；上传、新建、编辑、同步、启动补建都从这里进入 */
export function enqueueDocIndex(job: DocIndexJob): void {
  docIndexQueue.push(job)
  void drainDocIndexQueue()
}

async function drainDocIndexQueue(): Promise<void> {
  if (docIndexWorkerRunning) return
  docIndexWorkerRunning = true
  try {
    while (docIndexQueue.length) {
      await processDocIndexJob(docIndexQueue.shift()!)
    }
  } finally {
    docIndexWorkerRunning = false
  }
}
