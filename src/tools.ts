/**
 * 企业知识库工具套件 (Enterprise KB Toolset)
 *
 * 核心工具编排：
 * 1. `SearchDocs`：知识库首选检索工具，结合 SQLite FTS5 全文索引与向量语义检索，快速定位包含关键词/语义相近的段落与行号；
 * 2. `Read`（来自 claude-tools-kit）：精读工具，支持指定行偏移与读取行数，用于从 SearchDocs 定位到的文件中读取完整上下文；
 * 3. `Glob`（来自 claude-tools-kit）：文件名模式匹配扫描工具（如搜索所有 `*.md` 或配置文档）；
 * 4. `Grep`（来自 claude-tools-kit）：正则全文搜索工具，支持严格行匹配（作为 SearchDocs 的备选）；
 * 5. `KBStats`：知识库整体规模统计工具（统计文件总数、总代码/文本行数、占用磁盘大小以及扩展名分布）。
 */

import * as fs   from 'node:fs'
import * as path from 'node:path'
import { READ_ONLY_TOOLS } from '../packages/claude-tools-kit/dist/index.js'
import { adaptTools }      from './toolAdapter.js'
import { searchDocContent } from './db.js'
import { isEmbeddingEnabled, generateEmbedding } from './embedding.js'
import type OpenAI         from 'openai'

// ── 类型定义 ──────────────────────────────────────────

/**
 * 问答过程中向外发射的实时可观察性事件枚举 (QAEvent)
 */
export type QAEvent =
  /** 模型生成的正文文本片段增量 */
  | { type: 'text';        text: string }
  /** 模型发起的工具调用请求 */
  | { type: 'tool_call';   name: string; input: unknown }
  /** 工具在本地沙箱中执行完毕的输出结果 */
  | { type: 'tool_result'; name: string; output: string; isError: boolean }
  /** 系统级或模型调用异常报错 */
  | { type: 'error';       message: string }

/**
 * 符合 OpenAI Function Calling 规范的模型可用工具标准接口
 */
export interface LLMTool {
  /** 工具的元数据定义与 JSON Schema 参数规范 */
  definition: OpenAI.FunctionDefinition
  /**
   * 工具在知识库沙箱环境中的具体执行实现
   * @param params 模型给出的经过反序列化的入参键值对
   * @param kbPath 当前知识库在磁盘上的绝对根目录
   * @returns 工具执行完毕后返回给模型的文本字符串
   */
  execute(params: Record<string, unknown>, kbPath: string): Promise<string>
}

// ── 来自 claude-tools-kit 的原版工具（Glob / Grep / Read） ──

/**
 * 映射并提取经过适配的 Claude Code 只读工具集：
 * 从原版 READ_ONLY_TOOLS 中精确按名称查找，避免依赖底层数组声明顺序
 */
const kitToolMap = new Map(
  adaptTools(READ_ONLY_TOOLS).map(t => [t.definition.name, t]),
)

/** 文件通配扫描工具 (Glob) */
const GlobLLMTool = kitToolMap.get('Glob')!
/** 正则内容检索工具 (Grep) */
const GrepLLMTool = kitToolMap.get('Grep')!
/** 文件精确内容读取工具 (Read) */
const ReadLLMTool = kitToolMap.get('Read')!

// ── KBStats 工具（企业版新增） ─────────────────────────

/** 扫描知识库统计时自动跳过的无关系统或构建目录 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '__pycache__', '.cache'])

/** 知识库文件特征统计信息 */
interface FileStats {
  /** 统计目录下的文件总数 */
  totalFiles: number
  /** 统计目录下的总行数 */
  totalLines: number
  /** 统计文件总占用空间（KB） */
  totalSizeKB: number
  /** 按文件扩展名划分的文件数与行数统计映射表 */
  byExtension: Record<string, { count: number; lines: number }>
}

/**
 * 递归遍历目录并累计文件统计指标
 *
 * @param dir 当前遍历的目标物理路径
 * @param stats 统计指标容器引用
 */
