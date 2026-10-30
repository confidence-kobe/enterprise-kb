import 'dotenv/config'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const base = process.env.CODEX_APP_URL ?? `http://127.0.0.1:${process.env.PORT || 8080}`
const runId = Date.now().toString(36)
const marker = `FULL_SMOKE_${runId}`
const adminPassword = process.env.ADMIN_PASSWORD
const username = `smoke_${runId}`
const initialPassword = `Smoke-${runId}!`
const resetPassword = `Reset-${runId}!`
const changedPassword = `Changed-${runId}!`

if (!adminPassword) throw new Error('需要设置 ADMIN_PASSWORD')

const results = []
const cleanup = { adminToken: '', userId: 0, kbIds: [], syncDirs: [] }

function record(name, detail = '') {
  results.push({ name, detail })
  console.log(`[ok] ${name}${detail ? `: ${detail}` : ''}`)
}

async function api(path, { method = 'GET', token, body, form, expect = 200, timeout = 30_000 } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeout),
    redirect: 'manual',
  })
  const text = await response.text()
  let data = text
  try { data = text ? JSON.parse(text) : null } catch { /* 不是 JSON，保留原文 */ }
  if (response.status !== expect) {
    throw new Error(`${method} ${path}：期望 ${expect}，实际 ${response.status}：${text.slice(0, 300)}`)
  }
  return data
}

