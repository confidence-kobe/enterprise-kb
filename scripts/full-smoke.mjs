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

if (!adminPassword) throw new Error('ADMIN_PASSWORD is required')

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
  try { data = text ? JSON.parse(text) : null } catch { /* keep text */ }
  if (response.status !== expect) {
    throw new Error(`${method} ${path}: expected ${expect}, received ${response.status}: ${text.slice(0, 300)}`)
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
    if (doc?.index_status === 'error') throw new Error(`Document indexing failed: ${doc.index_error}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Document ${docId} was not indexed within ${timeoutMs}ms`)
}

try {
  const health = await api('/healthz')
  record('liveness', health.status)

  const ready = await api('/readyz', { timeout: 15_000 })
  if (!ready.llmOnline) throw new Error('LLM is offline')
  record('readiness', ready.model)

  const config = await api('/api/config', { timeout: 15_000 })
  record('public model config', `${config.provider}/${config.model}`)

  await api('/api/me', { expect: 401 })
  record('protected routes reject anonymous users')

  await api('/api/auth/login', { method: 'POST', body: {}, expect: 400 })
  record('login validates required fields')

  const adminLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { username: process.env.ADMIN_USERNAME ?? 'admin', password: adminPassword },
  })
  cleanup.adminToken = adminLogin.token
  record('admin login', adminLogin.user.username)

  const me = await api('/api/me', { token: cleanup.adminToken })
  if (me.role !== 'admin') throw new Error('Admin role missing')
  record('current user profile', me.role)

  const models = await api('/api/config/models', { token: cleanup.adminToken, timeout: 15_000 })
  if (!models.models?.includes(models.current)) throw new Error('Current model missing from model list')
  record('provider model list', `${models.models.length} models`)

  const alternateModel = models.models.find(model => model !== models.current)
  if (alternateModel) {
    await api('/api/config/model', {
      method: 'PATCH',
      token: cleanup.adminToken,
      body: { model: alternateModel },
    })
    const alternateConfig = await api('/api/config', { timeout: 15_000 })
    if (alternateConfig.model !== alternateModel) throw new Error('Alternate model selection failed')
  }
  await api('/api/config/model', {
    method: 'PATCH',
    token: cleanup.adminToken,
    body: { model: models.current },
  })
  record('model selection and restore', models.current)

  const createdUser = await api('/api/admin/users', {
    method: 'POST',
    token: cleanup.adminToken,
    body: { username, password: initialPassword, role: 'user' },
    expect: 201,
  })
  cleanup.userId = createdUser.id
  record('create user', username)

  const users = await api('/api/admin/users', { token: cleanup.adminToken })
  if (!users.some(user => user.id === createdUser.id)) throw new Error('Created user missing')
  record('list users')

  await api(`/api/admin/users/${createdUser.id}/role`, {
    method: 'PATCH', token: cleanup.adminToken, body: { role: 'admin' },
  })
  await api(`/api/admin/users/${createdUser.id}/role`, {
    method: 'PATCH', token: cleanup.adminToken, body: { role: 'user' },
  })
  record('change user role')

  await api(`/api/admin/users/${createdUser.id}/reset-password`, {
    method: 'POST', token: cleanup.adminToken, body: { newPassword: resetPassword },
  })
  let userLogin = await api('/api/auth/login', {
    method: 'POST', body: { username, password: resetPassword },
  })
  record('reset user password')

  await api('/api/me/password', {
    method: 'PATCH',
    token: userLogin.token,
    body: { currentPassword: resetPassword, newPassword: changedPassword },
  })
  userLogin = await api('/api/auth/login', {
    method: 'POST', body: { username, password: changedPassword },
  })
  const userToken = userLogin.token
  record('user changes own password')

  await api('/api/admin/users', { token: userToken, expect: 403 })
  record('non-admin cannot access user management')

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
  record('create knowledge bases')

  await api(`/api/kbs/${kbA.id}`, {
    method: 'PATCH',
    token: cleanup.adminToken,
    body: { name: `${marker} A updated`, description: 'updated description' },
  })
  const updatedKb = await api(`/api/kbs/${kbA.id}`, { token: cleanup.adminToken })
  if (!updatedKb.name.endsWith('updated')) throw new Error('KB update did not persist')
  record('read and update knowledge base')

  await api(`/api/kbs/${kbA.id}`, { token: userToken, expect: 403 })
  record('private KB denies unassigned user')

  await api(`/api/kbs/${kbA.id}/public`, {
    method: 'PATCH', token: cleanup.adminToken, body: { is_public: true },
  })
  await api(`/api/kbs/${kbA.id}`, { token: userToken })
  await api(`/api/kbs/${kbA.id}/public`, {
    method: 'PATCH', token: cleanup.adminToken, body: { is_public: false },
  })
  record('public/private KB toggle')

  for (const kb of [kbA, kbB]) {
    await api(`/api/kbs/${kb.id}/members`, {
      method: 'POST',
      token: cleanup.adminToken,
      body: { username },
      expect: 201,
    })
  }
  const members = await api(`/api/kbs/${kbA.id}/members`, { token: cleanup.adminToken })
  if (!members.some(member => member.id === createdUser.id)) throw new Error('Member missing')
  await api(`/api/kbs/${kbA.id}`, { token: userToken })
  record('member grant and listing')

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
  record('create text documents')

  const form = new FormData()
  form.append('files', new Blob([`${marker} uploaded file content`], { type: 'text/plain' }), `${marker}.txt`)
  const uploaded = await api(`/api/kbs/${kbA.id}/docs`, {
    method: 'POST', token: cleanup.adminToken, form, expect: 201,
  })
  const uploadDoc = uploaded[0]
  if (uploadDoc.index_status !== 'pending') throw new Error(`Uploaded document did not enter pending state: ${uploadDoc.index_status}`)
  await waitForDocReady(kbA.id, uploadDoc.id, cleanup.adminToken)
  record('upload document file and async indexing')

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
  if (!syncSource.sync_source_path) throw new Error('Sync source path was not saved')

  const syncAdd = await api(`/api/kbs/${kbA.id}/sync`, { method: 'POST', token: cleanup.adminToken })
  if (syncAdd.added !== 1 || syncAdd.queued < 1) throw new Error('Sync add did not queue the new file')
  let syncDocs = await api(`/api/kbs/${kbA.id}/docs?limit=200&offset=0`, { token: cleanup.adminToken })
  let syncDoc = syncDocs.items.find(doc => doc.original_name === syncRelative)
  if (!syncDoc || syncDoc.source_type !== 'sync') throw new Error('Synced document missing after add')
  await waitForDocReady(kbA.id, syncDoc.id, cleanup.adminToken)
  const syncSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent(`SYNC_ADDED_${marker}`)}`, {
    token: cleanup.adminToken,
  })
  if (!syncSearch.length) throw new Error('Synced document was not searchable')

  fs.writeFileSync(syncFile, `# Sync ${marker}\n\nSYNC_UPDATED_${marker}\n`, 'utf8')
  const mtime = new Date(Date.now() + 2000)
  fs.utimesSync(syncFile, mtime, mtime)
  const syncUpdate = await api(`/api/kbs/${kbA.id}/sync`, { method: 'POST', token: cleanup.adminToken })
  if (syncUpdate.updated !== 1 || syncUpdate.queued < 1) throw new Error('Sync update did not queue the changed file')
  await waitForDocReady(kbA.id, syncDoc.id, cleanup.adminToken)
  const syncUpdateSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent(`SYNC_UPDATED_${marker}`)}`, {
    token: cleanup.adminToken,
  })
  if (!syncUpdateSearch.length) throw new Error('Synced document update was not searchable')

  fs.rmSync(syncFile, { force: true })
  const syncRemove = await api(`/api/kbs/${kbA.id}/sync`, { method: 'POST', token: cleanup.adminToken })
  if (syncRemove.removed !== 1) throw new Error('Sync remove did not delete the missing file')
  syncDocs = await api(`/api/kbs/${kbA.id}/docs?limit=200&offset=0`, { token: cleanup.adminToken })
  syncDoc = syncDocs.items.find(doc => doc.original_name === syncRelative)
  if (syncDoc) throw new Error('Removed sync source still has a document record')
  record('local folder sync add/update/remove')

  await api('/api/admin/audit', { token: userToken, expect: 403 })
  const audit = await api(`/api/admin/audit?action=${encodeURIComponent('kb.sync_run')}`, {
    token: cleanup.adminToken,
  })
  if (!audit.items.some(item => item.kb_id === kbA.id && item.action === 'kb.sync_run')) {
    throw new Error('Audit log did not record sync run')
  }
  record('audit log and permissions')

  const docs = await api(`/api/kbs/${kbA.id}/docs`, { token: cleanup.adminToken })
  const pagedDocs = await api(`/api/kbs/${kbA.id}/docs?limit=1&offset=0`, { token: cleanup.adminToken })
  if (docs.length < 2 || pagedDocs.items.length !== 1 || pagedDocs.total < 2) throw new Error('Document listing failed')
  record('document list and pagination')

  const preview = await api(`/api/kbs/${kbA.id}/docs/${docText.id}/preview`, { token: cleanup.adminToken })
  if (!preview.content.includes(marker)) throw new Error('Preview content mismatch')
  await api(`/api/kbs/${kbA.id}/docs/${uploadDoc.id}/preview`, { token: cleanup.adminToken })
  record('document preview')

  const docSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent(marker)}`, {
    token: cleanup.adminToken,
  })
  if (!docSearch.length) throw new Error('Document search returned no results')
  record('full-text document search')

  const chineseSearch = await api(`/api/kbs/${kbA.id}/search/docs?q=${encodeURIComponent('中文子串')}`, {
    token: cleanup.adminToken,
  })
  if (!chineseSearch.length) throw new Error('Chinese substring search returned no results')
  record('Chinese substring document search')

  const reindex = await api(`/api/kbs/${kbA.id}/reindex`, { method: 'POST', token: cleanup.adminToken })
  if (reindex.indexed < 2) throw new Error('Reindex missed documents')
  record('reindex documents', `${reindex.indexed}/${reindex.total}`)

  const stats = await api(`/api/kbs/${kbA.id}/stats`, { token: cleanup.adminToken })
  if (stats.totalDocs < 2) throw new Error('Stats doc count mismatch')
  record('knowledge-base statistics')

  await api(`/api/kbs/${kbA.id}/docs/batch`, {
    method: 'DELETE', token: userToken, body: { ids: [docText.id] }, expect: 403,
  })
  await api(`/api/kbs/${kbA.id}/docs/${docB.id}`, {
    method: 'DELETE', token: cleanup.adminToken, expect: 404,
  })
  const docsB = await api(`/api/kbs/${kbB.id}/docs`, { token: cleanup.adminToken })
  if (!docsB.some(doc => doc.id === docB.id)) throw new Error('Cross-KB document was deleted')
  record('document deletion permissions and KB isolation')

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
    throw new Error('Conversation rename/pin did not persist')
  }
  await api(`/api/conversations/${convA.id}/messages`, { token: userToken })
  record('conversation create, read, rename, pin, list, messages')

  await api(`/api/kbs/${kbA.id}/ask`, {
    method: 'POST',
    token: userToken,
    body: { question: 'must be rejected', conversationId: convB.id },
    expect: 400,
  })
  record('conversation cannot cross knowledge bases')

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
  if (!done || !answer || answer.includes('<think>') || !toolCalls.length) throw new Error('Real model answer failed')
  record('real model answer with tools', `${done.turns} turns`)

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
    throw new Error('Server-managed conversation context was not loaded')
  }

  const storedMessages = await api(`/api/conversations/${done.conversationId}/messages`, { token: userToken })
  if (!storedMessages.length) throw new Error('Model conversation messages were not stored')
  if (storedMessages.some(message => String(message.content ?? '').includes(clientInjection))) {
    throw new Error('Client-provided history was persisted')
  }
  record('server-managed conversation context')

  const convSearch = await api(`/api/search/conversations?q=${encodeURIComponent(marker)}`, { token: userToken })
  if (!convSearch.total) throw new Error('Conversation search returned no results')
  record('conversation persistence and global search')

  const batchDelete = await api('/api/conversations/batch', {
    method: 'DELETE',
    token: userToken,
    body: { ids: [convA.id, convB.id, done.conversationId] },
  })
  if (batchDelete.deleted !== 3) throw new Error('Conversation batch delete failed')
  record('conversation batch delete')

  await api(`/api/kbs/${kbA.id}/docs/${uploadDoc.id}`, {
    method: 'DELETE', token: cleanup.adminToken,
  })
  const docBatchDelete = await api(`/api/kbs/${kbA.id}/docs/batch`, {
    method: 'DELETE', token: cleanup.adminToken, body: { ids: [docText.id] },
  })
  if (docBatchDelete.deleted !== 1) throw new Error('Document batch delete failed')
  record('single and batch document delete')

  await api(`/api/kbs/${kbA.id}/members/${createdUser.id}`, {
    method: 'DELETE', token: cleanup.adminToken,
  })
  await api(`/api/kbs/${kbA.id}`, { token: userToken, expect: 403 })
  record('member revoke')

  console.log(`\nFull smoke passed: ${results.length} checks`)
} finally {
  await cleanupAll()
}
