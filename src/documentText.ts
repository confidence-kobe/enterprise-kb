/**
 * 二进制文档（PDF / Word / Excel / PPT）的文本提取
 *
 * 这些解析库在主线程上同步运行，大文件会让整个服务卡住数秒；
 * 服务端通过 extractDocumentTextInWorker 在独立线程中调用这里的函数。
 */

import { extractPdfText } from './pdfText.js'

/** 需要解析的扩展名；其余（.md/.txt 等）直接按 UTF-8 读取 */
export const BINARY_DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])

async function extractDocxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth: any = (await import('mammoth')).default
  const result = await mammoth.extractRawText({ path: filePath })
  return result.value as string
}

async function extractXlsxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const lines: string[] = []
  workbook.eachSheet((sheet: any) => {
    lines.push(`[工作表: ${sheet.name}]`)
    sheet.eachRow((row: any) => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: false }, (cell: any) => {
        const v = cell.value
        if (v === null || v === undefined) return
        if (typeof v === 'object' && 'text' in v) cells.push(String(v.text))
        else if (typeof v === 'object' && 'result' in v) cells.push(String(v.result ?? ''))
        else if (typeof v === 'object' && v instanceof Date) cells.push(v.toISOString().slice(0, 10))
        else cells.push(String(v))
      })
      if (cells.length) lines.push(cells.join('\t'))
    })
  })
  return lines.join('\n')
}

async function extractPptxText(filePath: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officeParser: any = (await import('officeparser')).default
  return await officeParser.parseOfficeAsync(filePath) as string
}

export async function extractDocumentText(filePath: string, ext: string): Promise<string> {
  switch (ext) {
    case '.pdf': return extractPdfText(filePath)
    case '.docx': case '.doc': return extractDocxText(filePath)
    case '.xlsx': case '.xls': return extractXlsxText(filePath)
    case '.pptx': case '.ppt': return extractPptxText(filePath)
    default: throw new Error(`不支持解析的文件类型：${ext}`)
  }
}