async function cleanupAll() {
  for (const dir of cleanup.syncDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  if (!cleanup.adminToken) return
  for (const id of cleanup.kbIds) {
    await api(`/api/kbs/${id}`, { method: 'DELETE', token: cleanup.adminToken, expect: 200 }).catch(() => {})
  }
  if (cleanup.userId) {
    await api(`/api/admin/users/${cleanup.userId}`, {
      method: 'DELETE',
      token: cleanup.adminToken,
      expect: 200,
    }).catch(() => {})
  }
}

async function waitForDocReady(kbId, docId, token, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = await api(`/api/kbs/${kbId}/docs?limit=200&offset=0`, { token })
    const doc = data.items.find(item => item.id === docId)
    if (doc?.index_status === 'ready') return doc
    if (doc?.index_status === 'error') throw new Error(`文档建索引失败：${doc.index_error}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`文档 ${docId} 在 ${timeoutMs} 毫秒内没有建好索引`)
}

try {
  const health = await api('/healthz')
  record('存活检查', health.status)

  const ready = await api('/readyz', { timeout: 15_000 })
  if (!ready.llmOnline) throw new Error('大模型服务不可用')
  record('就绪检查', ready.model)

  const config = await api('/api/config', { timeout: 15_000 })
  record('公开的模型配置', `${config.provider}/${config.model}`)

  await api('/api/me', { expect: 401 })
  record('受保护的接口拒绝未登录用户')

  await api('/api/auth/login', { method: 'POST', body: {}, expect: 400 })
  record('登录校验必填字段')

  const adminLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { username: process.env.ADMIN_USERNAME ?? 'admin', password: adminPassword },
  })
  cleanup.adminToken = adminLogin.token
  record('管理员登录', adminLogin.user.username)

  const me = await api('/api/me', { token: cleanup.adminToken })
  if (me.role !== 'admin') throw new Error('缺少管理员角色')
  record('当前用户信息', me.role)

  const models = await api('/api/config/models', { token: cleanup.adminToken, timeout: 15_000 })
  if (!models.models?.includes(models.current)) throw new Error('模型列表里没有当前模型')
  record('服务商模型列表', `${models.models.length} 个模型`)

  const alternateModel = models.models.find(model => model !== models.current)
  if (alternateModel) {
    await api('/api/config/model', {
      method: 'PATCH',
      token: cleanup.adminToken,
      body: { model: alternateModel },
    })
    const alternateConfig = await api('/api/config', { timeout: 15_000 })
    if (alternateConfig.model !== alternateModel) throw new Error('切换到其他模型失败')
  }
  await api('/api/config/model', {
    method: 'PATCH',
    token: cleanup.adminToken,
    body: { model: models.current },
  })
  record('切换模型并恢复', models.current)

  const createdUser = await api('/api/admin/users', {
    method: 'POST',
    token: cleanup.adminToken,
    body: { username, password: initialPassword, role: 'user' },
    expect: 201,
  })
  cleanup.userId = createdUser.id
  record('创建用户', username)

  const users = await api('/api/admin/users', { token: cleanup.adminToken })
  if (!users.some(user => user.id === createdUser.id)) throw new Error('找不到刚创建的用户')
  record('用户列表')

  await api(`/api/admin/users/${createdUser.id}/role`, {
    method: 'PATCH', token: cleanup.adminToken, body: { role: 'admin' },
  })
  await api(`/api/admin/users/${createdUser.id}/role`, {
    method: 'PATCH', token: cleanup.adminToken, body: { role: 'user' },
  })
  record('修改用户角色')

  await api(`/api/admin/users/${createdUser.id}/reset-password`, {
    method: 'POST', token: cleanup.adminToken, body: { newPassword: resetPassword },
  })
  let userLogin = await api('/api/auth/login', {
    method: 'POST', body: { username, password: resetPassword },
  })
  record('重置用户密码')

  await api('/api/me/password', {
    method: 'PATCH',
    token: userLogin.token,
    body: { currentPassword: resetPassword, newPassword: changedPassword },
  })
  userLogin = await api('/api/auth/login', {
    method: 'POST', body: { username, password: changedPassword },
  })
  const userToken = userLogin.token
  record('用户修改自己的密码')

  await api('/api/admin/users', { token: userToken, expect: 403 })
  record('非管理员不能访问用户管理')

  const kbA = await api('/api/kbs', {
    method: 'POST',
    token: cleanup.adminToken,
    body: { name: `${marker} A`, description: 'full smoke private KB' },
    expect: 201,
  })
  const kbB = await api('/api/kbs', {
    method: 'POST',
    token: cleanup.adminToken,
    body: { name: `${marker} B`, description: 'cross-KB isolation target' },
    expect: 201,
  })
  cleanup.kbIds.push(kbA.id, kbB.id)
  record('创建知识库')

  await api(`/api/kbs/${kbA.id}`, {
    method: 'PATCH',
    token: cleanup.adminToken,
    body: { name: `${marker} A updated`, description: 'updated description' },
  })
  const updatedKb = await api(`/api/kbs/${kbA.id}`, { token: cleanup.adminToken })
  if (!updatedKb.name.endsWith('updated')) throw new Error('知识库修改没有保存')
  record('读取和修改知识库')

  await api(`/api/kbs/${kbA.id}`, { token: userToken, expect: 403 })
  record('私有知识库拒绝非成员')

  await api(`/api/kbs/${kbA.id}/public`, {
    method: 'PATCH', token: cleanup.adminToken, body: { is_public: true },
  })
  await api(`/api/kbs/${kbA.id}`, { token: userToken })
  await api(`/api/kbs/${kbA.id}/public`, {
    method: 'PATCH', token: cleanup.adminToken, body: { is_public: false },
  })
  record('切换公开/私有')

  for (const kb of [kbA, kbB]) {
    await api(`/api/kbs/${kb.id}/members`, {
      method: 'POST',
      token: cleanup.adminToken,
      body: { username },
      expect: 201,
    })
  }
  const members = await api(`/api/kbs/${kbA.id}/members`, { token: cleanup.adminToken })
  if (!members.some(member => member.id === createdUser.id)) throw new Error('找不到成员')
  await api(`/api/kbs/${kbA.id}`, { token: userToken })
  record('添加成员和成员列表')

  const docText = await api(`/api/kbs/${kbA.id}/docs/text`, {
    method: 'POST',
    token: cleanup.adminToken,
    body: {
      title: `${marker} guide`,
      content: `# ${marker}\n\n${marker} is used to verify document search, preview, and real model answers.\n\n中文项目检索用于验证中文子串搜索。`,
    },
    expect: 201,
  })
  const docB = await api(`/api/kbs/${kbB.id}/docs/text`, {
    method: 'POST',
    token: cleanup.adminToken,
    body: { title: `${marker} isolated`, content: `${marker} cross-KB document must remain isolated.` },
    expect: 201,
  })
  record('创建文本文档')

  const form = new FormData()
  form.append('files', new Blob([`${marker} uploaded file content`], { type: 'text/plain' }), `${marker}.txt`)
  const uploaded = await api(`/api/kbs/${kbA.id}/docs`, {
    method: 'POST', token: cleanup.adminToken, form, expect: 201,
  })
  const uploadDoc = uploaded[0]
  if (uploadDoc.index_status !== 'pending') throw new Error(`上传的文档没有进入等待索引状态：${uploadDoc.index_status}`)
  await waitForDocReady(kbA.id, uploadDoc.id, cleanup.adminToken)
  record('上传文件并在后台建索引')

  const syncRoot = fs.mkdtempSync(path.join(os.tmpdir(), `enterprise-kb-sync-${runId}-`))
  cleanup.syncDirs.push(syncRoot)
  const syncRelative = 'team/sync-guide.md'
  const syncFile = path.join(syncRoot, 'team', 'sync-guide.md')
  fs.mkdirSync(path.dirname(syncFile), { recursive: true })
  fs.writeFileSync(syncFile, `# Sync ${marker}\n\nSYNC_ADDED_${marker}\n`, 'utf8')

  const syncSource = await api(`/api/kbs/${kbA.id}/sync-source`, {
    method: 'PATCH',
    token: cleanup.adminToken,
    body: { path: syncRoot },
  })
  if (!syncSource.sync_source_path) throw new Error('同步文件夹路径没有保存')

  const syncAdd = await api(`/api/kbs/${kbA.id}/sync`, { method: 'POST', token: cleanup.adminToken })
  if (syncAdd.added !== 1 || syncAdd.queued < 1) throw new Error('同步新增文件后没有加入索引队列')
  let syncDocs = await api(`/api/kbs/${kbA.id}/docs?limit=200&offset=0`, { token: cleanup.adminToken })
  let syncDoc = syncDocs.items.find(doc => doc.original_name === syncRelative)
  if (!syncDoc || syncDoc.source_type !== 'sync') throw new Error('同步新增后找不到文档')
  await waitForDocReady(kbA.id, syncDoc.id, cleanup.adminToken)
  const syncSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent(`SYNC_ADDED_${marker}`)}`, {
    token: cleanup.adminToken,
  })
  if (!syncSearch.length) throw new Error('同步的文档检索不到')

  fs.writeFileSync(syncFile, `# Sync ${marker}\n\nSYNC_UPDATED_${marker}\n`, 'utf8')
  const mtime = new Date(Date.now() + 2000)
  fs.utimesSync(syncFile, mtime, mtime)
  const syncUpdate = await api(`/api/kbs/${kbA.id}/sync`, { method: 'POST', token: cleanup.adminToken })
  if (syncUpdate.updated !== 1 || syncUpdate.queued < 1) throw new Error('同步修改文件后没有加入索引队列')
  await waitForDocReady(kbA.id, syncDoc.id, cleanup.adminToken)
  const syncUpdateSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent(`SYNC_UPDATED_${marker}`)}`, {
    token: cleanup.adminToken,
  })
  if (!syncUpdateSearch.length) throw new Error('同步修改后的内容检索不到')

  fs.rmSync(syncFile, { force: true })
  const syncRemove = await api(`/api/kbs/${kbA.id}/sync`, { method: 'POST', token: cleanup.adminToken })
  if (syncRemove.removed !== 1) throw new Error('同步时没有删除已移除的文件')
  syncDocs = await api(`/api/kbs/${kbA.id}/docs?limit=200&offset=0`, { token: cleanup.adminToken })
  syncDoc = syncDocs.items.find(doc => doc.original_name === syncRelative)
  if (syncDoc) throw new Error('已移除的同步文件仍有文档记录')
  record('本地文件夹同步：新增、修改、删除')

  await api('/api/admin/audit', { token: userToken, expect: 403 })
  const audit = await api(`/api/admin/audit?action=${encodeURIComponent('kb.sync_run')}`, {
    token: cleanup.adminToken,
  })
  if (!audit.items.some(item => item.kb_id === kbA.id && item.action === 'kb.sync_run')) {
    throw new Error('审计日志没有记录同步操作')
  }
  record('审计日志和权限')

  const docs = await api(`/api/kbs/${kbA.id}/docs`, { token: cleanup.adminToken })
  const pagedDocs = await api(`/api/kbs/${kbA.id}/docs?limit=1&offset=0`, { token: cleanup.adminToken })
  if (docs.length < 2 || pagedDocs.items.length !== 1 || pagedDocs.total < 2) throw new Error('文档列表异常')
  record('文档列表和分页')

  const preview = await api(`/api/kbs/${kbA.id}/docs/${docText.id}/preview`, { token: cleanup.adminToken })
  if (!preview.content.includes(marker)) throw new Error('预览内容不一致')
  await api(`/api/kbs/${kbA.id}/docs/${uploadDoc.id}/preview`, { token: cleanup.adminToken })
  record('文档预览')

  const docSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent(marker)}`, {
    token: cleanup.adminToken,
  })
  if (!docSearch.length) throw new Error('文档检索没有结果')
  record('文档全文检索')

  const chineseSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent('中文子串')}`, {
    token: cleanup.adminToken,
  })
  if (!chineseSearch.length) throw new Error('中文子串检索没有结果')
  record('中文子串检索')

  const reindex = await api(`/api/kbs/${kbA.id}/reindex`, { method: 'POST', token: cleanup.adminToken })
  if (reindex.indexed < 2) throw new Error('重建索引漏掉了文档')
  record('重建索引', `${reindex.indexed}/${reindex.total}`)

  const stats = await api(`/api/kbs/${kbA.id}/stats`, { token: cleanup.adminToken })
  if (stats.totalDocs < 2) throw new Error('统计的文档数不对')
  record('知识库统计')

  await api(`/api/kbs/${kbA.id}/docs/batch`, {
    method: 'DELETE', token: userToken, body: { ids: [docText.id] }, expect: 403,
  })
  await api(`/api/kbs/${kbA.id}/docs/${docB.id}`, {
    method: 'DELETE', token: cleanup.adminToken, expect: 404,
  })
  const docsB = await api(`/api/kbs/${kbB.id}/docs`, { token: cleanup.adminToken })
  if (!docsB.some(doc => doc.id === docB.id)) throw new Error('其他知识库的文档被删除了')
  record('文档删除权限和知识库隔离')

  const convA = await api(`/api/kbs/${kbA.id}/conversations`, {
    method: 'POST', token: userToken, expect: 201,
  })
  const convB = await api(`/api/kbs/${kbB.id}/conversations`, {
    method: 'POST', token: userToken, expect: 201,
  })
  await api(`/api/conversations/${convA.id}`, { token: userToken })
  await api(`/api/conversations/${convA.id}`, {
    method: 'PATCH', token: userToken, body: { title: `${marker} renamed` },
  })
  await api(`/api/conversations/${convA.id}/pin`, {
    method: 'PATCH', token: userToken, body: { pinned: true },
  })
  const conversations = await api(`/api/kbs/${kbA.id}/conversations`, { token: userToken })
  if (!conversations.items.some(conv => conv.id === convA.id && conv.is_pinned === 1)) {
    throw new Error('对话重命名或置顶没有保存')
  }
  await api(`/api/conversations/${convA.id}/messages`, { token: userToken })
  record('对话的创建、读取、重命名、置顶、列表和消息')

  await api(`/api/kbs/${kbA.id}/ask`, {
    method: 'POST',
    token: userToken,
    body: { question: 'must be rejected', conversationId: convB.id },
    expect: 400,
  })
  record('对话不能跨知识库')

  const ask = await api(`/api/kbs/${kbA.id}/ask`, {
    method: 'POST',
    token: userToken,
    body: { question: `${marker} 的用途是什么？请根据知识库简要回答。`, conversationId: null },
    timeout: 120_000,
  })
  const events = String(ask)
    .split('\n\n')
    .filter(part => part.startsWith('data: '))
    .map(part => JSON.parse(part.slice(6)))
  const done = events.findLast(event => event.type === 'done')
  const answer = events.filter(event => event.type === 'text').map(event => event.text).join('')
  const toolCalls = events.filter(event => event.type === 'tool_call').map(event => event.name)
  if (!done || !answer || answer.includes('<think>') || !toolCalls.length) throw new Error('真实模型回答失败')
  record('真实模型调用工具回答', `${done.turns} 轮`)

  const clientInjection = `CLIENT_HISTORY_MUST_BE_IGNORED_${runId}`
  const followUpAsk = await api(`/api/kbs/${kbA.id}/ask`, {
    method: 'POST',
    token: userToken,
    body: {
      question: '请简短确认你能继续本次对话。',
      conversationId: done.conversationId,
      history: [{ role: 'user', content: clientInjection }],
    },
    timeout: 120_000,
  })
  const followUpEvents = String(followUpAsk)
    .split('\n\n')
    .filter(part => part.startsWith('data: '))
    .map(part => JSON.parse(part.slice(6)))
  const followUpDone = followUpEvents.findLast(event => event.type === 'done')
  if (!followUpDone?.context || followUpDone.context.totalMessages < 1) {
    throw new Error('没有加载服务端保存的对话上下文')
  }

  const storedMessages = await api(`/api/conversations/${done.conversationId}/messages`, { token: userToken })
  if (!storedMessages.length) throw new Error('模型对话消息没有保存')
  if (storedMessages.some(message => String(message.content ?? '').includes(clientInjection))) {
    throw new Error('客户端传来的历史被保存了')
  }
  record('服务端管理对话上下文')

  const convSearch = await api(`/api/search/conversations?q=${encodeURIComponent(marker)}`, { token: userToken })
  if (!convSearch.total) throw new Error('对话搜索没有结果')
  record('对话保存和全局搜索')

  const batchDelete = await api('/api/conversations/batch', {
    method: 'DELETE',
    token: userToken,
    body: { ids: [convA.id, convB.id, done.conversationId] },
  })
  if (batchDelete.deleted !== 3) throw new Error('批量删除对话失败')
  record('批量删除对话')

  await api(`/api/kbs/${kbA.id}/docs/${uploadDoc.id}`, {
    method: 'DELETE', token: cleanup.adminToken,
  })
  const docBatchDelete = await api(`/api/kbs/${kbA.id}/docs/batch`, {
    method: 'DELETE', token: cleanup.adminToken, body: { ids: [docText.id] },
  })
  if (docBatchDelete.deleted !== 1) throw new Error('批量删除文档失败')
  record('单个和批量删除文档')

  await api(`/api/kbs/${kbA.id}/members/${createdUser.id}`, {
    method: 'DELETE', token: cleanup.adminToken,
  })
  await api(`/api/kbs/${kbA.id}`, { token: userToken, expect: 403 })
  record('移除成员')

  console.log(`\n完整冒烟测试通过：共 ${results.length} 项检查`)
} finally {
  await cleanupAll()
}
