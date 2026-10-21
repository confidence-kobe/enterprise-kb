/* ── 认证 ─────────────────────────────────────────── */
let token = localStorage.getItem('kb_token')
const user  = JSON.parse(localStorage.getItem('kb_user') || 'null')
if (!token || !user) { location.href = '/login.html' }

const isAdmin = user?.role === 'admin'

/* ── 主题初始化 ─────────────────────────────────────── */
;(function initTheme() {
  const saved = localStorage.getItem('kb_theme')
  const isDark = saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark')
  const btn = document.getElementById('theme-toggle-btn')
  if (btn) {
    btn.textContent = isDark ? '☀️' : '🌙'
    btn.title = isDark ? '切换为浅色模式' : '切换为深色模式'
    btn.addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      if (dark) {
        document.documentElement.removeAttribute('data-theme')
        btn.textContent = '🌙'; btn.title = '切换为深色模式'
        localStorage.setItem('kb_theme', 'light')
      } else {
        document.documentElement.setAttribute('data-theme', 'dark')
        btn.textContent = '☀️'; btn.title = '切换为浅色模式'
        localStorage.setItem('kb_theme', 'dark')
      }
    })
  }
})()

/* ── DOM ──────────────────────────────────────────── */
const toast        = document.getElementById('toast')
const kbList       = document.getElementById('kb-list')
const docKbSelect  = document.getElementById('doc-kb-select')
const docList      = document.getElementById('doc-list')
const uploadArea   = document.getElementById('upload-area')
const uploadZone   = document.getElementById('upload-zone')
const fileInput    = document.getElementById('file-input')
const userList     = document.getElementById('user-list')
const auditList    = document.getElementById('audit-list')
const syncSourcePanel = document.getElementById('sync-source-panel')
const syncPathInput   = document.getElementById('sync-path-input')
const syncStatusEl    = document.getElementById('sync-status')

/* ── 回答反馈常量（初始化时即会用到） ── */
const FEEDBACK_PAGE_SIZE = 20
const feedbackReasonLabels = {
  incorrect:  '答案不正确',
  incomplete: '回答不完整',
  not_found:  '没找到相关资料',
  off_topic:  '答非所问',
  outdated:   '信息过时',
  other:      '其他',
  none:       '未填写原因',
}

/* ── 初始化 ───────────────────────────────────────── */
document.getElementById('user-badge').textContent = isAdmin ? '管理员' : '用户'
document.getElementById('user-badge').className   = `badge badge-${user.role}`

if (isAdmin) {
  document.getElementById('users-tab').style.display = ''
  document.getElementById('audit-tab').style.display = ''
  document.getElementById('feedback-tab').style.display = ''
  document.getElementById('settings-tab').style.display = ''
  loadUsers()
  initModelSettings()
  initBackupSettings()
  initAuditLog()
  initFeedbackTab()
}

loadKbs()
initTabs()
initApiAccess()
initVersionHistory()
initKbModal()
initUserModal()
initUpload()
initLogout()
initMembersModal()
initPwdModal()
initPreviewModal()
initDocBulk()
initReindex()
initTextDocModal()
initSyncSource()
if (isAdmin) initResetPwdModal()

// 事件委托：KB 卡片操作（一次性绑定，覆盖所有渲染周期）
kbList.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const id = Number(btn.dataset.id)
  const kb = allKbs.find(k => k.id === id)
  if (!kb) return
  const action = btn.dataset.action
  if (action === 'open-chat')     openKbChat(id)
  if (action === 'edit')          openKbEditModal(kb)
  if (action === 'members')       openMembersModal(kb)
  if (action === 'toggle-public') togglePublic(id, !kb.is_public)
  if (action === 'delete-kb')     deleteKb(id, kb.name)
})

function auth() { return { Authorization: `Bearer ${token}` } }

function showToast(msg, type = '') {
  toast.textContent = msg
  toast.className = type
  toast.classList.remove('hidden')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3000)
}

/* ── 全局 Escape 关闭弹层 ────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'))
})

/* ── Tab 切换 ─────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
      if (btn.dataset.tab === 'audit' && isAdmin) loadAuditLog(false)
      if (btn.dataset.tab === 'feedback' && isAdmin) loadFeedbackTab()
      if (btn.dataset.tab === 'settings' && isAdmin) loadBackups()
      if (btn.dataset.tab === 'api') loadApiKeys()
    })
  })
}

/* ── 知识库列表 ────────────────────────────────────── */
let allKbs = []
let feedbackMap = {}     // kb_id → { positive, negative }
let feedbackTotals = {}  // { positive, negative, satisfaction }
let initialRouteApplied = false

async function loadKbs() {
  try {
    const res = await fetch('/api/kbs', { headers: auth() })
    if (res.status === 401) { location.href = '/login.html'; return }
    allKbs = await res.json()

    if (isAdmin) {
      try {
        const fr = await fetch('/api/admin/feedback', { headers: auth() })
        if (fr.ok) {
          const data = await fr.json()
          feedbackMap = {}
          for (const s of data.items) feedbackMap[s.kb_id] = s
          feedbackTotals = { positive: data.total_positive, negative: data.total_negative, satisfaction: data.satisfaction }
        }
      } catch { /* 反馈统计不影响主流程 */ }
    }

    renderKbList()
    renderDocKbSelect()
    applyInitialManageRoute()
  } catch {
    kbList.innerHTML = '<div class="empty-state"><div>加载失败，请刷新重试</div></div>'
  }
}

function applyInitialManageRoute() {
  if (initialRouteApplied) return
  initialRouteApplied = true

  const params = new URLSearchParams(location.search)
  const tab = params.get('tab')
  const kbId = Number(params.get('kb'))
  if (tab && document.querySelector(`.tab-btn[data-tab="${tab}"]`)) {
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).click()
  }
  if (tab === 'docs' && kbId && allKbs.some(kb => kb.id === kbId)) {
    docKbSelect.value = String(kbId)
    docKbSelect.dispatchEvent(new Event('change'))
  }
}

function renderKbList() {
  kbList.innerHTML = ''

  // Stats dashboard row
  const totalDocs  = allKbs.reduce((s, k) => s + (k.doc_count  ?? 0), 0)
  const totalConvs = allKbs.reduce((s, k) => s + (k.conv_count ?? 0), 0)
  const statsRow = document.createElement('div')
  statsRow.className = 'manage-stats-row'
  const satisfactionHtml = isAdmin && feedbackTotals.satisfaction != null
    ? `<div class="manage-stat-card">
         <div class="manage-stat-value">${feedbackTotals.satisfaction}%</div>
         <div class="manage-stat-label">回答满意度 👍${feedbackTotals.positive} 👎${feedbackTotals.negative}</div>
       </div>`
    : ''
  statsRow.innerHTML = `
    <div class="manage-stat-card accent">
      <div class="manage-stat-value">${allKbs.length}</div>
      <div class="manage-stat-label">知识库总数</div>
    </div>
    <div class="manage-stat-card">
      <div class="manage-stat-value">${totalDocs.toLocaleString()}</div>
      <div class="manage-stat-label">文档总数</div>
    </div>
    <div class="manage-stat-card">
      <div class="manage-stat-value">${totalConvs.toLocaleString()}</div>
      <div class="manage-stat-label">历史对话</div>
    </div>
    ${satisfactionHtml}
  `
  kbList.appendChild(statsRow)

  if (!allKbs.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.innerHTML = '<div class="empty-state-icon">📭</div><div class="empty-state-text">暂无知识库，点击「新建知识库」创建第一个</div>'
    kbList.appendChild(empty)
    return
  }

  const grid = document.createElement('div')
  grid.className = 'kb-card-grid'
  kbList.appendChild(grid)

  // Accent color palette cycling by kb.id
  const palette = [
    { bar: '#1e40af', icon: '#1e40af', bg: 'rgba(30,64,175,.08)', border: 'rgba(30,64,175,.2)' },
    { bar: '#7c3aed', icon: '#7c3aed', bg: 'rgba(124,58,237,.08)', border: 'rgba(124,58,237,.2)' },
    { bar: '#0891b2', icon: '#0891b2', bg: 'rgba(8,145,178,.08)',  border: 'rgba(8,145,178,.2)'  },
    { bar: '#059669', icon: '#059669', bg: 'rgba(5,150,105,.08)',  border: 'rgba(5,150,105,.2)'  },
    { bar: '#d97706', icon: '#d97706', bg: 'rgba(217,119,6,.08)',  border: 'rgba(217,119,6,.2)'  },
    { bar: '#db2777', icon: '#db2777', bg: 'rgba(219,39,119,.08)', border: 'rgba(219,39,119,.2)' },
  ]

  for (const kb of allKbs) {
    const c = palette[kb.id % palette.length]
    const isOwner = kb.owner_id === user.id || isAdmin

    const card = document.createElement('div')
    card.className = 'kb-card'
    card.innerHTML = `
      <div class="kb-card-accent-bar" style="background:${c.bar}"></div>
      <div class="kb-card-inner">
        <div class="kb-card-header">
          <div class="kb-card-icon" style="color:${c.icon};background:${c.bg};border-color:${c.border}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="20" height="20">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
          </div>
          <div class="kb-card-title-area">
            <div class="kb-card-name">
              ${escHtml(kb.name)}
              ${kb.is_public ? '<span class="badge badge-public">公开</span>' : ''}
            </div>
            ${kb.description ? `<div class="kb-card-desc">${escHtml(kb.description)}</div>` : '<div class="kb-card-desc" style="color:var(--light)">暂无描述</div>'}
          </div>
        </div>
        <div class="kb-card-stats">
          <span class="kb-stat-pill">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1z"/><polyline points="9 1 9 5 13 5"/></svg>
            ${kb.doc_count ?? 0} 文档
          </span>
          <span class="kb-stat-pill">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1z"/></svg>
            ${kb.conv_count ?? 0} 对话
          </span>
          ${kb.last_active ? `<span class="kb-stat-pill">活跃 ${fmtTime(kb.last_active)}</span>` : ''}
          ${(() => { const fb = feedbackMap[kb.id]; return (fb && (fb.positive || fb.negative)) ? `<span class="kb-stat-pill" title="用户反馈">👍 ${fb.positive} 👎 ${fb.negative}</span>` : '' })()}
          <span class="kb-stat-pill" style="margin-left:auto;color:var(--light);font-size:10.5px">ID ${kb.id} · ${fmtTime(kb.created_at)}</span>
        </div>
        <div class="kb-card-actions">
          <button class="btn btn-primary btn-sm" data-action="open-chat" data-id="${kb.id}">进入问答</button>
          ${isOwner ? `
            <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${kb.id}">编辑</button>
            <button class="btn btn-secondary btn-sm" data-action="members" data-id="${kb.id}">成员</button>
            <button class="btn btn-secondary btn-sm" data-action="toggle-public" data-id="${kb.id}" data-public="${kb.is_public ? '1' : '0'}">
              ${kb.is_public ? '设为私有' : '设为公开'}
            </button>
            <button class="btn btn-danger btn-sm" data-action="delete-kb" data-id="${kb.id}">删除</button>
          ` : ''}
        </div>
      </div>
    `
    grid.appendChild(card)
  }
}

