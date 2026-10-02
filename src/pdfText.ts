/**
 * PDF 文本提取（pdf-parse 2，基于新版 pdf.js）
 */

import * as fs from 'node:fs'

/** 提取 PDF 全文；文件损坏时抛错（调用方会把文档标记为索引失败） */
export async function extractPdfText(filePath: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: fs.readFileSync(filePath) })
  try {
    // pageJoiner 为空：不插入 "-- 1 of 3 --" 之类的分页标记，避免污染索引和回答
    const result = await parser.getText({ pageJoiner: '' })
    return result.text
  } finally {
    await parser.destroy()
  }
}
