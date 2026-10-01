/**
 * 备份命令行
 *
 *   npm run backup                       创建备份并清理旧备份（保留 BACKUP_KEEP 份）
 *   npm run backup -- list               列出已有备份
 *   npm run restore -- <备份目录> --yes   从备份恢复（需先停止服务）
 *
 * 路径与服务端一致：DB_PATH、STORAGE_PATH、BACKUP_DIR（相对路径按项目根目录解析）。
 */

import 'dotenv/config'
import * as fs   from 'node:fs'
import * as path from 'node:path'
import * as url  from 'node:url'
import { createBackup, listBackups, pruneBackups, readBackup, restoreBackup } from './backup.js'

const PROJECT_ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')

function resolveFromProject(envVal: string | undefined, fallback: string): string {
  const val = envVal?.trim() || fallback
  return path.isAbsolute(val) ? val : path.resolve(PROJECT_ROOT, val)
}

const DB_PATH      = resolveFromProject(process.env.DB_PATH, 'data/enterprise-kb.db')
const STORAGE_PATH = resolveFromProject(process.env.STORAGE_PATH, 'storage')
const BACKUP_DIR   = resolveFromProject(process.env.BACKUP_DIR, 'backups')
const BACKUP_KEEP  = Number(process.env.BACKUP_KEEP ?? 7)

function appVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 服务是否仍在运行（恢复前必须停止，否则会覆盖正在使用的数据库） */
async function serverIsRunning(): Promise<boolean> {
  const port = process.env.PORT || '8080'
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function runBackup(): Promise<void> {
  console.log(`数据库：${DB_PATH}`)
  console.log(`存储：  ${STORAGE_PATH}`)
  const { dir, manifest } = await createBackup({ dbPath: DB_PATH, storagePath: STORAGE_PATH, backupDir: BACKUP_DIR }, appVersion())
  const c = manifest.counts
  console.log(`\n✓ 备份完成：${dir}`)
  console.log(`  用户 ${c.users} · 知识库 ${c.knowledgeBases} · 文档 ${c.documents} · 对话 ${c.conversations}`)
  console.log(`  存储文件 ${manifest.storageFiles} 个，共 ${formatBytes(manifest.storageBytes)}`)
  const removed = pruneBackups(BACKUP_DIR, BACKUP_KEEP)
  if (removed.length) console.log(`  已清理 ${removed.length} 份旧备份（保留最新 ${BACKUP_KEEP} 份）`)
  console.log('\n提示：备份与数据在同一台机器上，请定期把备份目录复制到其他位置。')
}

function runList(): void {
  const backups = listBackups(BACKUP_DIR)
  if (!backups.length) { console.log(`没有备份（${BACKUP_DIR}）`); return }
  for (const dir of backups) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
      console.log(`${path.basename(dir)}  v${m.appVersion}  文档 ${m.counts.documents}  ${formatBytes(m.storageBytes)}`)
    } catch {
      console.log(`${path.basename(dir)}  (清单无法读取)`)
    }
  }
}

async function runRestore(target: string | undefined, confirmed: boolean): Promise<void> {
  if (!target) throw new Error('用法：npm run restore -- <备份目录> --yes')
  const dir = path.isAbsolute(target) || fs.existsSync(target) ? path.resolve(target) : path.join(BACKUP_DIR, target)
  const manifest = readBackup(dir)
  console.log(`备份：${dir}`)
  console.log(`  创建于 ${manifest.createdAt}，版本 v${manifest.appVersion}，文档 ${manifest.counts.documents} 份`)
  console.log(`将恢复到：\n  数据库 ${DB_PATH}\n  存储   ${STORAGE_PATH}`)

  if (!confirmed) {
    console.log('\n未执行。确认无误后加上 --yes 重新运行。当前数据会被改名保留，不会删除。')
    return
  }
  if (await serverIsRunning()) {
    throw new Error('服务仍在运行，请先停止服务再恢复（否则会覆盖正在使用的数据库）')
  }
  const { kept } = restoreBackup(dir, { dbPath: DB_PATH, storagePath: STORAGE_PATH })
  console.log('\n✓ 恢复完成。原有数据已保留在：')
  for (const k of kept) console.log(`  ${k}`)
  console.log('确认服务正常后可手动删除这些保留文件。')
}

async function main(): Promise<void> {
  const [command = 'backup', ...rest] = process.argv.slice(2)
  if (command === 'backup') return runBackup()
  if (command === 'list') return runList()
  if (command === 'restore') {
    const confirmed = rest.includes('--yes')
    return runRestore(rest.find(a => !a.startsWith('--')), confirmed)
  }
  throw new Error(`未知命令：${command}（可用：backup、list、restore）`)
}

main().catch(err => {
  console.error(`✗ ${(err as Error).message}`)
  process.exit(1)
})
