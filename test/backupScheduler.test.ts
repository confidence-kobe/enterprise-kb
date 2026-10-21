import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupBusyError, BackupScheduler, type BackupRunResult } from '../src/backupScheduler.js'

const HOUR = 60 * 60 * 1000
let root: string
let backupDir: string

/** 写一份只含清单的"备份"，用来模拟已有备份及其时间 */
function fakeBackup(name: string, createdAt: string) {
  const dir = path.join(backupDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format: 1, createdAt, appVersion: '1.2.0', dbFile: 'enterprise-kb.db',
    counts: { users: 1, knowledgeBases: 1, documents: 3, conversations: 0 }, storageFiles: 3, storageBytes: 1024,
  }))
}

function scheduler(intervalHours: number, run?: () => Promise<BackupRunResult>) {
  return new BackupScheduler({
    paths: { dbPath: path.join(root, 'kb.db'), storagePath: path.join(root, 'storage'), backupDir },
    keep: 7,
    intervalHours,
    appVersion: '1.2.0',
    run: run ?? (async () => {
      const name = `backup-${Date.now()}`
      fakeBackup(name, new Date().toISOString())
      return { name, manifest: {} as BackupRunResult['manifest'], removed: [] }
    }),
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sched-'))
  backupDir = path.join(root, 'backups')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('BackupScheduler', () => {
  it('does nothing when automatic backups are off', async () => {
    const s = scheduler(0)
    expect(s.status()).toMatchObject({ enabled: false, nextAt: null, backups: [] })
    expect(await s.tick()).toBe(false)
  })

  it('backs up right away when there is no backup yet', async () => {
    const s = scheduler(24)
    expect(await s.tick()).toBe(true)
    const status = s.status()
    expect(status.backups).toHaveLength(1)
    expect(status.last).toMatchObject({ trigger: 'schedule', ok: true })
  })

  it('waits until the newest backup is older than the interval', async () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    fakeBackup('backup-20261018-020000', '2026-10-18T02:00:00.000Z')
    const s = scheduler(24)

    expect(await s.tick(now)).toBe(false)
    expect(s.status(now).nextAt).toBe('2026-10-19T02:00:00.000Z')
    expect(await s.tick(Date.parse('2026-10-19T02:00:00Z'))).toBe(true)
  })

  it('records a failure and retries an hour later instead of every check', async () => {
    let calls = 0
    const s = scheduler(24, async () => { calls++; throw new Error('disk full') })

    const t0 = Date.now()
    expect(await s.tick(t0)).toBe(true)
    expect(s.status().last).toMatchObject({ ok: false, error: 'disk full' })
    expect(await s.tick(t0 + 10 * 60 * 1000)).toBe(false)
    expect(await s.tick(t0 + HOUR + 1000)).toBe(true)
    expect(calls).toBe(2)
  })

  it('refuses a second backup while one is running', async () => {
    let release!: () => void
    const s = scheduler(24, () => new Promise(resolve => {
      release = () => resolve({ name: 'backup-x', manifest: {} as BackupRunResult['manifest'], removed: [] })
    }))
    const first = s.runNow('manual')
    expect(s.status().running).toBe(true)
    await expect(s.runNow('manual')).rejects.toBeInstanceOf(BackupBusyError)
    expect(await s.tick()).toBe(false)
    release()
    await first
    expect(s.status()).toMatchObject({ running: false, last: { trigger: 'manual', ok: true, name: 'backup-x' } })
  })

  it('lists backups newest first without exposing server paths', () => {
    fakeBackup('backup-20261016-020000', '2026-10-16T02:00:00.000Z')
    fakeBackup('backup-20261017-020000', '2026-10-17T02:00:00.000Z')
    const { backups } = scheduler(24).status()
    expect(backups.map(b => b.name)).toEqual(['backup-20261017-020000', 'backup-20261016-020000'])
    expect(JSON.stringify(backups)).not.toContain(root)
  })
})
