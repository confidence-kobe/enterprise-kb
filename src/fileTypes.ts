/**
 * 文件类型白名单和导入限制：上传、文件夹同步、文字提取、OCR 共用。
 * 这些限制大多可以用环境变量调整（见 .env.example）。
 */

import { OCR_IMAGE_EXTS } from './ocr.js'
import { envValue, parsePositiveInt } from './env.js'

/** 可以入库的扩展名（白名单）。上传和文件夹同步都以此为准，不在其中的文件一律跳过 */
export const ALLOWED_EXTS = new Set([
  '.txt', '.md', '.markdown', '.pdf',
  '.ts', '.js', '.py', '.java', '.go', '.rs',
  '.json', '.yaml', '.yml', '.toml',
  '.csv', '.html', '.xml', '.sh',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
])

export const OFFICE_EXTS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])
/** 网页上传额外接受图片（通过 OCR 识别文字）；文件夹同步不收图片，避免把图标、截图之类一起导入 */
export const UPLOAD_EXTS = new Set([...ALLOWED_EXTS, ...OCR_IMAGE_EXTS])

export const SYNC_SKIP_DIRS = new Set([
  '.git', '.svn', '.hg',
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache',
  '__pycache__', '.venv', 'venv',
])
export const SYNC_MAX_FILES = parsePositiveInt(envValue('SYNC_MAX_FILES'), 1000, 'SYNC_MAX_FILES')
export const SYNC_MAX_TOTAL_BYTES = parsePositiveInt(envValue('SYNC_MAX_TOTAL_MB'), 500, 'SYNC_MAX_TOTAL_MB') * 1024 * 1024
/** 单个 PDF / Office 文件的解析超时，超时的文档标记为索引失败 */
export const EXTRACT_TIMEOUT_MS = parsePositiveInt(envValue('EXTRACT_TIMEOUT_SECONDS'), 120, 'EXTRACT_TIMEOUT_SECONDS') * 1000
export const SYNC_MAX_FILE_BYTES = 50 * 1024 * 1024
/** 扫描件文字识别：默认开启，OCR_ENABLED=false 关闭 */
export const OCR_ENABLED = !/^(0|false|no|off)$/i.test(envValue('OCR_ENABLED') ?? '')
/** 每个 PDF 最多识别的扫描页数，超出的页不识别 */
export const OCR_MAX_PAGES = parsePositiveInt(envValue('OCR_MAX_PAGES'), 100, 'OCR_MAX_PAGES')
/** 识别超时：基础解析时间 + 每页 60 秒 */
export const OCR_PAGE_TIMEOUT_MS = 60_000

export const TEXT_PREVIEWABLE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.ts', '.js', '.py', '.java', '.go',
  '.rs', '.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.xml', '.sh',
])
