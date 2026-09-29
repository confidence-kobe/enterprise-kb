/**
 * 工具访问范围 — 限制 LLM 工具只能读取有权限的知识库目录
 *
 * claude-tools-kit 在 plan（只读）模式下会直接放行所有只读工具，
 * 不会检查 allowedDirectories，因此路径边界必须在这里强制执行。
 */

import * as fs   from 'node:fs'
import * as path from 'node:path'

/** 工具可访问的范围：单库问答为一个知识库，跨库问答为用户有权限的全部知识库 */
export interface ToolScope {
  /** 相对路径的解析基准（默认工作目录） */
  cwd: string
  /** 允许读取的知识库根目录 */
  allowedDirs: string[]
  /** SearchDocs 检索的知识库 ID */
  kbIds: number[]
}

/** 单个知识库目录对应的工具范围（目录名形如 kb_<id>） */
export function scopeForKbPath(kbPath: string, kbId?: number): ToolScope {
  const id = kbId ?? Number(path.basename(kbPath).replace('kb_', ''))
  return { cwd: kbPath, allowedDirs: [kbPath], kbIds: Number.isInteger(id) && id > 0 ? [id] : [] }
}

/** 解析符号链接后的真实路径；路径不存在时退回普通解析 */
function realPath(p: string): string {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

/** target 是否位于某个允许目录之内（含目录本身，按真实路径比较） */
export function isWithinDirs(target: string, dirs: string[]): boolean {
  const resolved = realPath(target)
  return dirs.some(dir => {
    const rel = path.relative(realPath(dir), resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/** 工具参数中表示文件或目录的字段 */
const PATH_PARAMS = ['file_path', 'path', 'notebook_path'] as const

/**
 * 校验工具参数不会越出范围，越界时抛错（错误信息会作为工具结果返回给模型）
 * - 路径参数（缺省为 cwd）解析后必须位于 allowedDirs 内
 * - Glob 模式不得为绝对路径或包含 ..
 */
export function assertParamsInScope(toolName: string, params: Record<string, unknown>, scope: ToolScope): void {
  const denied = () => new Error('只能访问当前有权限的知识库目录')
  if (!isWithinDirs(scope.cwd, scope.allowedDirs)) throw denied()
  for (const key of PATH_PARAMS) {
    const value = params[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') throw denied()
    if (!isWithinDirs(path.resolve(scope.cwd, value), scope.allowedDirs)) throw denied()
  }
  if (toolName === 'Glob' && typeof params.pattern === 'string') {
    const pattern = params.pattern
    if (path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.split(/[\\/]/).includes('..')) {
      throw denied()
    }
  }
}
