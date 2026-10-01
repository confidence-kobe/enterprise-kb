/**
 * 备份与恢复 — 数据库快照 + 文档存储目录
 *
 * 备份目录结构：
 *   <BACKUP_DIR>/backup-<时间戳>/
 *     enterprise-kb.db   SQLite 在线备份（服务运行中也保持一致）
 *     storage/           文档存储目录副本
 *     manifest.json      版本、时间、统计信息
 *
 * 恢复不会删除现有数据：当前数据库与存储目录会被改名为 *.before-restore-<时间戳> 保留。
 */

import * as fs   from 'node:fs'
import * as path from 'node:path'
import Database  from 'better-sqlite3'

export interface BackupManifest {
  format: 1
  createdAt: string
  appVersion: string
  dbFile: string
  counts: { users: number; knowledgeBases: number; documents: number; conversations: number }
  storageFiles: number
  storageBytes: number
}

export interface BackupPaths {
  dbPath: string
  storagePath: string
  backupDir: string
}

const BACKUP_PREFIX = 'backup-'
const DB_FILE = 'enterprise-kb.db'
const MANIFEST = 'manifest.json'

function timestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

function countFiles(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  if (!fs.existsSync(dir)) return { files, bytes }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    files++
    bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size
  }
  return { files, bytes }
}

function tableCount(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } catch {
    return 0
  }
}

/** 检查 SQLite 文件完整性，返回问题描述；正常时返回 null */
export function checkDatabase(dbFile: string): string | null {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    const problems = rows.map(r => r.integrity_check).filter(r => r !== 'ok')
    return problems.length ? problems.slice(0, 5).join('; ') : null
  } finally {
    db.close()
  }
}

/** 创建一份备份，返回备份目录 */
export async function createBackup(paths: BackupPaths, appVersion = 'unknown'): Promise<{ dir: string; manifest: BackupManifest }> {
  if (!fs.existsSync(paths.dbPath)) throw new Error(`数据库不存在：${paths.dbPath}`)
  // 备份目录不能放在文档存储目录里：否则会递归复制自身，且数据库副本会落入 AI 工具可读的知识库目录
  const rel = path.relative(path.resolve(paths.storagePath), path.resolve(paths.backupDir))
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`BACKUP_DIR 不能位于 STORAGE_PATH 之内：${paths.backupDir}`)
  }
  fs.mkdirSync(paths.backupDir, { recursive: true })

  let name = `${BACKUP_PREFIX}${timestamp()}`
  for (let i = 2; fs.existsSync(path.join(paths.backupDir, name)); i++) name = `${BACKUP_PREFIX}${timestamp()}-${i}`
  const dir = path.join(paths.backupDir, name)
  const partial = `${dir}.partial`
  fs.mkdirSync(partial, { recursive: true })

  try {
    // SQLite 在线备份：服务运行中也能得到一致快照（含 WAL 中尚未合并的数据）
    const source = new Database(paths.dbPath, { readonly: true, fileMustExist: true })
    let counts: BackupManifest['counts']
    try {
      await source.backup(path.join(partial, DB_FILE))
      counts = {
        users: tableCount(source, 'users'),
        knowledgeBases: tableCount(source, 'knowledge_bases'),
        documents: tableCount(source, 'documents'),
        conversations: tableCount(source, 'conversations'),
      }
    } finally {
      source.close()
    }

    const problem = checkDatabase(path.join(partial, DB_FILE))
    if (problem) throw new Error(`备份的数据库未通过完整性检查：${problem}`)

    const storageCopy = path.join(partial, 'storage')
    if (fs.existsSync(paths.storagePath)) {
      fs.cpSync(paths.storagePath, storageCopy, { recursive: true, verbatimSymlinks: true })
    } else {
      fs.mkdirSync(storageCopy)
    }
    const storage = countFiles(storageCopy)

    const manifest: BackupManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      appVersion,
      dbFile: DB_FILE,
      counts,
      storageFiles: storage.files,
      storageBytes: storage.bytes,
    }
    fs.writeFileSync(path.join(partial, MANIFEST), JSON.stringify(manifest, null, 2))
    // 全部写完再改名，避免留下看似完整的半成品备份
    fs.renameSync(partial, dir)
    return { dir, manifest }
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true })
    throw err
  }
}

/** 列出已有备份（新的在前） */
export function listBackups(backupDir: string): string[] {
  if (!fs.existsSync(backupDir)) return []
  return fs.readdirSync(backupDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith(BACKUP_PREFIX) && !e.name.endsWith('.partial')
      && fs.existsSync(path.join(backupDir, e.name, MANIFEST)))
    .map(e => e.name)
    .sort()
    .reverse()
    .map(name => path.join(backupDir, name))
}

/** 只保留最新的 keep 份备份，返回被删除的目录 */
export function pruneBackups(backupDir: string, keep: number): string[] {
  if (!(keep > 0)) return []
  const removed = listBackups(backupDir).slice(keep)
  for (const dir of removed) fs.rmSync(dir, { recursive: true, force: true })
  return removed
}

/** 读取并校验一份备份 */
export function readBackup(dir: string): BackupManifest {
  const manifestPath = path.join(dir, MANIFEST)
  if (!fs.existsSync(manifestPath)) throw new Error(`不是有效的备份目录（缺少 ${MANIFEST}）：${dir}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BackupManifest
  if (manifest.format !== 1) throw new Error(`不支持的备份格式：${manifest.format}`)
  const dbFile = path.join(dir, manifest.dbFile)
  if (!fs.existsSync(dbFile)) throw new Error(`备份中缺少数据库文件：${dbFile}`)
  const problem = checkDatabase(dbFile)
  if (problem) throw new Error(`备份的数据库已损坏：${problem}`)
  return manifest
}

/**
 * 从备份恢复。调用前必须停止服务。
 * 现有数据库（含 -wal/-shm）与存储目录改名保留，返回保留位置。
 */
export function restoreBackup(dir: string, paths: Omit<BackupPaths, 'backupDir'>): { kept: string[]; manifest: BackupManifest } {
  const manifest = readBackup(dir)
  const suffix = `.before-restore-${timestamp()}`
  const kept: string[] = []

  for (const file of [paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`, paths.storagePath]) {
    if (!fs.existsSync(file)) continue
    fs.renameSync(file, file + suffix)
    kept.push(file + suffix)
  }

  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true })
  fs.copyFileSync(path.join(dir, manifest.dbFile), paths.dbPath)
  const storageBackup = path.join(dir, 'storage')
  if (fs.existsSync(storageBackup)) {
    fs.cpSync(storageBackup, paths.storagePath, { recursive: true, verbatimSymlinks: true })
  } else {
    fs.mkdirSync(paths.storagePath, { recursive: true })
  }
  return { kept, manifest }
}