function openKbChat(id) {
  localStorage.setItem('kb_last_selected_id', String(id))
  location.href = '/index.html'
}

function renderDocKbSelect() {
  docKbSelect.innerHTML = '<option value="">— 选择知识库 —</option>'
  for (const kb of allKbs) {
    const opt = document.createElement('option')
    opt.value = kb.id
    opt.textContent = kb.name
    docKbSelect.appendChild(opt)
  }
}

async function togglePublic(id, isPublic) {
  await fetch(`/api/kbs/${id}/public`, {
    method: 'PATCH',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_public: isPublic }),
  })
  showToast(isPublic ? '已设为公开' : '已设为私有', 'success')
  loadKbs()
}

async function deleteKb(id, name) {
  if (!confirm(`确认删除知识库「${name}」？\n此操作将同时删除所有文档，不可恢复！`)) return
  const res = await fetch(`/api/kbs/${id}`, { method: 'DELETE', headers: auth() })
  if (res.ok) { showToast('知识库已删除', 'success'); loadKbs() }
  else { showToast('删除失败', 'error') }
}

/* ── 新建/编辑知识库弹层 ────────────────────────────── */
function initKbModal() {
  const modal    = document.getElementById('kb-modal')
  const titleEl  = document.getElementById('kb-modal-title')
  const confirmBtn = document.getElementById('kb-modal-confirm')
  const editIdEl = document.getElementById('kb-edit-id')

  const close = () => { modal.classList.add('hidden'); editIdEl.value = '' }

  function openCreate() {
    titleEl.textContent = '新建知识库'
    confirmBtn.textContent = '创建'
    editIdEl.value = ''
    document.getElementById('kb-name').value = ''
    document.getElementById('kb-desc').value = ''
    document.getElementById('kb-system-prompt').value = ''
    document.getElementById('kb-system-prompt-group').style.display = 'none'
    modal.classList.remove('hidden')
    document.getElementById('kb-name').focus()
  }

  document.getElementById('create-kb-btn').addEventListener('click', openCreate)
  document.getElementById('kb-modal-close').addEventListener('click', close)
  document.getElementById('kb-modal-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  confirmBtn.addEventListener('click', async () => {
    const name = document.getElementById('kb-name').value.trim()
    const desc = document.getElementById('kb-desc').value.trim()
    if (!name) { alert('请输入知识库名称'); return }

    const editId = editIdEl.value
    const systemPrompt = document.getElementById('kb-system-prompt').value.trim()
    let res
    if (editId) {
      // 编辑模式
      res = await fetch(`/api/kbs/${editId}`, {
        method: 'PATCH',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc, system_prompt: systemPrompt || null }),
      })
    } else {
      // 创建模式
      res = await fetch('/api/kbs', {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc }),
      })
    }
    const data = await res.json()
    if (res.ok) {
      showToast(editId ? '知识库已更新' : '知识库创建成功', 'success')
      close()
      loadKbs()
    } else {
      showToast(data.error ?? (editId ? '更新失败' : '创建失败'), 'error')
    }
  })
}

function openKbEditModal(kb) {
  document.getElementById('kb-modal-title').textContent = '编辑知识库'
  document.getElementById('kb-modal-confirm').textContent = '保存'
  document.getElementById('kb-edit-id').value = kb.id
  document.getElementById('kb-name').value = kb.name
  document.getElementById('kb-desc').value = kb.description ?? ''
  document.getElementById('kb-system-prompt').value = kb.system_prompt ?? ''
  document.getElementById('kb-system-prompt-group').style.display = ''
  document.getElementById('kb-modal').classList.remove('hidden')
  document.getElementById('kb-name').focus()
}

/* ── 文档管理 ──────────────────────────────────────── */
let currentDocKbId = null
const selectedDocIds = new Set()

docKbSelect.addEventListener('change', () => {
  currentDocKbId = docKbSelect.value ? Number(docKbSelect.value) : null
  const docSearch = document.getElementById('doc-search')
  if (docSearch) docSearch.value = ''
  document.getElementById('doc-search-count').textContent = ''
  renderSyncSourcePanel()
  if (currentDocKbId) { uploadArea.classList.remove('hidden'); loadDocs() }
  else { uploadArea.classList.add('hidden') }
})

// 文档内容搜索（防抖 300ms）
let docSearchTimer = null
document.addEventListener('input', e => {
  if (e.target.id !== 'doc-search') return
  clearTimeout(docSearchTimer)
  const q = e.target.value.trim()
  if (!q) { loadDocs(); document.getElementById('doc-search-count').textContent = ''; return }
  docSearchTimer = setTimeout(() => searchDocContent(q), 300)
})

async function searchDocContent(q) {
  if (!currentDocKbId) return
  docList.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:13px">搜索中…</div>'
  try {
    const res     = await fetch(`/api/kbs/${currentDocKbId}/search/docs?q=${encodeURIComponent(q)}&limit=20`, { headers: auth() })
    const results = await res.json()
    const countEl = document.getElementById('doc-search-count')
    countEl.textContent = results.length ? `找到 ${results.length} 处匹配` : '未找到匹配'
    docList.innerHTML = ''
    if (!results.length) {
      docList.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px">未找到相关内容</div>'
      return
    }
    for (const r of results) {
      const item = document.createElement('div')
      item.className = 'doc-item doc-search-result'
      const snippet = r.snippet.replace(/>>>/g, '<mark>').replace(/<<</g, '</mark>')
      item.innerHTML = `
        <span class="doc-name" title="${escHtml(r.original_name)}">${escHtml(r.original_name)}</span>
        <span class="doc-size" style="color:var(--light);font-size:11px">行 ${r.chunk_line}</span>
        <div class="doc-snippet">${snippet}</div>
      `
      docList.appendChild(item)
    }
  } catch (e) {
    docList.innerHTML = `<div style="padding:10px;color:var(--red);font-size:13px">搜索失败：${escHtml(e.message)}</div>`
  }
}

const DOC_PAGE_SIZE = 30
let docOffset = 0
let docTotal  = 0
let docRefreshTimer = null

function docStatusBadge(doc) {
  const status = doc.index_status ?? 'ready'
  const labels = {
    pending: '待解析',
    processing: '解析中',
    ready: doc.index_version ? '已索引' : '未索引',
    error: '失败',
  }
  const title = status === 'error' && doc.index_error
    ? ` title="${escHtml(doc.index_error)}"`
    : ''
  return `<span class="doc-status doc-status-${status}"${title}>${labels[status] ?? status}</span>`
}

function docSourceBadge(doc) {
  if (doc.source_type !== 'sync') return ''
  const title = doc.source_path ? ` title="${escHtml(doc.source_path)}"` : ''
  return `<span class="doc-source doc-source-sync"${title}>同步</span>`
}

function vectorBadge(doc) {
  // Show vector coverage if the doc object exposes chunk/vec counts
  const chunks = doc.chunk_count ?? doc.chunks ?? 0
  const vecs   = doc.vec_count  ?? doc.vecs   ?? 0
  if (!chunks) return ''
  const pct = Math.round((vecs / chunks) * 100)
  const cls  = pct >= 90 ? 'vec-badge-full' : pct >= 40 ? 'vec-badge-partial' : 'vec-badge-low'
  return `<span class="doc-vec-badge ${cls}" title="向量覆盖率 ${pct}%（${vecs}/${chunks} 块）">⚡ ${pct}%</span>`
}

