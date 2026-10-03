/**
 * 端到端测试用服务：每次从空数据库启动（数据放在 .e2e/，运行前清空）。
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, '.e2e')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

process.env.DB_PATH = path.join(dataDir, 'kb.db')
process.env.STORAGE_PATH = path.join(dataDir, 'storage')
process.env.BACKUP_DIR = path.join(dataDir, 'backups')

const { startServer } = await import('../dist/server.js')
startServer()
