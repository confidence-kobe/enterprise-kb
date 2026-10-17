/**
 * 升级验证：用旧版本创建数据，再用当前版本启动同一份数据，确认迁移后数据完整、功能正常。
 *
 *   git worktree add /tmp/kb-old v1.1.0 && (cd /tmp/kb-old && npm ci && npm run build)
 *   npm run build && npm run upgrade:check -- /tmp/kb-old
 *
 * 使用临时数据目录和本地模拟模型，不会触碰 data/ 与 storage/。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { createRequire } from 'node:module'

const Database = createRequire(import.meta.url)('better-sqlite3')

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const oldRoot = path.resolve(process.argv[2] ?? '')
if (!process.argv[2] || !fs.existsSync(path.join(oldRoot, 'dist', 'server.js'))) {
  console.error('用法：npm run upgrade:check -- <已构建的旧版本目录>')
  process.exit(1)
}

const PORT = 18123
const LLM_PORT = 18124
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-upgrade-'))
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  DB_PATH: path.join(dataDir, 'kb.db'),
  STORAGE_PATH: path.join(dataDir, 'storage'),
  BACKUP_DIR: path.join(dataDir, 'backups'),
  JWT_SECRET: 'upgrade-check-secret-at-least-32-characters',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'Upgrade@12345',
  LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
  LLM_API_KEY: 'mock',
  LLM_MODEL: 'mock',
  MOCK_LLM_PORT: String(LLM_PORT),
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

function start(cwd, label) {
  const child = spawn(process.execPath, ['dist/server.js'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  child.label = label
  child.log = () => log
  return child
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(5000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function waitHealthy(child) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break
    try { if ((await fetch(`${BASE}/healthz`)).ok) return } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error(`${child.label} 未能启动：\n${child.log()}`)
}

async function api(token, method, route, body) {
  const headers = { Authorization: `Bearer ${token}` }
  let payload
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(BASE + route, { method, headers, body: payload })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  })
  return (await res.json()).token
}

async function waitIndexed(token, kbId) {
  for (let i = 0; i < 100; i++) {
    const docs = (await api(token, 'GET', `/api/kbs/${kbId}/docs`)).body
    if (docs.every(d => d.index_status === 'ready' || d.index_status === 'error')) return docs
    await sleep(100)
  }
  throw new Error('文档索引超时')
}

/** 旧版本：创建用户、知识库、成员、文档（文本 + PDF）、对话与反馈 */
async function seed() {
  const admin = await login('admin', env.ADMIN_PASSWORD)
  await api(admin, 'POST', '/api/admin/users', { username: 'alice', password: 'Alice@12345', role: 'user' })
  const hr = (await api(admin, 'POST', '/api/kbs', { name: '人事制度', description: '升级测试' })).body
  const finance = (await api(admin, 'POST', '/api/kbs', { name: '财务制度' })).body
  const doomed = (await api(admin, 'POST', '/api/kbs', { name: '待删除' })).body
  await api(admin, 'POST', `/api/kbs/${hr.id}/members`, { username: 'alice' })

  await api(admin, 'POST', `/api/kbs/${hr.id}/docs/text`, { title: '请假制度', content: '# 年假\n\n入职满一年的员工每年享有 10 天年假。' })
  await api(admin, 'POST', `/api/kbs/${finance.id}/docs/text`, { title: '报销制度', content: '差旅报销需在出差结束后 30 天内提交。' })
  await api(admin, 'POST', `/api/kbs/${doomed.id}/docs/text`, { title: '旧文档', content: '这份文档所在的知识库会被删除，残留索引应被清理。' })
  const form = new FormData()
  form.append('files', new Blob([fs.readFileSync(path.join(root, 'test', 'fixtures', 'zh-policy.pdf'))]), 'policy.pdf')
  await api(admin, 'POST', `/api/kbs/${hr.id}/docs`, form)
  await waitIndexed(admin, hr.id)
  await waitIndexed(admin, doomed.id)
  // 旧版本删除知识库时会留下全文索引，新版本启动时应清理
  await api(admin, 'DELETE', `/api/kbs/${doomed.id}`)

  const alice = await login('alice', 'Alice@12345')
  const ask = await fetch(`${BASE}/api/kbs/${hr.id}/ask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'content-type': 'application/json' },
    body: JSON.stringify({ question: '年假有几天？' }),
  })
  await ask.text()
  const convs = (await api(alice, 'GET', `/api/kbs/${hr.id}/conversations`)).body.items
  await api(alice, 'POST', `/api/conversations/${convs[0].id}/feedback`, { rating: -1, reason: 'outdated', comment: '已改为 15 天' })

  return { hrId: hr.id, financeId: finance.id, convId: convs[0].id }
}

/** 记录升级前的状态，用于对比 */
async function snapshot(ids) {
  const admin = await login('admin', env.ADMIN_PASSWORD)
  const alice = await login('alice', 'Alice@12345')
  return {
    users: (await api(admin, 'GET', '/api/admin/users')).body.map(u => u.username).sort(),
    kbs: (await api(admin, 'GET', '/api/kbs')).body.map(k => k.name).sort(),
    hrDocs: (await api(admin, 'GET', `/api/kbs/${ids.hrId}/docs`)).body.map(d => `${d.original_name}:${d.index_status}`).sort(),
    messages: (await api(alice, 'GET', `/api/conversations/${ids.convId}/messages`)).body.length,
    oldToken: alice,
  }
}

async function verify(ids, before) {
  const admin = await login('admin', env.ADMIN_PASSWORD)
  check('管理员可以登录', Boolean(admin))
  const alice = await login('alice', 'Alice@12345')
  check('普通用户可以用原密码登录', Boolean(alice))
  const oldSession = await api(before.oldToken, 'GET', '/api/me')
  check('升级前签发的登录令牌仍然有效', oldSession.status === 200, `HTTP ${oldSession.status}`)

  const users = (await api(admin, 'GET', '/api/admin/users')).body.map(u => u.username).sort()
  check('用户列表不变', JSON.stringify(users) === JSON.stringify(before.users), users.join(', '))
  const kbs = (await api(admin, 'GET', '/api/kbs')).body.map(k => k.name).sort()
  check('知识库列表不变', JSON.stringify(kbs) === JSON.stringify(before.kbs), kbs.join(', '))

  const docs = (await api(admin, 'GET', `/api/kbs/${ids.hrId}/docs`)).body
  const docKeys = docs.map(d => `${d.original_name}:${d.index_status}`).sort()
  check('文档与索引状态不变', JSON.stringify(docKeys) === JSON.stringify(before.hrDocs), docKeys.join(', '))
  const paged = (await api(admin, 'GET', `/api/kbs/${ids.hrId}/docs?limit=50`)).body
  check('文档列表显示分块数（迁移已回填）', paged.items.every(d => d.chunk_count > 0), paged.items.map(d => `${d.original_name}=${d.chunk_count}`).join(', '))

  const hits = (await api(alice, 'GET', `/api/kbs/${ids.hrId}/search/docs?q=${encodeURIComponent('年假')}`)).body
  check('成员可以检索旧文档（2 字词）', hits.length >= 1, `${hits.length} 条`)
  const pdfHits = (await api(alice, 'GET', `/api/kbs/${ids.hrId}/search/docs?q=${encodeURIComponent('带薪年假')}`)).body
  check('旧 PDF 仍可检索', pdfHits.some(h => h.original_name === 'policy.pdf'))
  const crossKb = (await api(admin, 'GET', `/api/kbs/${ids.financeId}/search/docs?q=${encodeURIComponent('年假')}`)).body
  check('知识库之间检索结果不串', crossKb.length === 0, `${crossKb.length} 条`)
  const ghost = (await api(admin, 'GET', `/api/kbs/${ids.financeId}/search/docs?q=${encodeURIComponent('残留索引')}`)).body
  check('已删除知识库的内容检索不到', ghost.length === 0)
  const raw = new Database(env.DB_PATH, { readonly: true })
  const leftover = raw.prepare('SELECT COUNT(*) AS n FROM doc_fts WHERE CAST(doc_id AS INTEGER) NOT IN (SELECT id FROM documents)').get().n
  const unmapped = raw.prepare('SELECT COUNT(*) AS n FROM doc_fts WHERE rowid NOT IN (SELECT id FROM doc_chunks)').get().n
  raw.close()
  check('旧版本删除知识库遗留的全文索引已清理', leftover === 0, `残留 ${leftover} 个`)
  check('每个全文索引分块都已建立文档映射', unmapped === 0, `未映射 ${unmapped} 个`)

  const messages = (await api(alice, 'GET', `/api/conversations/${ids.convId}/messages`)).body
  check('对话记录完整', messages.length === before.messages && messages.length > 0, `${messages.length} 条消息`)
  const negative = (await api(admin, 'GET', '/api/admin/feedback/negative')).body
  check('差评原因与说明保留', negative.items?.[0]?.reason === 'outdated' && negative.items?.[0]?.comment === '已改为 15 天')

  // 升级后的新操作
  await api(alice, 'POST', `/api/kbs/${ids.hrId}/docs/text`, { title: '加班制度', content: '工作日加班按 1.5 倍计算加班费。' })
  const newHits = (await api(alice, 'GET', `/api/kbs/${ids.hrId}/search/docs?q=${encodeURIComponent('加班费')}`)).body
  check('升级后新增文档可检索', newHits.length === 1)
  const pdf = docs.find(d => d.original_name === 'policy.pdf')
  const reindex = await api(admin, 'POST', `/api/kbs/${ids.hrId}/reindex`)
  check('重建索引成功', reindex.status === 200, `HTTP ${reindex.status}`)
  await waitIndexed(admin, ids.hrId)
  const afterReindex = (await api(admin, 'GET', `/api/kbs/${ids.hrId}/docs?limit=50`)).body.items
  check('重建索引后分块数不重复累加',
    afterReindex.find(d => d.id === pdf.id)?.chunk_count === paged.items.find(d => d.id === pdf.id)?.chunk_count)
  const removed = await api(admin, 'DELETE', `/api/kbs/${ids.hrId}/docs/${pdf.id}`)
  const gone = (await api(alice, 'GET', `/api/kbs/${ids.hrId}/search/docs?q=${encodeURIComponent('带薪年假')}`)).body
  check('升级后删除旧文档会同时移出检索', removed.status === 200 && !gone.some(h => h.original_name === 'policy.pdf'))
}

const llm = spawn(process.execPath, [path.join(root, 'e2e', 'mock-llm.mjs')], { env, stdio: 'ignore' })
let server
try {
  await sleep(300)
  server = start(oldRoot, '旧版本')
  await waitHealthy(server)
  const ids = await seed()
  const before = await snapshot(ids)
  await stop(server)
  console.log(`旧版本（${oldRoot}）数据已创建：${before.users.length} 个用户，${before.kbs.length} 个知识库，${before.hrDocs.length} 份文档\n`)

  server = start(root, '当前版本')
  await waitHealthy(server)
  await verify(ids, before)
  const migrated = server.log().split('\n').filter(l => l.includes('[DB]')).join('\n')
  if (migrated) console.log(`\n启动日志：\n${migrated}`)
} catch (err) {
  console.error(err)
  failures++
} finally {
  if (server) await stop(server)
  llm.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures ? `\n✗ ${failures} 项检查失败` : '\n✓ 升级检查全部通过')
process.exit(failures ? 1 : 0)