async function loadDocs(append = false) {
  if (!currentDocKbId) return
  if (docRefreshTimer) {
    clearTimeout(docRefreshTimer)
    docRefreshTimer = null
  }
  if (!append) {
    docOffset = 0
    docList.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:13px">加载中…</div>'
  }

  const res  = await fetch(
    `/api/kbs/${currentDocKbId}/docs?limit=${DOC_PAGE_SIZE}&offset=${docOffset}`,
    { headers: auth() }
  )
  const data = await res.json()
  const docs = data.items ?? data   // 兼容无分页格式

  if (!append) {
    docList.innerHTML = ''
    docTotal = data.total ?? docs.length
  }

  // Show / hide table header
  const tableHeader = document.getElementById('doc-table-header')
  if (tableHeader) tableHeader.style.display = !docs.length && !append ? 'none' : ''

  if (!docs.length && !append) {
    docList.innerHTML = '<div class="empty-state" style="padding:24px"><div class="empty-state-icon">📄</div><div class="empty-state-text">暂无文档，请上传</div></div>'
    document.getElementById('doc-bulk-bar').classList.add('hidden')
    selectedDocIds.clear()
    return
  }

  for (const doc of docs) {
    const item = document.createElement('div')
    item.className = 'doc-row'
    const vecBadge = vectorBadge(doc)
    item.innerHTML = `
      <input type="checkbox" class="doc-cb" data-cb-id="${doc.id}">
      <span class="doc-name" title="${escHtml(doc.original_name)}">${escHtml(doc.original_name)}${doc.source_type === 'sync' ? ' <span class="doc-source doc-source-sync" title="本地同步">同步</span>' : doc.source_type === 'text' ? ' <span class="doc-source doc-source-text" title="内联文本文档">文本</span>' : ''}</span>
      ${docStatusBadge(doc)}
      <span class="doc-size">${fmtSize(doc.size)}</span>
      <span>${vecBadge}</span>
      <div class="doc-row-actions">
        ${doc.source_type === 'text' && canWriteCurrentKb() ? `<button class="btn btn-secondary btn-sm" data-edit-id="${doc.id}" data-edit-name="${escHtml(doc.original_name)}" title="编辑文档">编辑</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-preview-id="${doc.id}" title="预览文档内容">预览</button>
        ${doc.source_type === 'text' ? `<button class="btn btn-secondary btn-sm" data-history-id="${doc.id}" title="查看和恢复历史版本">历史</button>` : ''}
        ${canManageCurrentKb() ? `<button class="btn btn-danger btn-sm" data-doc-id="${doc.id}" title="删除文档">删除</button>` : ''}
      </div>
    `
    const cb = item.querySelector('.doc-cb')
    cb.checked = selectedDocIds.has(doc.id)
    cb.addEventListener('change', () => {
      if (cb.checked) selectedDocIds.add(doc.id)
      else selectedDocIds.delete(doc.id)
      updateBulkBar()
      syncSelectAllCheckbox()
    })
    item.querySelector('[data-preview-id]').addEventListener('click', () => previewDoc(doc.id, doc.original_name, doc.summary))
    item.querySelector('[data-doc-id]')?.addEventListener('click', () => deleteDoc(doc.id, doc.original_name))
    item.querySelector('[data-history-id]')?.addEventListener('click', () => openVersionHistory(doc.id, doc.original_name))
    if (doc.source_type === 'text') {
      item.querySelector('[data-edit-id]')?.addEventListener('click', async () => {
        try {
          const r = await fetch(`/api/kbs/${currentDocKbId}/docs/${doc.id}/preview`, { headers: auth() })
          const d = await r.json()
          const titleWithoutExt = doc.original_name.replace(/\.md$/i, '')
          window._openTextDocModal?.({ docId: doc.id, title: titleWithoutExt, content: d.content ?? '' })
        } catch { showToast('加载文档失败', 'error') }
      })
    }
    docList.appendChild(item)
  }

  docOffset += docs.length

  // "加载更多" 按钮
  const existingMore = document.getElementById('doc-load-more')
  if (existingMore) existingMore.remove()
  if (docOffset < docTotal) {
    const btn = document.createElement('button')
    btn.id = 'doc-load-more'
    btn.className = 'conv-load-more'
    btn.textContent = `加载更多（${docTotal - docOffset} 个）`
    btn.addEventListener('click', () => loadDocs(true))
    docList.appendChild(btn)
  }

  document.getElementById('doc-bulk-bar').classList.toggle('hidden', !canManageCurrentKb())
  if (tableHeader) tableHeader.style.display = ''
  if (!append) { selectedDocIds.clear(); updateBulkBar(); syncSelectAllCheckbox() }
  updateBulkBar()
  const hasActiveIndexJobs = docs.some(doc => ['pending', 'processing'].includes(doc.index_status))
  if (!append && hasActiveIndexJobs) {
    docRefreshTimer = setTimeout(() => loadDocs(false), 3000)
  }
}

function updateBulkBar() {
  const count = selectedDocIds.size
  document.getElementById('doc-selected-count').textContent = `已选 ${count} 项`
  document.getElementById('doc-bulk-delete-btn').disabled = count === 0
}

function syncSelectAllCheckbox() {
  const allCbs   = [...document.querySelectorAll('.doc-cb')]
  const selectAll = document.getElementById('doc-select-all')
  if (!allCbs.length) { selectAll.checked = false; selectAll.indeterminate = false; return }
  const checked = allCbs.filter(c => c.checked).length
  selectAll.checked = checked === allCbs.length
  selectAll.indeterminate = checked > 0 && checked < allCbs.length
}

function initDocBulk() {
  document.getElementById('doc-select-all').addEventListener('change', e => {
    const checked = e.target.checked
    document.querySelectorAll('.doc-cb').forEach(cb => {
      cb.checked = checked
      const id = Number(cb.dataset.cbId)
      if (checked) selectedDocIds.add(id)
      else selectedDocIds.delete(id)
    })
    updateBulkBar()
  })

  document.getElementById('doc-bulk-delete-btn').addEventListener('click', async () => {
    if (!currentDocKbId || selectedDocIds.size === 0) return
    if (!confirm(`确定删除选中的 ${selectedDocIds.size} 个文档？此操作不可撤销`)) return
    const ids = [...selectedDocIds]
    try {
      const res = await fetch(`/api/kbs/${currentDocKbId}/docs/batch`, {
        method: 'DELETE',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) { showToast('批量删除失败', 'error'); return }
      const data = await res.json()
      showToast(`已删除 ${data.deleted} 个文档`, 'success')
      selectedDocIds.clear()
      loadDocs()
    } catch { showToast('网络错误', 'error') }
  })
}

function initReindex() {
  const btn      = document.getElementById('reindex-btn')
  const statusEl = document.getElementById('reindex-status')
  if (!btn) return

  btn.addEventListener('click', async () => {
    if (!currentDocKbId) { showToast('请先选择知识库', 'error'); return }
    if (!confirm('重建索引将重新处理该知识库下所有文档，可能需要一些时间。确认继续？')) return

    btn.disabled = true
    btn.textContent = '索引中…'
    statusEl.textContent = ''
    try {
      const res  = await fetch(`/api/kbs/${currentDocKbId}/reindex`, { method: 'POST', headers: auth() })
      const data = await res.json()
      if (res.ok) {
        statusEl.textContent = `已索引 ${data.indexed}/${data.total} 个文档`
        showToast(`索引完成：${data.indexed}/${data.total} 个文档`, 'success')
      } else {
        showToast(data.error ?? '重建索引失败', 'error')
      }
    } catch {
      showToast('网络错误', 'error')
    } finally {
      btn.disabled = false
      btn.textContent = '重建索引'
    }
  })
}

function selectedDocKb() {
  return allKbs.find(kb => kb.id === currentDocKbId) ?? null
}

function canManageCurrentKb() {
  const kb = selectedDocKb()
  return Boolean(kb && (isAdmin || kb.owner_id === user.id))
}

/** 当前用户能否向所选知识库写入文档（上传、新建、编辑） */
function canWriteCurrentKb() {
  const kb = selectedDocKb()
  return Boolean(kb && (isAdmin || kb.can_write))
}

/** 只读知识库隐藏上传、新建入口，并给出提示 */
function renderDocWriteControls() {
  const writable = canWriteCurrentKb()
  uploadZone?.classList.toggle('hidden', !writable)
  document.getElementById('new-text-doc-btn')?.classList.toggle('hidden', !writable)
  document.getElementById('new-text-doc-divider')?.classList.toggle('hidden', !writable)
  document.getElementById('reindex-btn')?.classList.toggle('hidden', !canManageCurrentKb())
  let notice = document.getElementById('doc-readonly-notice')
  if (!notice && uploadZone) {
    notice = document.createElement('div')
    notice.id = 'doc-readonly-notice'
    notice.className = 'doc-readonly-notice'
    notice.textContent = '你对这个知识库只有查看权限。如需添加或修改文档，请联系知识库所有者把你加为成员。'
    uploadZone.before(notice)
  }
  notice?.classList.toggle('hidden', writable || !selectedDocKb())
}

function renderSyncSourcePanel() {
  renderDocWriteControls()
  if (!syncSourcePanel) return
  const kb = selectedDocKb()
  if (!kb || !canManageCurrentKb()) {
    syncSourcePanel.classList.add('hidden')
    if (syncPathInput) syncPathInput.value = ''
    if (syncStatusEl) syncStatusEl.textContent = ''
    return
  }
  // 只有管理员能设置同步目录；所有者可对管理员设置好的目录执行同步
  if (!isAdmin && !kb.sync_source_path) {
    syncSourcePanel.classList.add('hidden')
    if (syncPathInput) syncPathInput.value = ''
    if (syncStatusEl) syncStatusEl.textContent = ''
    return
  }
  syncSourcePanel.classList.remove('hidden')
  syncPathInput.value = kb.sync_source_path || ''
  syncPathInput.disabled = !isAdmin
  syncPathInput.title = isAdmin ? '' : '同步目录由管理员设置'
  document.getElementById('sync-save-btn')?.classList.toggle('hidden', !isAdmin)
  if (kb.sync_last_result) {
    try {
      const last = JSON.parse(kb.sync_last_result)
      syncStatusEl.textContent = `上次：新增 ${last.added || 0} / 更新 ${last.updated || 0} / 删除 ${last.removed || 0}`
    } catch {
      syncStatusEl.textContent = kb.sync_last_result
    }
  } else {
    syncStatusEl.textContent = ''
  }
}

function syncSummaryText(summary) {
  const skipped = summary.skipped
    ? Object.values(summary.skipped).reduce((sum, value) => sum + Number(value || 0), 0)
    : 0
  return `新增 ${summary.added || 0} / 更新 ${summary.updated || 0} / 删除 ${summary.removed || 0} / 跳过 ${skipped}`
}

function updateKbLocal(id, patch) {
  const idx = allKbs.findIndex(kb => kb.id === id)
  if (idx >= 0) allKbs[idx] = { ...allKbs[idx], ...patch }
}

function initSyncSource() {
  const saveBtn = document.getElementById('sync-save-btn')
  const runBtn  = document.getElementById('sync-run-btn')
  if (!saveBtn || !runBtn) return

  async function savePath() {
    if (!currentDocKbId || !canManageCurrentKb()) return
    const nextPath = syncPathInput.value.trim()
    saveBtn.disabled = true
    try {
      const res = await fetch(`/api/kbs/${currentDocKbId}/sync-source`, {
        method: 'PATCH',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: nextPath || null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '保存失败')
      updateKbLocal(currentDocKbId, { sync_source_path: data.sync_source_path, sync_last_result: null })
      renderSyncSourcePanel()
      showToast(data.sync_source_path ? '同步路径已保存' : '同步路径已清空', 'success')
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      saveBtn.disabled = false
    }
  }

  saveBtn.addEventListener('click', savePath)
  syncPathInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') savePath()
  })

  runBtn.addEventListener('click', async () => {
    if (!currentDocKbId || !canManageCurrentKb()) return
    if (!syncPathInput.value.trim()) {
      showToast('请先保存同步路径', 'error')
      return
    }
    runBtn.disabled = true
    runBtn.textContent = '同步中…'
    syncStatusEl.textContent = ''
    try {
      const res  = await fetch(`/api/kbs/${currentDocKbId}/sync`, { method: 'POST', headers: auth() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '同步失败')
      const text = syncSummaryText(data)
      syncStatusEl.textContent = text
      updateKbLocal(currentDocKbId, { sync_last_result: JSON.stringify(data) })
      showToast(`同步完成：${text}`, 'success')
      loadDocs()
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      runBtn.disabled = false
      runBtn.textContent = '立即同步'
    }
  })
}

async function deleteDoc(id, name) {
  if (!confirm(`确认删除文档「${name}」？`)) return
  const res = await fetch(`/api/kbs/${currentDocKbId}/docs/${id}`, { method: 'DELETE', headers: auth() })
  if (res.ok) { showToast('文档已删除', 'success'); loadDocs() }
  else { showToast('删除失败', 'error') }
}

function initPreviewModal() {
  const modal = document.getElementById('preview-modal')
  const close = () => {
    modal.classList.add('hidden')
    document.getElementById('preview-content').textContent = ''
    document.getElementById('preview-truncated-hint').classList.add('hidden')
  }
  document.getElementById('preview-modal-close').addEventListener('click', close)
  document.getElementById('preview-modal-close2').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })
}

async function previewDoc(docId, originalName, summary) {
  const modal     = document.getElementById('preview-modal')
  const titleEl   = document.getElementById('preview-modal-title')
  const contentEl = document.getElementById('preview-content')
  const hintEl    = document.getElementById('preview-truncated-hint')
  const summaryEl = document.getElementById('preview-doc-summary')
  const relatedEl = document.getElementById('related-docs-list')
  const relatedPane = document.getElementById('preview-related-pane')

  titleEl.textContent = `预览 — ${originalName}`
  contentEl.textContent = '加载中…'
  hintEl.classList.add('hidden')
  if (summary) {
    summaryEl.textContent = `💡 AI 摘要：${summary}`
    summaryEl.classList.remove('hidden')
  } else {
    summaryEl.classList.add('hidden')
  }
  relatedEl.innerHTML = '<div class="related-loading">加载中…</div>'
  relatedPane.classList.remove('hidden')
  modal.classList.remove('hidden')

  // 主内容与关联推荐并行加载
  const [previewRes, relatedRes] = await Promise.allSettled([
    fetch(`/api/kbs/${currentDocKbId}/docs/${docId}/preview`, { headers: auth() }),
    fetch(`/api/kbs/${currentDocKbId}/docs/${docId}/related`, { headers: auth() }),
  ])

  // 渲染预览内容
  try {
    const res = previewRes.status === 'fulfilled' ? previewRes.value : null
    if (!res) throw new Error('请求失败')
    if (res.status === 415) {
      const e = await res.json().catch(() => ({}))
      contentEl.textContent = `该文件类型（${e.type ?? ''}）不支持预览`
    } else if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      contentEl.textContent = `加载失败：${e.error ?? res.status}`
    } else {
      const data = await res.json()
      contentEl.textContent = data.content
      contentEl.className = `preview-content lang-${data.displayExt.replace('.', '')}`
      if (data.truncated && data.truncatedHint) {
        hintEl.textContent = data.truncatedHint
        hintEl.classList.remove('hidden')
      }
    }
  } catch (e) {
    contentEl.textContent = `网络错误：${e.message}`
  }

  // 渲染关联推荐
  try {
    const res = relatedRes.status === 'fulfilled' ? relatedRes.value : null
    if (!res || !res.ok) throw new Error('unavailable')
    const data = await res.json()
    if (!data.items?.length) {
      relatedPane.classList.add('hidden')
    } else {
      relatedEl.innerHTML = data.items.map(item => `
        <div class="related-doc-item" data-doc-id="${item.doc_id}" title="${item.original_name}">
          <span class="related-doc-name">${item.original_name}</span>
          <span class="related-doc-score">${Math.round(item.similarity * 100)}%</span>
        </div>
      `).join('')
      relatedEl.querySelectorAll('.related-doc-item').forEach(el => {
        el.addEventListener('click', () => {
          previewDoc(Number(el.dataset.docId), el.querySelector('.related-doc-name').textContent)
        })
      })
    }
  } catch {
    relatedPane.classList.add('hidden')
  }
}

function initUpload() {
  uploadZone.addEventListener('click', () => fileInput.click())

  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over') })
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'))
  uploadZone.addEventListener('drop', e => {
    e.preventDefault()
    uploadZone.classList.remove('drag-over')
    uploadFiles(Array.from(e.dataTransfer.files))
  })

  fileInput.addEventListener('change', () => {
    uploadFiles(Array.from(fileInput.files))
    fileInput.value = ''
  })
}

function uploadFiles(files) {
  if (!currentDocKbId || !files.length) return

  const form = new FormData()
  for (const f of files) form.append('files', f)

  const progressWrap = document.getElementById('upload-progress-wrap')
  const progressBar  = document.getElementById('upload-progress-bar')
  const progressPct  = document.getElementById('upload-progress-pct')
  const progressText = document.getElementById('upload-progress-text')

  uploadZone.style.opacity = '.5'
  progressWrap.classList.remove('hidden')
  progressBar.style.width = '0%'
  progressBar.style.background = ''
  progressPct.textContent = '0%'
  progressText.textContent = `上传 ${files.length} 个文件…`

  const xhr = new XMLHttpRequest()
  xhr.open('POST', `/api/kbs/${currentDocKbId}/docs`)
  xhr.setRequestHeader('Authorization', `Bearer ${token}`)

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100)
      progressBar.style.width = pct + '%'
      progressPct.textContent = pct + '%'
    }
  }

  xhr.onload = () => {
    uploadZone.style.opacity = '1'
    progressBar.style.width = '100%'
    if (xhr.status >= 200 && xhr.status < 300) {
      progressText.textContent = '上传成功，已加入解析队列'
      progressPct.textContent = '100%'
      showToast(`成功上传 ${files.length} 个文件，正在后台解析`, 'success')
      loadDocs()
    } else {
      let errMsg = '上传失败'
      try { errMsg = JSON.parse(xhr.responseText)?.error ?? errMsg } catch {}
      progressText.textContent = errMsg
      progressBar.style.background = 'var(--red)'
      showToast(errMsg, 'error')
    }
    setTimeout(() => {
      progressWrap.classList.add('hidden')
      progressBar.style.background = ''
    }, 2000)
  }

  xhr.onerror = () => {
    uploadZone.style.opacity = '1'
    progressWrap.classList.add('hidden')
    showToast('网络错误，上传失败', 'error')
  }

  xhr.send(form)
}

/* ── 用户管理 ──────────────────────────────────────── */
async function loadUsers() {
  const res   = await fetch('/api/admin/users', { headers: auth() })
  const users = await res.json()

  userList.innerHTML = ''
  for (const u of users) {
    const tr = document.createElement('tr')
    const isSelf = u.id === user.id
    tr.innerHTML = `
      <td><strong>${escHtml(u.username)}</strong></td>
      <td>
        <select class="input input-sm role-select" data-uid="${u.id}" ${isSelf ? 'disabled' : ''}>
          <option value="user"  ${u.role === 'user'  ? 'selected' : ''}>普通用户</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select>
      </td>
      <td style="color:var(--muted)">${fmtTime(u.created_at)}</td>
      <td style="display:flex;gap:6px;align-items:center">
        ${isSelf
          ? '<span style="color:var(--muted);font-size:12px">当前用户</span>'
          : `<button class="btn btn-secondary btn-sm" data-action="reset-pwd" data-uid="${u.id}">重置密码</button>
             <button class="btn btn-danger btn-sm" data-action="del-user" data-uid="${u.id}">删除</button>`
        }
      </td>
    `
    if (!isSelf) {
      tr.querySelector('[data-action="reset-pwd"]').addEventListener('click',
        () => openResetPwdModal(u.id, u.username))
      tr.querySelector('[data-action="del-user"]').addEventListener('click',
        () => deleteUser(u.id, u.username))
      tr.querySelector('.role-select').addEventListener('change', async e => {
        const role = e.target.value
        const res = await fetch(`/api/admin/users/${u.id}/role`, {
          method: 'PATCH',
          headers: { ...auth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        })
        if (!res.ok) { showToast('修改角色失败', 'error'); loadUsers() }
        else showToast('角色已更新', 'success')
      })
    }
    userList.appendChild(tr)
  }
}

async function deleteUser(id, name) {
  if (!confirm(`确认删除用户「${name}」？该用户的数据将保留但无法登录。`)) return
  const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: auth() })
  if (res.ok) { showToast('用户已删除', 'success'); loadUsers() }
  else { showToast('删除失败', 'error') }
}

function initUserModal() {
  const modal = document.getElementById('user-modal')
  const open  = () => { ['new-username','new-password'].forEach(id => document.getElementById(id).value = ''); modal.classList.remove('hidden') }
  const close = () => modal.classList.add('hidden')

  document.getElementById('create-user-btn').addEventListener('click', open)
  document.getElementById('user-modal-close').addEventListener('click', close)
  document.getElementById('user-modal-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('user-modal-confirm').addEventListener('click', async () => {
    const username = document.getElementById('new-username').value.trim()
    const password = document.getElementById('new-password').value
    const role     = document.getElementById('new-role').value

    if (!username || !password) { alert('请填写用户名和密码'); return }

    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    })
    const data = await res.json()
    if (res.ok) { showToast('用户创建成功', 'success'); close(); loadUsers() }
    else { showToast(data.error ?? '创建失败', 'error') }
  })
}

/* ── 审计日志 ──────────────────────────────────────── */
const AUDIT_PAGE_SIZE = 40
let auditOffset = 0
let auditTotal = 0
let auditLoading = false

const auditActionLabels = {
  'auth.login': '登录成功',
  'auth.login_failed': '登录失败',
  'user.password_changed': '修改密码',
  'admin.user_create': '创建用户',
  'admin.user_delete': '删除用户',
  'admin.user_role_update': '修改角色',
  'admin.user_password_reset': '重置密码',
  'kb.create': '创建知识库',
  'kb.update': '更新知识库',
  'kb.delete': '删除知识库',
  'kb.public_update': '公开设置',
  'kb.member_add': '添加成员',
  'kb.member_remove': '移除成员',
  'kb.sync_source_update': '保存同步路径',
  'kb.sync_source_clear': '清空同步路径',
  'kb.sync_run': '执行同步',
  'doc.upload': '上传文档',
  'doc.create_text': '新建文档',
  'doc.delete': '删除文档',
  'doc.batch_delete': '批量删除文档',
  'doc.reindex': '重建索引',
  'conversation.delete': '删除对话',
  'conversation.batch_delete': '批量删除对话',
  'config.model_update': '切换模型',
  'apikey.create': '创建 API 密钥',
  'apikey.revoke': '撤销 API 密钥',
}

function initAuditLog() {
  const refreshBtn = document.getElementById('audit-refresh-btn')
  const loadMoreBtn = document.getElementById('audit-load-more')
  const actionInput = document.getElementById('audit-action-filter')
  const userInput = document.getElementById('audit-user-filter')
  if (!refreshBtn || !loadMoreBtn) return

  refreshBtn.addEventListener('click', () => loadAuditLog(false))
  loadMoreBtn.addEventListener('click', () => loadAuditLog(true))
  ;[actionInput, userInput].filter(Boolean).forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') loadAuditLog(false)
    })
  })
}

async function loadAuditLog(append = false) {
  if (!isAdmin || auditLoading || !auditList) return
  auditLoading = true
  if (!append) {
    auditOffset = 0
    auditList.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">加载中…</td></tr>'
  }

  const params = new URLSearchParams({
    limit: String(AUDIT_PAGE_SIZE),
    offset: String(auditOffset),
  })
  const action = document.getElementById('audit-action-filter')?.value.trim()
  const username = document.getElementById('audit-user-filter')?.value.trim()
  if (action) params.set('action', action)
  if (username) params.set('username', username)

  try {
    const res = await fetch(`/api/admin/audit?${params.toString()}`, { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载审计日志失败')
    if (!append) {
      auditList.innerHTML = ''
      auditTotal = data.total || 0
    }
    if (!data.items.length && !append) {
      auditList.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">暂无审计记录</td></tr>'
    }
    for (const item of data.items) auditList.appendChild(renderAuditRow(item))
    auditOffset += data.items.length
    const loadMoreBtn = document.getElementById('audit-load-more')
    loadMoreBtn.classList.toggle('hidden', auditOffset >= auditTotal)
  } catch (e) {
    auditList.innerHTML = `<tr><td colspan="6" style="color:var(--red)">加载失败：${escHtml(e.message)}</td></tr>`
  } finally {
    auditLoading = false
  }
}

/* ── 回答反馈 ───────────────────────────────────── */
let feedbackOffset = 0
let feedbackTotal = 0
let feedbackLoading = false

function initFeedbackTab() {
  const filter = document.getElementById('feedback-reason-filter')
  if (!filter) return
  for (const [value, label] of Object.entries(feedbackReasonLabels)) {
    filter.insertAdjacentHTML('beforeend', `<option value="${value}">${escHtml(label)}</option>`)
  }
  filter.addEventListener('change', () => loadNegativeFeedback(false))
  document.getElementById('gap-days')?.addEventListener('change', () => loadKnowledgeGaps())
  document.getElementById('feedback-refresh-btn').addEventListener('click', () => loadFeedbackTab())
  document.getElementById('feedback-load-more').addEventListener('click', () => loadNegativeFeedback(true))
}

function loadFeedbackTab() {
  loadFeedbackSummary()
  loadKnowledgeGaps()
  loadNegativeFeedback(false)
}

async function loadKnowledgeGaps() {
  const listEl = document.getElementById('gap-list')
  if (!listEl) return
  const days = document.getElementById('gap-days')?.value || '30'
  listEl.innerHTML = '<div class="feedback-empty">加载中…</div>'
  try {
    const res = await fetch(`/api/admin/gaps?days=${encodeURIComponent(days)}`, { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    if (!data.items.length) {
      listEl.innerHTML = `<div class="feedback-empty">近 ${data.days} 天没有发现知识空白。</div>`
      return
    }
    listEl.innerHTML = data.items.map(gap => {
      const tags = [
        gap.sources.ai_not_found ? `<span class="gap-tag">AI 未找到 ×${gap.sources.ai_not_found}</span>` : '',
        gap.sources.feedback_not_found ? `<span class="gap-tag gap-tag-user">用户反馈 ×${gap.sources.feedback_not_found}</span>` : '',
      ].join('')
      return `
        <div class="gap-row">
          <span class="gap-count" title="被问到的次数">${gap.count}</span>
          <div class="gap-main">
            <div class="gap-question">${escHtml(gap.question)}</div>
            <div class="gap-meta">${escHtml(gap.kb_name)} · 最近 ${fmtDateTime(gap.last_at)} ${tags}</div>
          </div>
        </div>`
    }).join('')
  } catch (e) {
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

async function loadFeedbackSummary() {
  const statsEl = document.getElementById('feedback-stats')
  const barsEl = document.getElementById('feedback-reason-bars')
  try {
    const res = await fetch('/api/admin/feedback', { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    const total = data.total_positive + data.total_negative
    statsEl.innerHTML = `
      <div class="manage-stat-card accent">
        <div class="manage-stat-value">${data.satisfaction != null ? `${data.satisfaction}%` : '—'}</div>
        <div class="manage-stat-label">回答满意度</div>
      </div>
      <div class="manage-stat-card">
        <div class="manage-stat-value">${total.toLocaleString()}</div>
        <div class="manage-stat-label">收到的评价</div>
      </div>
      <div class="manage-stat-card">
        <div class="manage-stat-value">${data.total_positive.toLocaleString()}</div>
        <div class="manage-stat-label">👍 有帮助</div>
      </div>
      <div class="manage-stat-card">
        <div class="manage-stat-value">${data.total_negative.toLocaleString()}</div>
        <div class="manage-stat-label">👎 没帮助</div>
      </div>
    `
    const reasons = data.reasons || []
    const negTotal = reasons.reduce((s, r) => s + r.count, 0)
    if (!negTotal) {
      barsEl.innerHTML = '<div class="feedback-empty">还没有差评。</div>'
      return
    }
    barsEl.innerHTML = reasons.map(r => {
      const key = r.reason ?? 'none'
      const pct = Math.round((r.count / negTotal) * 100)
      return `
        <button type="button" class="feedback-bar-row" data-reason="${key}" title="只看「${escHtml(feedbackReasonLabels[key] || key)}」">
          <span class="feedback-bar-label">${escHtml(feedbackReasonLabels[key] || key)}</span>
          <span class="feedback-bar-track"><span class="feedback-bar-fill" style="width:${pct}%"></span></span>
          <span class="feedback-bar-count">${r.count} · ${pct}%</span>
        </button>`
    }).join('')
    barsEl.querySelectorAll('.feedback-bar-row').forEach(row => row.addEventListener('click', () => {
      document.getElementById('feedback-reason-filter').value = row.dataset.reason
      loadNegativeFeedback(false)
    }))
  } catch (e) {
    statsEl.innerHTML = ''
    barsEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

async function loadNegativeFeedback(append = false) {
  const listEl = document.getElementById('feedback-list')
  if (!isAdmin || feedbackLoading || !listEl) return
  feedbackLoading = true
  if (!append) {
    feedbackOffset = 0
    listEl.innerHTML = '<div class="feedback-empty">加载中…</div>'
  }
  const params = new URLSearchParams({ limit: String(FEEDBACK_PAGE_SIZE), offset: String(feedbackOffset) })
  const reason = document.getElementById('feedback-reason-filter').value
  if (reason) params.set('reason', reason)
  try {
    const res = await fetch(`/api/admin/feedback/negative?${params.toString()}`, { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    if (!append) {
      listEl.innerHTML = ''
      feedbackTotal = data.total || 0
    }
    if (!data.items.length && !append) {
      listEl.innerHTML = `<div class="feedback-empty">${reason ? '没有符合条件的差评。' : '还没有差评。'}</div>`
    }
    for (const item of data.items) listEl.appendChild(renderFeedbackItem(item))
    feedbackOffset += data.items.length
    document.getElementById('feedback-load-more').classList.toggle('hidden', feedbackOffset >= feedbackTotal)
  } catch (e) {
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  } finally {
    feedbackLoading = false
  }
}

function renderFeedbackItem(item) {
  const el = document.createElement('div')
  el.className = 'card feedback-item'
  const reasonKey = item.reason ?? 'none'
  el.innerHTML = `
    <div class="feedback-item-head">
      <span class="feedback-reason-tag${item.reason ? '' : ' muted'}">${escHtml(feedbackReasonLabels[reasonKey] || reasonKey)}</span>
      <span class="feedback-item-meta">${escHtml(item.kb_name)} · ${escHtml(item.username || '已删除用户')} · ${fmtDateTime(item.created_at)}</span>
    </div>
    ${item.comment ? `<div class="feedback-item-comment">“${escHtml(item.comment)}”</div>` : ''}
    <div class="feedback-item-qa"><span>问</span><div>${escHtml(item.question || '（无提问记录）')}</div></div>
    <div class="feedback-item-qa"><span>答</span><div class="feedback-item-answer">${escHtml(item.answer || '（无回答记录）')}</div></div>
  `
  return el
}

function renderAuditRow(item) {
  const tr = document.createElement('tr')
  const detail = formatAuditDetail(item.detail)
  tr.innerHTML = `
    <td style="white-space:nowrap;color:var(--muted)">${fmtDateTime(item.created_at)}</td>
    <td>${escHtml(item.username || '系统')}</td>
    <td><span class="audit-action">${escHtml(auditActionLabels[item.action] || item.action)}</span></td>
    <td>${escHtml(item.entity_type)}${item.entity_id ? ` #${item.entity_id}` : ''}</td>
    <td>${item.kb_id ? `#${item.kb_id}` : ''}</td>
    <td class="audit-detail" title="${escHtml(detail)}">${escHtml(detail)}</td>
  `
  return tr
}

function formatAuditDetail(detail) {
  if (!detail) return ''
  try {
    const value = JSON.parse(detail)
    if (value && typeof value === 'object') {
      return Object.entries(value)
        .map(([key, val]) => `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`)
        .join(' · ')
        .slice(0, 240)
    }
  } catch { /* plain text */ }
  return String(detail).slice(0, 240)
}

/* ── 成员管理弹层 ──────────────────────────────────── */
let currentMembersKbId = null

function initMembersModal() {
  const modal  = document.getElementById('members-modal')
  const close  = () => modal.classList.add('hidden')

  document.getElementById('members-modal-close').addEventListener('click', close)
  document.getElementById('members-modal-close2').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('member-add-btn').addEventListener('click', async () => {
    const username = document.getElementById('member-username').value.trim()
    if (!username) return
    const res = await fetch(`/api/kbs/${currentMembersKbId}/members`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    })
    const data = await res.json()
    if (res.ok) {
      document.getElementById('member-username').value = ''
      showToast(`已添加 ${data.username}`, 'success')
      loadMembers(currentMembersKbId)
    } else {
      showToast(data.error ?? '添加失败', 'error')
    }
  })

  document.getElementById('member-username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('member-add-btn').click()
  })
}

async function openMembersModal(kb) {
  currentMembersKbId = kb.id
  document.getElementById('members-modal-title').textContent = `成员管理 — ${kb.name}`
  document.getElementById('member-username').value = ''
  document.getElementById('members-modal').classList.remove('hidden')
  await loadMembers(kb.id)
}

async function loadMembers(kbId) {
  const list = document.getElementById('member-list')
  list.innerHTML = '<div style="color:var(--muted);font-size:13px">加载中…</div>'
  const res     = await fetch(`/api/kbs/${kbId}/members`, { headers: auth() })
  const members = await res.json()

  list.innerHTML = ''
  if (!members.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px">暂无额外成员（仅限公开访问或创建者）</div>'
    return
  }
  for (const m of members) {
    const row = document.createElement('div')
    row.className = 'doc-item'
    row.innerHTML = `
      <span>👤</span>
      <span style="flex:1;font-size:13.5px">${escHtml(m.username)}</span>
      <span class="badge badge-${m.role}" style="margin-right:6px">${m.role === 'admin' ? '管理员' : '用户'}</span>
      <button class="btn btn-danger btn-sm" data-uid="${m.id}">移除</button>
    `
    row.querySelector('[data-uid]').addEventListener('click', async () => {
      if (!confirm(`确认移除 ${m.username} 的访问权限？`)) return
      await fetch(`/api/kbs/${kbId}/members/${m.id}`, { method: 'DELETE', headers: auth() })
      showToast(`已移除 ${m.username}`, 'success')
      loadMembers(kbId)
    })
    list.appendChild(row)
  }
}

/* ── 管理员重置用户密码 ────────────────────────────── */
function initResetPwdModal() {
  const modal = document.getElementById('reset-pwd-modal')
  const close = () => {
    ['reset-pwd-new','reset-pwd-confirm'].forEach(id => { document.getElementById(id).value = '' })
    modal.classList.add('hidden')
  }

  document.getElementById('reset-pwd-close').addEventListener('click', close)
  document.getElementById('reset-pwd-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('reset-pwd-confirm-btn').addEventListener('click', async () => {
    const uid     = document.getElementById('reset-pwd-uid').value
    const newPwd  = document.getElementById('reset-pwd-new').value
    const confirm = document.getElementById('reset-pwd-confirm').value

    if (!newPwd || !confirm) { alert('请填写新密码'); return }
    if (newPwd !== confirm)  { alert('两次输入不一致'); return }
    if (newPwd.length < 6)   { alert('密码至少 6 位'); return }

    const res = await fetch(`/api/admin/users/${uid}/reset-password`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: newPwd }),
    })
    const data = await res.json()
    if (res.ok) { showToast('密码已重置', 'success'); close() }
    else        { showToast(data.error ?? '重置失败', 'error') }
  })
}

function openResetPwdModal(uid, username) {
  document.getElementById('reset-pwd-uid').value = uid
  document.getElementById('reset-pwd-username').textContent = username
  document.getElementById('reset-pwd-new').value = ''
  document.getElementById('reset-pwd-confirm').value = ''
  document.getElementById('reset-pwd-modal').classList.remove('hidden')
  document.getElementById('reset-pwd-new').focus()
}

/* ── 修改密码弹层 ───────────────────────────────────── */
function initPwdModal() {
  const modal  = document.getElementById('pwd-modal')
  const close  = () => {
    ['pwd-current','pwd-new','pwd-confirm'].forEach(id => { document.getElementById(id).value = '' })
    modal.classList.add('hidden')
  }

  document.getElementById('change-pwd-btn').addEventListener('click', () => modal.classList.remove('hidden'))
  document.getElementById('pwd-modal-close').addEventListener('click', close)
  document.getElementById('pwd-modal-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('pwd-modal-confirm').addEventListener('click', async () => {
    const current = document.getElementById('pwd-current').value
    const next    = document.getElementById('pwd-new').value
    const confirm = document.getElementById('pwd-confirm').value

    if (!current || !next || !confirm) { alert('请填写全部字段'); return }
    if (next !== confirm) { alert('两次输入的新密码不一致'); return }
    if (next.length < 6)  { alert('新密码至少 6 位'); return }

    const res = await fetch('/api/me/password', {
      method: 'PATCH',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    })
    const data = await res.json()
    if (res.ok) {
      // 改密后旧 Token 失效，换用服务器签发的新 Token（其他设备需重新登录）
      if (data.token) { token = data.token; localStorage.setItem('kb_token', data.token) }
      showToast('密码修改成功，其他设备需重新登录', 'success'); close()
    }
    else        { showToast(data.error ?? '修改失败', 'error') }
  })
}

/* ── 系统设置（模型热切换） ──────────────────────────── */
async function initModelSettings() {
  const sel     = document.getElementById('model-select')
  const saveBtn = document.getElementById('model-save-btn')
  if (!sel || !saveBtn) return

  try {
    const res  = await fetch('/api/config/models', { headers: auth() })
    const data = await res.json()
    sel.innerHTML = data.models.map(m =>
      `<option value="${escHtml(m)}" ${m === data.current ? 'selected' : ''}>${escHtml(m)}</option>`
    ).join('')
  } catch {
    sel.innerHTML = '<option>加载失败</option>'
  }

  saveBtn.addEventListener('click', async () => {
    const model = sel.value
    if (!model) return
    const res = await fetch('/api/config/model', {
      method: 'PATCH',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    if (res.ok) showToast(`模型已切换为 ${model}`, 'success')
    else showToast('切换失败', 'error')
  })
}

/* ── 文本文档历史版本 ─────────────────────────────── */
const versionHistory = { kbId: null, docId: null, docName: '', items: [], selectedId: null, view: 'diff', cache: new Map() }

/** 逐行对比（最长公共子序列），先去掉相同的开头和结尾以减少计算量 */
function lineDiff(oldText, newText) {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const midA = a.slice(start, endA), midB = b.slice(start, endB)
  if (midA.length * midB.length > 4_000_000) return null

  const n = midA.length, m = midB.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out = a.slice(0, start).map(text => ({ type: 'same', text }))
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { out.push({ type: 'same', text: midA[i] }); i++; j++ }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { out.push({ type: 'add', text: midB[j] }); j++ }
    else { out.push({ type: 'del', text: midA[i] }); i++ }
  }
  return out.concat(a.slice(endA).map(text => ({ type: 'same', text })))
}

function renderDiff(lines) {
  const CONTEXT = 3
  const html = []
  let added = 0, removed = 0
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    if (line.type === 'add') added++
    if (line.type === 'del') removed++
    if (line.type === 'same') {
      // 折叠离改动较远的未变化行
      let end = k
      while (end < lines.length && lines[end].type === 'same') end++
      const runLength = end - k
      const head = k === 0 ? 0 : CONTEXT
      const tail = end === lines.length ? 0 : CONTEXT
      if (runLength > head + tail + 2) {
        for (let x = k; x < k + head; x++) html.push(diffLine(lines[x]))
        html.push(`<div class="diff-line diff-skip">… ${runLength - head - tail} 行未变化 …</div>`)
        for (let x = end - tail; x < end; x++) html.push(diffLine(lines[x]))
        k = end - 1
        continue
      }
    }
    html.push(diffLine(line))
  }
  return { html: html.join(''), added, removed }
}

function diffLine(line) {
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '
  return `<div class="diff-line diff-${line.type}"><span class="diff-sign">${sign}</span>${escHtml(line.text) || ' '}</div>`
}

function versionNumber(id) {
  const index = versionHistory.items.findIndex(v => v.id === id)
  return index < 0 ? null : versionHistory.items.length - index
}

function versionNoteLabel(version, index) {
  const badges = index === 0 ? ['<span class="history-badge current">当前</span>'] : []
  if (version.note === 'baseline') badges.push('<span class="history-badge">启用历史前的内容</span>')
  const restoredFrom = /^restore:(\d+)$/.exec(version.note || '')
  if (restoredFrom) {
    const n = versionNumber(Number(restoredFrom[1]))
    badges.push(`<span class="history-badge">恢复自${n ? `版本 ${n}` : '更早的版本'}</span>`)
  }
  return badges.join('')
}

async function fetchVersion(id) {
  if (versionHistory.cache.has(id)) return versionHistory.cache.get(id)
  const res = await fetch(`/api/kbs/${versionHistory.kbId}/docs/${versionHistory.docId}/versions/${id}`, { headers: auth() })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '加载失败')
  versionHistory.cache.set(id, data)
  return data
}

function renderVersionList() {
  const listEl = document.getElementById('history-list')
  listEl.innerHTML = versionHistory.items.map((v, index) => `
    <button class="history-item ${v.id === versionHistory.selectedId ? 'active' : ''}" data-version-id="${v.id}">
      <span class="history-item-title">版本 ${versionHistory.items.length - index} ${versionNoteLabel(v, index)}</span>
      <span class="history-item-meta">${escHtml(fmtDateTime(v.created_at))}${v.username ? ` · ${escHtml(v.username)}` : ''}</span>
    </button>`).join('')
  listEl.querySelectorAll('[data-version-id]').forEach(btn => {
    btn.addEventListener('click', () => selectVersion(Number(btn.dataset.versionId)))
  })
}

async function selectVersion(id) {
  versionHistory.selectedId = id
  renderVersionList()
  const index   = versionHistory.items.findIndex(v => v.id === id)
  const meta    = document.getElementById('history-meta')
  const content = document.getElementById('history-content')
  const restore = document.getElementById('history-restore-btn')
  restore.classList.toggle('hidden', index === 0 || !canWriteCurrentKb())
  content.innerHTML = '<div class="feedback-empty">加载中…</div>'

  try {
    const version  = await fetchVersion(id)
    const previous = versionHistory.items[index + 1]
    let body = `<pre class="history-full">${escHtml(version.content)}</pre>`
    let summary = `${escHtml(version.title)} · ${fmtSize(version.size)}`

    if (versionHistory.view === 'diff') {
      if (!previous) {
        body = `<div class="history-hint">这是最早保留的版本，没有可对比的上一版。</div>${body}`
      } else {
        const diff = lineDiff((await fetchVersion(previous.id)).content, version.content)
        if (!diff) {
          body = `<div class="history-hint">内容较长，无法逐行对比，下面显示完整内容。</div>${body}`
        } else {
          const rendered = renderDiff(diff)
          summary += ` · <span class="diff-stat-add">+${rendered.added}</span> <span class="diff-stat-del">−${rendered.removed}</span> 行`
          body = rendered.added || rendered.removed
            ? `<div class="history-diff">${rendered.html}</div>`
            : '<div class="history-hint">正文与上一版相同（可能只改了标题）。</div>'
        }
      }
    }
    if (versionHistory.selectedId !== id) return
    meta.innerHTML = summary
    content.innerHTML = body
  } catch (e) {
    content.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

async function openVersionHistory(docId, docName) {
  Object.assign(versionHistory, { kbId: currentDocKbId, docId, docName, items: [], selectedId: null, cache: new Map() })
  document.getElementById('history-modal-title').textContent = `历史版本 — ${docName}`
  document.getElementById('history-list').innerHTML = '<div class="feedback-empty">加载中…</div>'
  document.getElementById('history-meta').textContent = ''
  document.getElementById('history-content').innerHTML = ''
  document.getElementById('history-restore-btn').classList.add('hidden')
  document.getElementById('history-modal').classList.remove('hidden')

  try {
    const res  = await fetch(`/api/kbs/${versionHistory.kbId}/docs/${docId}/versions`, { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    versionHistory.items = data.items
    if (!data.items.length) {
      document.getElementById('history-list').innerHTML = ''
      document.getElementById('history-content').innerHTML = '<div class="feedback-empty">这篇文档还没有历史版本。下次保存后开始记录。</div>'
      return
    }
    await selectVersion(data.items[0].id)
  } catch (e) {
    document.getElementById('history-list').innerHTML = ''
    document.getElementById('history-content').innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

function initVersionHistory() {
  const modal = document.getElementById('history-modal')
  if (!modal) return
  document.getElementById('history-modal-close').addEventListener('click', () => modal.classList.add('hidden'))
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden') })
  modal.querySelectorAll('[data-history-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      versionHistory.view = btn.dataset.historyView
      modal.querySelectorAll('[data-history-view]').forEach(b => b.classList.toggle('active', b === btn))
      if (versionHistory.selectedId) selectVersion(versionHistory.selectedId)
    })
  })
  document.getElementById('history-restore-btn').addEventListener('click', async () => {
    const id = versionHistory.selectedId
    const n  = versionNumber(id)
    if (!confirm(`用版本 ${n} 的内容替换当前文档？\n当前内容会保留在历史版本中，随时可以再恢复。`)) return
    const res  = await fetch(`/api/kbs/${versionHistory.kbId}/docs/${versionHistory.docId}/versions/${id}/restore`, { method: 'POST', headers: auth() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(data.error ?? '恢复失败', 'error'); return }
    showToast(data.changed ? `已恢复到版本 ${n}` : '内容与当前版本相同，无需恢复', 'success')
    await openVersionHistory(versionHistory.docId, versionHistory.docName)
    loadDocs(false)
  })
}

/* ── 数据备份 ─────────────────────────────────────── */
let backupPollTimer = null

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtIsoTime(iso) {
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function renderBackupStatus(status) {
  const scheduleEl = document.getElementById('backup-schedule')
  const lastEl     = document.getElementById('backup-last')
  const listEl     = document.getElementById('backup-list')
  const btn        = document.getElementById('backup-now-btn')

  scheduleEl.innerHTML = status.enabled
    ? `自动备份：每 ${status.intervalHours} 小时一次，保留最近 ${status.keep} 份${status.nextAt && !status.running ? ` · 下次约 ${escHtml(fmtIsoTime(status.nextAt))}` : ''}`
    : `自动备份未开启。在服务器的 <code>.env</code> 中设置 <code>BACKUP_INTERVAL_HOURS=24</code> 即可每天自动备份。`

  btn.disabled = status.running
  btn.textContent = status.running ? '备份中…' : '立即备份'

  const last = status.last
  lastEl.classList.toggle('hidden', !last)
  if (last) {
    const how = last.trigger === 'manual' ? '手动' : '自动'
    lastEl.className = `backup-last ${last.ok ? 'ok' : 'failed'}`
    lastEl.textContent = last.ok
      ? `✓ 上次${how}备份成功 · ${fmtIsoTime(last.at)}`
      : `✗ 上次${how}备份失败 · ${fmtIsoTime(last.at)} · ${last.error}`
  }

  listEl.innerHTML = status.backups.length
    ? status.backups.map(b => `
        <div class="gap-row backup-row">
          <div class="gap-main">
            <div class="gap-question">${escHtml(fmtIsoTime(b.createdAt))}</div>
            <div class="gap-meta">
              <span>${escHtml(b.name)}</span>
              <span>v${escHtml(b.appVersion)}</span>
              <span>${b.counts.knowledgeBases} 个知识库 · ${b.counts.documents} 份文档 · ${b.counts.users} 个用户</span>
              <span>${fmtBytes(b.storageBytes)}</span>
            </div>
          </div>
        </div>`).join('')
    : '<div class="feedback-empty">还没有备份。</div>'

  clearTimeout(backupPollTimer)
  if (status.running) backupPollTimer = setTimeout(loadBackups, 3000)
}

async function loadBackups() {
  const listEl = document.getElementById('backup-list')
  if (!listEl) return
  try {
    const res  = await fetch('/api/admin/backups', { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    renderBackupStatus(data)
  } catch (e) {
    document.getElementById('backup-schedule').textContent = ''
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

function initBackupSettings() {
  const btn = document.getElementById('backup-now-btn')
  if (!btn) return
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = '备份中…'
    try {
      const res  = await fetch('/api/admin/backups', { method: 'POST', headers: auth() })
      const data = await res.json()
      if (res.ok) {
        showToast(`备份完成：${data.name}`, 'success')
        renderBackupStatus(data.status)
      } else {
        showToast(data.error ?? '备份失败', 'error')
        loadBackups()
      }
    } catch {
      showToast('备份请求失败，请检查网络', 'error')
      loadBackups()
    }
  })
}

/* ── API 接入 ─────────────────────────────────────── */
const apiAccess = { newKey: null, snippet: 'claude-code' }
const API_KEY_PLACEHOLDER = '<你的 API 密钥>'

function mcpUrl() { return `${location.origin}/mcp` }

const MCP_SNIPPETS = {
  'claude-code': {
    hint: '在终端运行这条命令，之后在 Claude Code 里直接提问即可。',
    render: key => `claude mcp add --transport http enterprise-kb ${mcpUrl()} \\\n  --header "Authorization: Bearer ${key}"`,
  },
  json: {
    hint: 'Cursor 写入 ~/.cursor/mcp.json；其他客户端按各自的说明填写服务地址和请求头。',
    render: key => JSON.stringify({
      mcpServers: { 'enterprise-kb': { type: 'http', url: mcpUrl(), headers: { Authorization: `Bearer ${key}` } } },
    }, null, 2),
  },
  curl: {
    hint: '返回知识库列表就说明接入成功。',
    render: key => [
      `curl -s ${mcpUrl()} \\`,
      `  -H "Authorization: Bearer ${key}" \\`,
      '  -H "Content-Type: application/json" \\',
      '  -H "Accept: application/json, text/event-stream" \\',
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_knowledge_bases","arguments":{}}}'`,
    ].join('\n'),
  },
}

