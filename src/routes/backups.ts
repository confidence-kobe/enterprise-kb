/**
 * 数据备份：手动立即备份、查看备份状态。自动备份计划由 backupScheduler 在服务启动时开始。
 */

import type { Express } from 'express'
import { requireAdmin } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { audit } from '../access.js'
import { BackupBusyError, BackupScheduler } from '../backupScheduler.js'
import { DB_PATH, STORAGE_PATH, BACKUP_DIR, BACKUP_KEEP, BACKUP_INTERVAL_HOURS, APP_VERSION } from '../config.js'

export const backupScheduler = new BackupScheduler({
  paths: { dbPath: DB_PATH, storagePath: STORAGE_PATH, backupDir: BACKUP_DIR },
  keep: BACKUP_KEEP,
  intervalHours: BACKUP_INTERVAL_HOURS,
  appVersion: APP_VERSION,
})

export function registerBackupRoutes(app: Express): void {
  /** 备份状态与已有备份列表（不返回服务器上的绝对路径） */
  app.get('/api/admin/backups', requireAdmin, (_req, res) => {
    res.json(backupScheduler.status())
  })

  /** 立即备份；备份在后台线程中进行，完成后返回结果 */
  app.post('/api/admin/backups', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const result = await backupScheduler.runNow('manual')
      audit(req, 'backup.create', 'backup', {
        detail: { name: result.name, documents: result.manifest.counts.documents, removed: result.removed.length },
      })
      res.status(201).json({ name: result.name, removed: result.removed, status: backupScheduler.status() })
    } catch (err) {
      if (err instanceof BackupBusyError) { res.status(409).json({ error: err.message }); return }
      audit(req, 'backup.failed', 'backup', { detail: { error: (err as Error).message } })
      res.status(500).json({ error: `备份失败：${(err as Error).message}` })
    }
  })
}
