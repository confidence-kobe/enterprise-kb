/**
 * 文件夹同步：把服务器上的一个目录同步进知识库。
 * 路径校验（不能越界、不能和存储目录重叠）→ 扫描目录 → 对比数据库 → 新增、更新、删除并把需要解析的文档排进索引队列。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { PROJECT_ROOT, STORAGE_PATH } from './config.js'
import { createDoc, isDocIndexed, listDocsBySourceType, removeDocFromIndex, updateDocFromSync } from './db.js'
import type { KnowledgeBase } from './db.js'
import { makeStoredFilename, removeStoredDocument } from './documentStore.js'
import { ALLOWED_EXTS, SYNC_MAX_FILES, SYNC_MAX_FILE_BYTES, SYNC_MAX_TOTAL_BYTES, SYNC_SKIP_DIRS } from './fileTypes.js'
import { enqueueDocIndex } from './indexQueue.js'

export interface SyncFile {
  absolutePath: string
  relativePath: string
  size: number
  sourceMtime: number
}

export interface SyncSkipped {
  unsupported: number
  tooLarge: number
  limit: number
  symlink: number
  hiddenDir: number
  errors: number
}

export interface SyncSummary {
  added: number
  updated: number
  removed: number
  queued: number
  unchanged: number
  scanned: number
  skipped: SyncSkipped
  errors: string[]
}

/**
 * child 是否在 parent 里面（或就是 parent）。用 path.relative 判断，而不是比较字符串前缀：
 * 前缀比较会把 /data/kb-evil 误判为在 /data/kb 里面，也挡不住 ../ 绕出去。
 */
function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

export function normalizeSourcePath(sourcePath: string): string {
  return path.normalize(path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(PROJECT_ROOT, sourcePath))
}

/** 解析符号链接后的真实路径；不存在时退回普通解析 */
function realPathOf(p: string): string {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

/** 可选的同步根目录白名单（逗号分隔），每次读取环境变量以便运行时调整 */
function syncAllowedRoots(): string[] {
  return (process.env.SYNC_ALLOWED_ROOTS ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => realPathOf(normalizeSourcePath(p)))
}

/** 校验同步目录，返回错误信息；通过时返回 null */
export function validateSyncSource(sourcePath: string): string | null {
  if (!isDirectory(sourcePath)) return '同步路径不存在或不是文件夹'
  const real = realPathOf(sourcePath)
  const storage = realPathOf(STORAGE_PATH)
  if (isPathInside(storage, real) || isPathInside(real, storage)) return '同步路径不能指向或包含应用存储目录'
  const roots = syncAllowedRoots()
  if (roots.length && !roots.some(root => isPathInside(root, real))) return '同步路径不在允许的目录范围内（SYNC_ALLOWED_ROOTS）'
  return null
}

function isDirectory(sourcePath: string): boolean {
  try {
    return fs.statSync(sourcePath).isDirectory()
  } catch {
    return false
  }
}

/** 同步文件的比对键：Windows 文件名不区分大小写，统一转小写，避免同一个文件被当成两个 */
function sourcePathKey(sourcePath: string): string {
  const normalized = path.normalize(sourcePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 递归扫描同步目录，返回可以入库的文件。跳过：符号链接（可能指向目录外）、隐藏目录和
 * node_modules 等构建目录、不支持的格式、超过 50 MB 的文件；总数或总大小超限后停止收录。
 * 只扫描，不改动任何数据。
 */
function scanSyncDirectory(root: string): { files: SyncFile[]; skipped: SyncSkipped; errors: string[] } {
  const files: SyncFile[] = []
  const skipped: SyncSkipped = { unsupported: 0, tooLarge: 0, limit: 0, symlink: 0, hiddenDir: 0, errors: 0 }
  const errors: string[] = []
  let totalBytes = 0

  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      skipped.errors++
      errors.push(`${dir}: ${(err as Error).message}`)
      return
    }

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped.symlink++
        continue
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SYNC_SKIP_DIRS.has(entry.name)) {
          skipped.hiddenDir++
          continue
        }
        walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (!ALLOWED_EXTS.has(ext)) {
        skipped.unsupported++
        continue
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(absolutePath)
      } catch (err) {
        skipped.errors++
        errors.push(`${absolutePath}: ${(err as Error).message}`)
        continue
      }
      if (stat.size > SYNC_MAX_FILE_BYTES) {
        skipped.tooLarge++
        continue
      }
      if (files.length >= SYNC_MAX_FILES || totalBytes + stat.size > SYNC_MAX_TOTAL_BYTES) {
        skipped.limit++
        continue
      }

      totalBytes += stat.size
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).replace(/\\/g, '/'),
        size: stat.size,
        sourceMtime: Math.round(stat.mtimeMs),
      })
    }
  }

  walk(root)
  return { files, skipped, errors }
}