function renderMcpSnippet() {
  const snippet = MCP_SNIPPETS[apiAccess.snippet]
  document.getElementById('mcp-snippet').textContent = snippet.render(apiAccess.newKey ?? API_KEY_PLACEHOLDER)
  document.getElementById('mcp-snippet-hint').textContent = apiAccess.newKey
    ? `${snippet.hint}（已填入刚创建的密钥）`
    : `${snippet.hint}把 ${API_KEY_PLACEHOLDER} 换成你的密钥。`
  document.querySelectorAll('.api-snippet-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.snippet === apiAccess.snippet)
  })
}

function apiKeyRow(k, scope) {
  const expired = k.expires_at != null && k.expires_at * 1000 <= Date.now()
  return `
    <div class="gap-row api-key-row">
      <div class="gap-main">
        <div class="gap-question">${escHtml(k.name)} <span class="gap-tag">${escHtml(k.prefix)}…</span>${expired ? ' <span class="gap-tag gap-tag-user">已过期</span>' : ''}</div>
        <div class="gap-meta">
          ${scope === 'admin' ? `<span>${escHtml(k.username)}</span>` : ''}
          <span>创建于 ${fmtTime(k.created_at)}</span>
          <span>${k.last_used_at ? `最近使用 ${fmtDateTime(k.last_used_at)}` : '从未使用'}</span>
          <span>${k.expires_at ? `${expired ? '已于' : '有效期至'} ${fmtTime(k.expires_at)}${expired ? ' 过期' : ''}` : '永久有效'}</span>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" type="button" data-revoke-key="${k.id}" data-scope="${scope}" data-name="${escHtml(k.name)}">撤销</button>
    </div>`
}

