/**
 * 定时自动备份 + 手动触发。同一时间只运行一个备份；失败后间隔一段时间再重试。
 * 备份在独立线程中执行（backupWorker），不阻塞服务。
 */

import { listBackupSummaries, type BackupManifest, type BackupPaths, type BackupSummary } from './backup.js'
import { runInWorker } from './runInWorker.js'

export interface BackupRunResult {
  name: string
  manifest: BackupManifest
  removed: string[]
}

export type BackupTrigger = 'schedule' | 'manual'

export interface LastBackupAttempt {
  at: string
  trigger: BackupTrigger
  ok: boolean
  name?: string
  error?: string
}

export interface BackupStatus {
  enabled: boolean
  intervalHours: number
  keep: number
  running: boolean
  last: LastBackupAttempt | null
  nextAt: string | null
  backups: BackupSummary[]
}

export interface BackupSchedulerOptions {
  paths: BackupPaths
  keep: number
  /** 自动备份间隔（小时）；0 表示关闭 */
  intervalHours: number
  appVersion: string
  /** 执行一次备份；默认在工作线程中运行，测试可替换 */
  run?: (paths: BackupPaths, keep: number, appVersion: string) => Promise<BackupRunResult>
  /** 失败后多久重试，默认 1 小时 */
  retryAfterMs?: number
  /** 多久检查一次是否该备份，默认 10 分钟 */
  checkEveryMs?: number
}

export class BackupBusyError extends Error {
  constructor() { super('已有备份正在进行，请稍后再试') }
}

const HOUR = 60 * 60 * 1000

function runInBackupWorker(paths: BackupPaths, keep: number, appVersion: string): Promise<BackupRunResult> {
  return runInWorker<BackupRunResult>('backupWorker', { paths, keep, appVersion }, {
    messages: {
      timeout: seconds => `备份超时（超过 ${seconds} 秒）`,
      outOfMemory: '备份时内存不足',
      crashed: code => `备份进程异常退出（${code}）`,
    },
  })
}

export class BackupScheduler {
  private running = false
  private last: LastBackupAttempt | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly run: NonNullable<BackupSchedulerOptions['run']>

  constructor(private readonly options: BackupSchedulerOptions) {
    this.run = options.run ?? runInBackupWorker
  }

  get enabled(): boolean {
    return this.options.intervalHours > 0
  }

  /** 下一次自动备份的时间；未开启时为 null */
  nextDueAt(now = Date.now()): number | null {
    if (!this.enabled) return null
    const newest = listBackupSummaries(this.options.paths.backupDir)[0]
    let due = newest ? Date.parse(newest.createdAt) + this.options.intervalHours * HOUR : now
    if (this.last && !this.last.ok) {
      due = Math.max(due, Date.parse(this.last.at) + (this.options.retryAfterMs ?? HOUR))
    }
    return due
  }

  status(now = Date.now()): BackupStatus {
    const next = this.nextDueAt(now)
    return {
      enabled: this.enabled,
      intervalHours: this.options.intervalHours,
      keep: this.options.keep,
      running: this.running,
      last: this.last,
      nextAt: next === null ? null : new Date(Math.max(next, now)).toISOString(),
      backups: listBackupSummaries(this.options.paths.backupDir),
    }
  }

  async runNow(trigger: BackupTrigger): Promise<BackupRunResult> {
    if (this.running) throw new BackupBusyError()
    this.running = true
    const at = new Date().toISOString()
    try {
      const result = await this.run(this.options.paths, this.options.keep, this.options.appVersion)
      this.last = { at, trigger, ok: true, name: result.name }
      return result
    } catch (err) {
      this.last = { at, trigger, ok: false, error: (err as Error).message }
      throw err
    } finally {
      this.running = false
    }
  }

  /** 到期则执行一次自动备份；返回是否执行了备份 */
  async tick(now = Date.now()): Promise<boolean> {
    const due = this.nextDueAt(now)
    if (due === null || due > now || this.running) return false
    try {
      const result = await this.runNow('schedule')
      console.log(`[backup] 自动备份完成：${result.name}${result.removed.length ? `，清理 ${result.removed.length} 份旧备份` : ''}`)
    } catch (err) {
      console.warn(`[backup] 自动备份失败：${(err as Error).message}`)
    }
    return true
  }

  start(): void {
    if (!this.enabled || this.timer) return
    const check = () => { void this.tick() }
    this.timer = setInterval(check, this.options.checkEveryMs ?? 10 * 60 * 1000)
    this.timer.unref()
    // 启动 1 分钟后检查一次，避免与启动时的索引补建等工作挤在一起
    setTimeout(check, 60_000).unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
