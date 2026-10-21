import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanOcrText, isScannedPageText } from '../src/ocr.js'
import { extractPdfInWorker, ocrInWorker } from '../src/extractInWorker.js'

const fixture = (name: string) => path.join(__dirname, 'fixtures', name)
// 识别本身每页约 1 秒；以 TypeScript 源码运行时工作线程加载更慢，CI 负载高时更慢
const OCR_TEST_TIMEOUT = 60_000

describe('OCR text cleanup', () => {
  it('removes the spaces Tesseract puts between Chinese characters but keeps English words apart', () => {
    expect(cleanOcrText('第 二 条 员工 出 差 住宿 标准 为 每 晚 450 元 。\n\n\n\nRefund policy v2 ， 详见 附件  \n'))
      .toBe('第二条员工出差住宿标准为每晚450元。\n\nRefund policy v2，详见附件')
  })

  it('treats pages with almost no text as scanned', () => {
    expect(isScannedPageText('  \n 3 \n')).toBe(true)
    expect(isScannedPageText('第一条 为规范公司差旅费用管理，制定本办法。')).toBe(false)
  })
})

describe('ocrInWorker', () => {
  it('reads Chinese text from an image', async () => {
    const [text] = await ocrInWorker(fixture('zh-scanned.png'), 'image', [])
    expect(text).toContain('差旅费报销管理办法')
    expect(text).toContain('住宿标准为每晚四百五十元')
  }, OCR_TEST_TIMEOUT)

  it('finds the scanned page of a mixed PDF and reads only that page', async () => {
    const pdf = await extractPdfInWorker(fixture('zh-scanned.pdf'))
    expect(pdf.pages.map(isScannedPageText)).toEqual([true, false])
    expect(pdf.pages[1]).toContain('meal allowance is 100 yuan per day')

    const texts = await ocrInWorker(fixture('zh-scanned.pdf'), 'pdf', [1])
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('出差结束后十五日内提交报销申请')
  }, OCR_TEST_TIMEOUT)
})