async function loadApiKeys() {
  const listEl = document.getElementById('api-key-list')
  renderMcpSnippet()
  try {
    const res  = await fetch('/api/me/api-keys', { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    listEl.innerHTML = data.items.length
      ? data.items.map(k => apiKeyRow(k, 'me')).join('')
      : '<div class="feedback-empty">还没有密钥。创建一个，就能把知识库接入 AI 助手。</div>'
  } catch (e) {
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
  if (isAdmin) loadAdminApiKeys()
}

async function loadAdminApiKeys() {
  const card   = document.getElementById('admin-api-key-card')
  const listEl = document.getElementById('admin-api-key-list')
  card.classList.remove('hidden')
  try {
    const res  = await fetch('/api/admin/api-keys', { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    listEl.innerHTML = data.items.length
      ? data.items.map(k => apiKeyRow(k, 'admin')).join('')
      : '<div class="feedback-empty">还没有人创建密钥。</div>'
  } catch (e) {
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 非 HTTPS 页面没有剪贴板接口，退回到选中文本复制
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (!ok) throw new Error('copy failed')
  }
}

function initApiAccess() {
  const panel = document.getElementById('tab-api')
  const form  = document.getElementById('api-key-form')
  document.getElementById('mcp-url').textContent = mcpUrl()

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const nameInput = document.getElementById('api-key-name')
    const name = nameInput.value.trim()
    if (!name) { showToast('请填写密钥用途，方便以后辨认', 'error'); nameInput.focus(); return }
    const expiry = document.getElementById('api-key-expiry').value
    const btn = document.getElementById('api-key-create-btn')
    btn.disabled = true
    try {
      const res  = await fetch('/api/me/api-keys', {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, expiresInDays: expiry ? Number(expiry) : null }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error ?? '创建失败', 'error'); return }
      apiAccess.newKey = data.key
      document.getElementById('api-key-new-value').textContent = data.key
      document.getElementById('api-key-new').classList.remove('hidden')
      nameInput.value = ''
      renderMcpSnippet()
      loadApiKeys()
    } catch {
      showToast('创建失败，请检查网络', 'error')
    } finally {
      btn.disabled = false
    }
  })

  panel.addEventListener('click', async e => {
    const copyBtn = e.target.closest('[data-copy-target]')
    if (copyBtn) {
      try {
        await copyText(document.getElementById(copyBtn.dataset.copyTarget).textContent)
        showToast('已复制', 'success')
      } catch {
        showToast('复制失败，请手动选择文字复制', 'error')
      }
      return
    }

    const tab = e.target.closest('[data-snippet]')
    if (tab) { apiAccess.snippet = tab.dataset.snippet; renderMcpSnippet(); return }

    const revokeBtn = e.target.closest('[data-revoke-key]')
    if (revokeBtn) {
      if (!confirm(`撤销密钥「${revokeBtn.dataset.name}」？使用它的工具会立即失去访问权限。`)) return
      const url = revokeBtn.dataset.scope === 'admin'
        ? `/api/admin/api-keys/${revokeBtn.dataset.revokeKey}`
        : `/api/me/api-keys/${revokeBtn.dataset.revokeKey}`
      revokeBtn.disabled = true
      try {
        const res = await fetch(url, { method: 'DELETE', headers: auth() })
        const data = await res.json()
        if (!res.ok) { showToast(data.error ?? '撤销失败', 'error'); revokeBtn.disabled = false; return }
        showToast('密钥已撤销', 'success')
        loadApiKeys()
      } catch {
        showToast('撤销失败，请检查网络', 'error')
        revokeBtn.disabled = false
      }
    }
  })
}

/* ── 退出 ─────────────────────────────────────────── */
function initLogout() {
  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('kb_token')
    localStorage.removeItem('kb_user')
    location.href = '/login.html'
  })
}

