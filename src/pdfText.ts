/**
 * PDF 文本提取（pdf-parse 2，基于新版 pdf.js）
 */

import * as fs from 'node:fs'

export interface PdfText {
  /** 全文 */
  text: string
  /** 每页的文字，下标 0 对应第 1 页；用来找出需要 OCR 的扫描页 */
  pages: string[]
}

/** 提取 PDF 全文及每页文字；文件损坏时抛错（调用方会把文档标记为索引失败） */
export async function extractPdf(filePath: string): Promise<PdfText> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: fs.readFileSync(filePath) })
  try {
    // pageJoiner 为空：不插入 "-- 1 of 3 --" 之类的分页标记，避免污染索引和回答
    const result = await parser.getText({ pageJoiner: '' })
    return { text: result.text, pages: result.pages.map(p => p.text) }
  } finally {
    await parser.destroy()
  }
}

export async function extractPdfText(filePath: string): Promise<string> {
  return (await extractPdf(filePath)).text
}
