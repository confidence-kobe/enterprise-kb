/**
 * 扫描件文字识别（OCR）：本地运行 Tesseract（tesseract.js），不联网、数据不出服务器。
 *
 * 只在工作线程里调用（见 extractWorker）：渲染 PDF 页面和识别文字都很耗 CPU。
 * 语言数据随 npm 包安装（@tesseract.js-data/chi_sim、eng），离线环境也能用。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'

/** 可以直接上传、通过 OCR 识别的图片格式 */
export const OCR_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/** PDF 某页可提取的文字少于这个字数时，视为扫描页 */
export const MIN_PAGE_TEXT_CHARS = 20

/** 渲染宽度约等于 A4 的 200 dpi；实测比 300 dpi 识别得更准，也更快 */
const PDF_RENDER_WIDTH = 1654

/** 中文放在前面时 tesseract.js 7 会把语言名读错并报错，所以英文在前 */
const OCR_LANGS = ['eng', 'chi_sim']
const LANG_DATA_VARIANT = '4.0.0_best_int'

export function isScannedPageText(text: string): boolean {
  return text.replace(/\s/g, '').length < MIN_PAGE_TEXT_CHARS
}

const CJK = String.raw`\p{Script=Han}　-〿＀-￯`
const SPACE_NEXT_TO_CJK = new RegExp(`(?<=[${CJK}])[ \\t]+|[ \\t]+(?=[${CJK}])`, 'gu')

/**
 * Tesseract 会在每个词之间插空格（"住宿 标准 为 每 晚 450 元 。"），不去掉就检索不到"住宿标准"。
 * 汉字和中文标点旁边的空格全部去掉；英文单词之间的空格保留。
 */
export function cleanOcrText(raw: string): string {
  return raw
    .split('\n')
    .map(line => line.replace(SPACE_NEXT_TO_CJK, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** tesseract.js 只接受一个语言目录，把各语言包的数据复制到同一个临时目录 */
function prepareLangDir(): string {
  const require = createRequire(import.meta.url)
  const dir = path.join(os.tmpdir(), `enterprise-kb-ocr-${LANG_DATA_VARIANT}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const lang of OCR_LANGS) {
    const pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`))
    const source = path.join(pkgDir, LANG_DATA_VARIANT, `${lang}.traineddata.gz`)
    const target = path.join(dir, `${lang}.traineddata.gz`)
    if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size) continue
    // 先写临时文件再改名，两个线程同时准备也不会读到写了一半的文件
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    fs.copyFileSync(source, tmp)
    fs.renameSync(tmp, target)
  }
  return dir
}

/**
 * 识别图片，或 PDF 的指定页（页码从 1 开始）。返回每张图片/每页的文字，顺序与 pages 一致。
 */
export async function ocrDocument(filePath: string, kind: 'image' | 'pdf', pages: number[] = []): Promise<string[]> {
  const { createWorker, OEM } = await import('tesseract.js')
  // cacheMethod 'none'：不在当前目录写缓存文件
  const worker = await createWorker(OCR_LANGS.join('+'), OEM.LSTM_ONLY, {
    langPath: prepareLangDir(),
    cacheMethod: 'none',
    gzip: true,
  })
  const recognize = async (image: Buffer) => cleanOcrText((await worker.recognize(image)).data.text)
  try {
    if (kind === 'image') return [await recognize(fs.readFileSync(filePath))]

    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: fs.readFileSync(filePath) })
    try {
      const texts: string[] = []
      // 逐页渲染、逐页识别，内存里同时只有一页图片
      for (const num of pages) {
        const shot = await parser.getScreenshot({
          partial: [num], desiredWidth: PDF_RENDER_WIDTH, imageBuffer: true, imageDataUrl: false,
        })
        const image = shot.pages[0]?.data
        texts.push(image ? await recognize(Buffer.from(image)) : '')
      }
      return texts
    } finally {
      await parser.destroy()
    }
  } finally {
    await worker.terminate()
  }
}