/* ── 工具函数 ──────────────────────────────────────── */
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' })
}

function fmtDateTime(ts) {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/* ── 新建/编辑文本文档 ────────────────────────────────── */
function initTextDocModal() {
  const modal      = document.getElementById('text-doc-modal')
  const modalTitle = document.getElementById('text-doc-modal-title')
  const titleInput = document.getElementById('text-doc-title')
  const editor     = document.getElementById('text-doc-content')
  const previewPane = document.getElementById('text-doc-preview')
  const charCount  = document.getElementById('text-doc-char-count')
  const saveBtn    = document.getElementById('text-doc-save')
  const cancelBtn  = document.getElementById('text-doc-cancel')
  const closeBtn   = document.getElementById('text-doc-modal-close')
  const openBtn    = document.getElementById('new-text-doc-btn')

  let editingDocId = null  // null = create mode, number = edit mode

  function renderPreview(md) {
    if (!md.trim()) {
      previewPane.innerHTML = '<div class="text-doc-preview-empty">预览将在右侧实时显示…</div>'
      return
    }
    try {
      // 未加载到 marked / DOMPurify 时退回纯文本，绝不插入未净化的 HTML
      const html = typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(marked.parse(md))
        : `<pre>${escHtml(md)}</pre>`
      previewPane.innerHTML = `<div class="md-preview">${html}</div>`
    } catch { previewPane.innerHTML = '<div class="text-doc-preview-empty">预览渲染失败</div>' }
  }

  function open(opts = {}) {
    if (!currentDocKbId) { showToast('请先选择知识库', 'error'); return }
    editingDocId = opts.docId ?? null
    modalTitle.textContent = editingDocId ? '编辑文档' : '新建文档'
    titleInput.value = opts.title ?? ''
    editor.value = opts.content ?? ''
    updateCount()
    renderPreview(editor.value)
    modal.classList.remove('hidden')
    setTimeout(() => (editingDocId ? editor.focus() : titleInput.focus()), 60)
  }

  function close() {
    modal.classList.add('hidden')
    editingDocId = null
  }

  function updateCount() {
    const len = editor.value.length
    charCount.textContent = len.toLocaleString() + ' 字'
    charCount.style.color = len > 100000 ? 'var(--red)' : 'var(--light)'
    renderPreview(editor.value)
  }

  async function save() {
    const title   = titleInput.value.trim() || '未命名笔记'
    const content = editor.value.trim()
    if (!content) { showToast('内容不能为空', 'error'); return }

    saveBtn.disabled = true
    saveBtn.textContent = '保存中…'

    try {
      const url    = editingDocId
        ? `/api/kbs/${currentDocKbId}/docs/${editingDocId}/text`
        : `/api/kbs/${currentDocKbId}/docs/text`
      const method = editingDocId ? 'PATCH' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title, content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '保存失败')
      }
      showToast(`「${title}」已保存并建立索引`, 'success')
      close()
      loadDocs()
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      saveBtn.disabled = false
      saveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> 保存到知识库`
    }
  }

  // 全局入口：新建
  openBtn.addEventListener('click', () => open())
  closeBtn.addEventListener('click', close)
  cancelBtn.addEventListener('click', close)
  saveBtn.addEventListener('click', save)
  editor.addEventListener('input', updateCount)

  // Tab 键插入两个空格而不是跳走
  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const s = editor.selectionStart
      const v = editor.value
      editor.value = v.slice(0, s) + '  ' + v.slice(editor.selectionEnd)
      editor.selectionStart = editor.selectionEnd = s + 2
      updateCount()
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
  })

  modal.addEventListener('click', e => { if (e.target === modal) close() })

  // 对外暴露 open，供编辑按钮调用
  window._openTextDocModal = open
}
