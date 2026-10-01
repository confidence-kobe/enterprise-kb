import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackup, listBackups, pruneBackups, readBackup, restoreBackup } from '../src/backup.js'

let root: string
let dbPath: string
let storagePath: string
let backupDir: string
let live: Database.Database

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-backup-'))
  dbPath = path.join(root, 'data', 'enterprise-kb.db')
  storagePath = path.join(root, 'storage')
  backupDir = path.join(root, 'backups')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  fs.mkdirSync(path.join(storagePath, 'kb_1'), { recursive: true })
  fs.writeFileSync(path.join(storagePath, 'kb_1', 'handbook.md'), '# Handbook\n')

  // 模拟运行中的服务：WAL 模式下保持连接并写入
  live = new Database(dbPath)
  live.pragma('journal_mode = WAL')
  live.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE knowledge_bases (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO users (username) VALUES ('admin'), ('alice');
    INSERT INTO knowledge_bases (name) VALUES ('HR');
    INSERT INTO documents (name) VALUES ('handbook.md');
  `)
})

afterEach(() => {
  if (live.open) live.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('createBackup', () => {
  it('snapshots the live database (including WAL data) and the storage folder', async () => {
    const { dir, manifest } = await createBackup({ dbPath, storagePath, backupDir }, '1.1.0')

    expect(manifest).toMatchObject({
      format: 1,
      appVersion: '1.1.0',
      counts: { users: 2, knowledgeBases: 1, documents: 1, conversations: 0 },
      storageFiles: 1,
    })
    expect(fs.readFileSync(path.join(dir, 'storage', 'kb_1', 'handbook.md'), 'utf-8')).toBe('# Handbook\n')
    const copy = new Database(path.join(dir, 'enterprise-kb.db'), { readonly: true })
    expect((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(2)
    copy.close()
    expect(fs.readdirSync(backupDir).some(name => name.endsWith('.partial'))).toBe(false)
  })

  it('keeps only the newest backups when pruning', async () => {
    for (let i = 0; i < 3; i++) await createBackup({ dbPath, storagePath, backupDir })
    expect(listBackups(backupDir)).toHaveLength(3)
    const removed = pruneBackups(backupDir, 2)
    expect(removed).toHaveLength(1)
    expect(listBackups(backupDir)).toHaveLength(2)
    expect(listBackups(backupDir)).not.toContain(removed[0])
  })

  it('refuses a backup folder inside the document storage folder', async () => {
    await expect(createBackup({ dbPath, storagePath, backupDir: path.join(storagePath, 'kb_1', 'backups') }))
      .rejects.toThrow('BACKUP_DIR 不能位于 STORAGE_PATH 之内')
    expect(fs.existsSync(path.join(storagePath, 'kb_1', 'backups'))).toBe(false)
  })

  it('fails clearly when the database is missing', async () => {
    await expect(createBackup({ dbPath: path.join(root, 'missing.db'), storagePath, backupDir })).rejects.toThrow('数据库不存在')
  })
})

describe('restoreBackup', () => {
  it('restores data and keeps the current data aside instead of deleting it', async () => {
    const { dir } = await createBackup({ dbPath, storagePath, backupDir })

    // 备份之后又发生了变化（模拟误操作）
    live.exec(`DELETE FROM users; INSERT INTO users (username) VALUES ('intruder')`)
    fs.rmSync(path.join(storagePath, 'kb_1', 'handbook.md'))
    live.close()

    const { kept } = restoreBackup(dir, { dbPath, storagePath })

    const restored = new Database(dbPath, { readonly: true })
    const names = (restored.prepare('SELECT username FROM users ORDER BY id').all() as { username: string }[]).map(r => r.username)
    restored.close()
    expect(names).toEqual(['admin', 'alice'])
    expect(fs.existsSync(path.join(storagePath, 'kb_1', 'handbook.md'))).toBe(true)

    // 恢复前的数据被改名保留
    expect(kept.some(p => p.startsWith(`${dbPath}.before-restore-`))).toBe(true)
    expect(kept.some(p => p.startsWith(`${storagePath}.before-restore-`))).toBe(true)
    const keptDb = kept.find(p => p.startsWith(`${dbPath}.before-restore-`) && !p.includes('-wal') && !p.includes('-shm'))!
    const before = new Database(keptDb, { readonly: true })
    expect((before.prepare('SELECT username FROM users').get() as { username: string }).username).toBe('intruder')
    before.close()
  })

  it('refuses a folder that is not a backup or holds a corrupted database', async () => {
    expect(() => readBackup(root)).toThrow('不是有效的备份目录')

    const { dir } = await createBackup({ dbPath, storagePath, backupDir })
    fs.writeFileSync(path.join(dir, 'enterprise-kb.db'), 'not a database')
    expect(() => readBackup(dir)).toThrow()
    live.close()
    expect(() => restoreBackup(dir, { dbPath, storagePath })).toThrow()
    // 校验失败时不能动现有数据
    expect(fs.existsSync(dbPath)).toBe(true)
    expect(fs.readdirSync(path.dirname(dbPath)).some(n => n.includes('before-restore'))).toBe(false)
  })
})
