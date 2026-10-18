/**
 * 备份工作线程入口：创建备份并清理旧备份。
 * 复制文档存储目录、完整性检查都是同步的耗时操作，放在独立线程中执行，不阻塞服务。
 */

import * as path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { createBackup, pruneBackups, type BackupPaths } from './backup.js'
import { replyFromWorker } from './runInWorker.js'

const { paths, keep, appVersion } = workerData as { paths: BackupPaths; keep: number; appVersion: string }

replyFromWorker(parentPort, async () => {
  const { dir, manifest } = await createBackup(paths, appVersion)
  const removed = pruneBackups(paths.backupDir, keep)
  return { name: path.basename(dir), manifest, removed: removed.map(d => path.basename(d)) }
})