function walkStats(dir: string, stats: FileStats): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // 过滤系统或隐藏构建目录
      if (!SKIP_DIRS.has(entry.name)) walkStats(path.join(dir, entry.name), stats)
    } else if (entry.isFile()) {
      const fullPath = path.join(dir, entry.name)
      const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)'
      let size = 0
      try { size = fs.statSync(fullPath).size } catch { continue }

      let lines = 0
      try { lines = fs.readFileSync(fullPath, 'utf-8').split('\n').length } catch { /* 二进制文件无法计算行数，忽略 */ }

      stats.totalFiles++
      stats.totalLines  += lines
      stats.totalSizeKB += size / 1024

      if (!stats.byExtension[ext]) stats.byExtension[ext] = { count: 0, lines: 0 }
      stats.byExtension[ext].count++
      stats.byExtension[ext].lines += lines
    }
  }
}

/**
 * 统计指定知识库物理路径的文件规模与类型分布
 *
 * @param kbPath 知识库根目录物理路径
 * @returns 完整的统计结果结构体
 */
export function collectKbStats(kbPath: string): FileStats {
  const stats: FileStats = { totalFiles: 0, totalLines: 0, totalSizeKB: 0, byExtension: {} }
  walkStats(kbPath, stats)
  return stats
}

/**
 * KBStats 统计工具实例
 * 供模型了解知识库整体概况、技术栈文件构成及总数据量
 */
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

    // 按文件数量降序排列输出各扩展名统计
    const sorted = Object.entries(stats.byExtension).sort((a, b) => b[1].count - a[1].count)
    for (const [ext, info] of sorted) {
      lines.push(`  ${ext.padEnd(14)}${String(info.count).padStart(4)} 个文件  ${info.lines.toLocaleString()} 行`)
    }

    return lines.join('\n')
  },
}

// ── SearchDocs 工具（混合全文+向量检索） ─────────────────────

/**
 * SearchDocs 检索工具实例
 *
 * 核心机制：
 * 1. 从当前知识库物理路径解析出知识库数字 ID；
 * 2. 检查向量 Embedding 模型可用性，若启用则动态生成查询向量；
 * 3. 驱动底层的 `searchDocContent` 执行 FTS5 + 向量混合打分检索；
 * 4. 组装包含文档名称、物理行号、完整文件路径及高亮摘要的上下文文本。
 */
const SearchDocsTool: LLMTool = {
  definition: {
    name: 'SearchDocs',
    description: [
      '在知识库中进行混合全文检索，返回包含关键词的文档片段及来源文件。',
      '融合严格匹配、宽松召回、标题和短语加权，支持多词联合检索，适合作为第一步定位工具。',
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
    // 目录名约定为 kb_<id>
    const kbId = Number(path.basename(kbPath).replace('kb_', ''))
    if (!kbId) return '无法识别知识库 ID'

    const queryStr = String(query)
    let queryEmbedding: Float32Array | undefined
    // 尝试生成查询语义向量以参与混合打分
    if (isEmbeddingEnabled()) {
      const emb = await generateEmbedding(queryStr)
      if (emb) queryEmbedding = emb
    }

    // 执行全文检索 + 向量语义检索
    const results = searchDocContent(kbId, queryStr, Math.min(Number(limit ?? 8), 20), queryEmbedding)
    if (!results.length) return '未找到匹配内容，请尝试换用其他关键词或使用 Grep 工具'

    return results
      .map(r => `【${r.original_name}】（行 ${r.chunk_line}）\n文件路径：${r.file_path}\n${r.snippet}`)
      .join('\n\n────\n\n')
  },
}

// ── 工具集合 ──────────────────────────────────────────

/**
 * 完整工具套件注册列表：
 * 按优先级注册，首选 SearchDocs 检索，其次使用 Glob / Grep / Read 工具，辅助使用 KBStats
 */
export const ALL_TOOLS: LLMTool[] = [
  SearchDocsTool,
  GlobLLMTool,
  GrepLLMTool,
  ReadLLMTool,
  KBStatsTool,
]

export { SearchDocsTool, GlobLLMTool, GrepLLMTool, ReadLLMTool, KBStatsTool }
