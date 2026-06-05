/**
 * tools.ts
 *
 * 企业知识库工具集。
 *
 * Glob / Grep / Read 三个核心工具直接来自 claude-tools-kit，
 * 该包是从 H:\claude-code-main\claude-code-main 中提取的原版工具实现，
 * 确保与 Claude Code 主项目保持一致的工具质量和参数格式。
 *
 * KBStatsTool 是企业版新增的知识库统计工具。
 */

import * as fs   from 'node:fs'
import * as path from 'node:path'
import { READ_ONLY_TOOLS } from 'claude-tools-kit'
import { adaptTools }      from './toolAdapter.js'
import { searchDocContent } from './db.js'
import type OpenAI         from 'openai'

// ── 类型定义 ──────────────────────────────────────────

export type QAEvent =
  | { type: 'text';        text: string }
  | { type: 'tool_call';   name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: string; isError: boolean }
  | { type: 'error';       message: string }

export interface LLMTool {
  definition: OpenAI.FunctionDefinition
  execute(params: Record<string, unknown>, kbPath: string): Promise<string>
}

// ── 来自 claude-tools-kit 的原版工具（Glob / Grep / Read） ──

/** 从 READ_ONLY_TOOLS 中只取 Glob / Grep / Read，按名字查找避免依赖顺序 */
const kitToolMap = new Map(
  adaptTools(READ_ONLY_TOOLS).map(t => [t.definition.name, t]),
)

const GlobLLMTool = kitToolMap.get('Glob')!
const GrepLLMTool = kitToolMap.get('Grep')!
const ReadLLMTool = kitToolMap.get('Read')!

// ── KBStats 工具（企业版新增） ─────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '__pycache__', '.cache'])

interface FileStats {
  totalFiles: number
  totalLines: number
  totalSizeKB: number
  byExtension: Record<string, { count: number; lines: number }>
}

function walkStats(dir: string, stats: FileStats): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkStats(path.join(dir, entry.name), stats)
    } else if (entry.isFile()) {
      const fullPath = path.join(dir, entry.name)
      const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)'
      let size = 0
      try { size = fs.statSync(fullPath).size } catch { continue }

      let lines = 0
      try { lines = fs.readFileSync(fullPath, 'utf-8').split('\n').length } catch { /* binary */ }

      stats.totalFiles++
      stats.totalLines  += lines
      stats.totalSizeKB += size / 1024

      if (!stats.byExtension[ext]) stats.byExtension[ext] = { count: 0, lines: 0 }
      stats.byExtension[ext].count++
      stats.byExtension[ext].lines += lines
    }
  }
}

export function collectKbStats(kbPath: string): FileStats {
  const stats: FileStats = { totalFiles: 0, totalLines: 0, totalSizeKB: 0, byExtension: {} }
  walkStats(kbPath, stats)
  return stats
}

const KBStatsTool: LLMTool = {
  definition: {
    name: 'KBStats',
    description: '统计知识库的文件数量、总行数、总大小和各类型文件分布。用于了解知识库的整体规模。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '要统计的子目录（相对知识库根目录），默认统计整个知识库',
        },
      },
    },
  },

  async execute({ dir }, kbPath) {
    const root = dir ? path.resolve(kbPath, String(dir)) : kbPath
    const stats = collectKbStats(root)

    const lines: string[] = [
      `知识库统计`,
      `目录：${root.replace(/\\/g, '/')}`,
      `─────────────────────────`,
      `文件总数：${stats.totalFiles}`,
      `总行数：${stats.totalLines.toLocaleString()}`,
      `总大小：${stats.totalSizeKB.toFixed(1)} KB`,
      ``,
      `按文件类型分布：`,
    ]

    const sorted = Object.entries(stats.byExtension).sort((a, b) => b[1].count - a[1].count)
    for (const [ext, info] of sorted) {
      lines.push(`  ${ext.padEnd(14)}${String(info.count).padStart(4)} 个文件  ${info.lines.toLocaleString()} 行`)
    }

    return lines.join('\n')
  },
}

// ── SearchDocs 工具（FTS5 全文检索） ─────────────────────

const SearchDocsTool: LLMTool = {
  definition: {
    name: 'SearchDocs',
    description: [
      '在知识库中进行全文检索，返回包含关键词的文档片段及来源文件。',
      '比 Grep 更快，支持多词联合检索，适合作为第一步定位工具。',
      '返回结果包含 >>>高亮词<<< 标记和文件路径，可直接用 Read 精读全文。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词或短语，多个词用空格分隔（如 "部署 配置 端口"）',
        },
        limit: {
          type: 'number',
          description: '返回结果数上限，默认 8，最大 20',
        },
      },
      required: ['query'],
    },
  },

  async execute({ query, limit }, kbPath) {
    // 从路径提取 kbId：storage/kb_<id>
    const kbId = Number(path.basename(kbPath).replace('kb_', ''))
    if (!kbId) return '无法识别知识库 ID'

    const results = searchDocContent(kbId, String(query), Math.min(Number(limit ?? 8), 20))
    if (!results.length) return '未找到匹配内容，请尝试换用其他关键词或使用 Grep 工具'

    return results
      .map(r => `【${r.original_name}】（行 ${r.chunk_line}）\n文件路径：${r.file_path}\n${r.snippet}`)
      .join('\n\n────\n\n')
  },
}

// ── 工具集合 ──────────────────────────────────────────

/** 全部工具（SearchDocs 优先，其次 Glob/Grep/Read，KBStats 辅助） */
export const ALL_TOOLS: LLMTool[] = [
  SearchDocsTool,
  GlobLLMTool,
  GrepLLMTool,
  ReadLLMTool,
  KBStatsTool,
]

export { SearchDocsTool, GlobLLMTool, GrepLLMTool, ReadLLMTool, KBStatsTool }