/**
 * 把同步目录镜像到知识库（增量）：
 *   新文件        → 复制进来，建文档记录，排队建索引
 *   修改时间或大小变了 → 覆盖副本，清掉旧索引，重新排队
 *   没变          → 跳过
 *   源目录里已删除的 → 从知识库里删除
 * 只处理 source_type='sync' 的文档，网页上传的文档不受影响。
 */
export function syncKnowledgeBase(kb: KnowledgeBase, sourceRoot: string): SyncSummary {
  const { files, skipped, errors } = scanSyncDirectory(sourceRoot)
  const summary: SyncSummary = {
    added: 0,
    updated: 0,
    removed: 0,
    queued: 0,
    unchanged: 0,
    scanned: files.length,
    skipped,
    errors: errors.slice(0, 20),
  }
  const kbDir = kb.storage_path || path.join(STORAGE_PATH, `kb_${kb.id}`)
  fs.mkdirSync(kbDir, { recursive: true })

  const sourceDocs = listDocsBySourceType(kb.id, 'sync')
  const docsBySource = new Map(sourceDocs
    .filter(doc => doc.source_path)
    .map(doc => [sourcePathKey(doc.source_path!), doc]))
  const scannedSourceKeys = new Set<string>()

  for (const file of files) {
    const sourcePath = normalizeSourcePath(file.absolutePath)
    const key = sourcePathKey(sourcePath)
    scannedSourceKeys.add(key)

    const existing = docsBySource.get(key)
    if (existing) {
      const unchanged = existing.source_mtime === file.sourceMtime
        && existing.source_size === file.size
        && isDocIndexed(existing.id)
      if (unchanged) {
        summary.unchanged++
        continue
      }

      const storedPath = path.join(kbDir, existing.filename)
      try {
        fs.copyFileSync(sourcePath, storedPath)
        const extractedTxt = storedPath.replace(/\.pdf$/i, '.txt')
        if (extractedTxt !== storedPath && fs.existsSync(extractedTxt)) fs.unlinkSync(extractedTxt)
        removeDocFromIndex(existing.id)
        updateDocFromSync({
          id: existing.id,
          filename: existing.filename,
          originalName: file.relativePath,
          size: file.size,
          sourcePath,
          sourceMtime: file.sourceMtime,
          sourceSize: file.size,
        })
        enqueueDocIndex({ docId: existing.id, kbId: kb.id, originalName: file.relativePath, filePath: storedPath })
        summary.updated++
        summary.queued++
      } catch (err) {
        summary.errors.push(`${file.relativePath}: ${(err as Error).message}`)
      }
      continue
    }

    const filename = makeStoredFilename(file.relativePath)
    const storedPath = path.join(kbDir, filename)
    try {
      fs.copyFileSync(sourcePath, storedPath)
      const doc = createDoc({
        kbId: kb.id,
        filename,
        originalName: file.relativePath,
        size: file.size,
        indexStatus: 'pending',
        sourceType: 'sync',
        sourcePath,
        sourceMtime: file.sourceMtime,
        sourceSize: file.size,
      })
      enqueueDocIndex({ docId: doc.id, kbId: kb.id, originalName: file.relativePath, filePath: storedPath })
      summary.added++
      summary.queued++
    } catch (err) {
      summary.errors.push(`${file.relativePath}: ${(err as Error).message}`)
    }
  }

  for (const doc of sourceDocs) {
    if (!doc.source_path || scannedSourceKeys.has(sourcePathKey(doc.source_path))) continue
    removeStoredDocument(kb.id, doc)
    summary.removed++
  }

  return summary
}
