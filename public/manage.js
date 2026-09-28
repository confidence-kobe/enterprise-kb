/**
 * ============================================================================
 * 企业级知识库管理控制台前端交互主脚本 (manage.js)
 *
 * 核心功能模块：
 * 1. 身份认证与权限控制：检查 JWT Token，根据 admin / user 角色动态控制管理功能面板
 * 2. 界面主题管理：深色模式 (Dark Mode) 与浅色模式持久化无缝切换
 * 3. 知识库 (KB) 资产管理：概览数据卡片、增删改查、公开/私有切换、自定义系统提示词
 * 4. 文档管理与知识索引：文档多条件分页列表、FTS 检索高亮、解析与向量化状态流转、大文件拖拽上传
 * 5. 同步数据源目录：配置本地文件夹路径、差量扫描与定时比对执行
 * 6. 原文在线预览与智能推荐：基于向量相似度自动推荐关联文档
 * 7. 多租户成员协作权限：基于 RBAC 的知识库协作者添加与移除
 * 8. 平台安全审计与用户中心：操作日志检索审计、用户增删改查、密码重置与模型热切换
 * 9. MCP 协议接入管理：API Key 分发、知识库访问范围隔离与客户端配置生成
 * ============================================================================
 */

/* ── 客户端身份认证与管理员权限判定 ─────────────────── */
const token = localStorage.getItem('kb_token')
let user = null
try { user = JSON.parse(localStorage.getItem('kb_user') || 'null') } catch { user = null }

// 未登录或令牌缺失，强制重定向至登录入口
if (!token || !user) { localStorage.removeItem('kb_user'); location.href = '/login.html' }

/** 当前登录用户是否拥有超级管理员权限 */
const isAdmin = user?.role === 'admin'

/* ── 界面色彩主题初始化（明暗切换） ─────────────────── */
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

/* ── DOM 核心容器与操作控件引用 ─────────────────────── */
const toast           = document.getElementById('toast')
const kbList          = document.getElementById('kb-list')
const docKbSelect     = document.getElementById('doc-kb-select')
const docList         = document.getElementById('doc-list')
const uploadArea      = document.getElementById('upload-area')
const uploadZone      = document.getElementById('upload-zone')
const fileInput       = document.getElementById('file-input')
const userList        = document.getElementById('user-list')
const auditList       = document.getElementById('audit-list')
const syncSourcePanel = document.getElementById('sync-source-panel')
const syncPathInput   = document.getElementById('sync-path-input')
const syncStatusEl    = document.getElementById('sync-status')

/* ── 页面生命周期初始化入口 ─────────────────────────── */

// 渲染右上角当前登录角色徽章
document.getElementById('user-badge').textContent = isAdmin ? '管理员' : '用户'
document.getElementById('user-badge').className   = `badge badge-${user.role}`

// 管理员专享 Tab 面板展示与数据初始化
if (isAdmin) {
  document.getElementById('users-tab').style.display = ''
  document.getElementById('audit-tab').style.display = ''
  document.getElementById('settings-tab').style.display = ''
  document.getElementById('feedback-tab').style.display = ''
  document.getElementById('mcp-tab').style.display = ''
  loadUsers()
  initModelSettings()
  initAuditLog()
  initFeedbackPanel()
  initMcpPanel()
}

// 通用模块初始化
loadKbs()
initTabs()
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

// 事件委托：知识库卡片核心操作按钮（一次性委托绑定，避免重复渲染时产生内存泄露）
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

/**
 * 组装标准 HTTP 认证请求头
 * @returns {{ Authorization: string }} 包含 Bearer Token 的请求头对象
 */
function auth() { return { Authorization: `Bearer ${token}` } }

/**
 * 弹出全屏浮层提示信息 (Toast)，并在 3 秒后自动消失
 * @param {string} msg - 提示文本
 * @param {'success'|'error'|''} [type=''] - 提示样式类型
 */
function showToast(msg, type = '') {
  toast.textContent = msg
  toast.className = type
  toast.classList.remove('hidden')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3000)
}

/* ── 全局键盘事件：按 Escape 键关闭当前激活的模态弹窗 ── */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'))
})

/* ── Tab 导航标签栏切换 ──────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
      if (btn.dataset.tab === 'audit' && isAdmin) loadAuditLog(false)
    })
  })
}

/* ── 知识库 (Knowledge Base) 数据管理与列表渲染 ───────── */
let allKbs = []
let initialRouteApplied = false

/**
 * 从后端加载当前用户可见的所有知识库列表
 */
async function loadKbs() {
  try {
    const res = await fetch('/api/kbs', {
      headers: auth(),
      signal: AbortSignal.timeout(10000),
    })
    if (res.status === 401) { localStorage.removeItem('kb_token'); localStorage.removeItem('kb_user'); location.href = '/login.html'; return }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    allKbs = await res.json()
    if (!Array.isArray(allKbs)) throw new Error('unexpected response')
    renderKbList()
    renderDocKbSelect()
    applyInitialManageRoute()
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? '请求超时，请刷新重试' : (err?.message || '加载失败，请刷新重试')
    if (kbList) kbList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-text">${msg}</div></div>`
  }
}

/**
 * 读取 URL 查询参数，实现从对话页或外部链接直达指定知识库与标签页
 * 例如：manage.html?tab=docs&kb=12
 */
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

/**
 * 渲染知识库概览看板与卡片网格
 * 顶部展示全平台知识库数、文档总数、对话总数等汇总指标
 */
function renderKbList() {
  kbList.innerHTML = ''

  // 顶部汇总统计指标卡片
  const totalDocs  = allKbs.reduce((s, k) => s + (k.doc_count  ?? 0), 0)
  const totalConvs = allKbs.reduce((s, k) => s + (k.conv_count ?? 0), 0)
  const statsRow = document.createElement('div')
  statsRow.className = 'manage-stats-row'
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

  // 依据知识库 ID 循环分配的主题色彩调色板
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

/**
 * 记录选中的知识库 ID 并跳转至主聊天交互页
 * @param {number} id - 知识库 ID
 */
function openKbChat(id) {
  localStorage.setItem('kb_last_selected_id', String(id))
  location.href = '/index.html'
}

/**
 * 填充文档管理 Tab 顶部的知识库切换下拉选择列表
 */
function renderDocKbSelect() {
  docKbSelect.innerHTML = '<option value="">— 选择知识库 —</option>'
  for (const kb of allKbs) {
    const opt = document.createElement('option')
    opt.value = kb.id
    opt.textContent = kb.name
    docKbSelect.appendChild(opt)
  }
}

/**
 * 切换知识库的公开 / 私有访问属性
 * @param {number} id - 知识库 ID
 * @param {boolean} isPublic - 是否公开
 */
async function togglePublic(id, isPublic) {
  await fetch(`/api/kbs/${id}/public`, {
    method: 'PATCH',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_public: isPublic }),
  })
  showToast(isPublic ? '已设为公开' : '已设为私有', 'success')
  loadKbs()
}

/**
 * 删除指定知识库及其全部关联文档与向量索引
 * @param {number} id - 知识库 ID
 * @param {string} name - 知识库名称
 */
async function deleteKb(id, name) {
  if (!confirm(`确认删除知识库「${name}」？\n此操作将同时删除所有文档，不可恢复！`)) return
  const res = await fetch(`/api/kbs/${id}`, { method: 'DELETE', headers: auth() })
  if (res.ok) { showToast('知识库已删除', 'success'); loadKbs() }
  else { showToast('删除失败', 'error') }
}

/* ── 新建 / 编辑知识库模态弹窗 ───────────────────────── */
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
      // 编辑已有知识库（支持修改描述与专有 System Prompt）
      res = await fetch(`/api/kbs/${editId}`, {
        method: 'PATCH',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc, system_prompt: systemPrompt || null }),
      })
    } else {
      // 创建新知识库
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

/**
 * 唤起知识库编辑弹窗并回填现有配置数据
 * @param {object} kb - 知识库对象
 */
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

/* ── 文档资产管理与检索模块 ──────────────────────────── */
let currentDocKbId = null
const selectedDocIds = new Set()

// 切换文档所选知识库
docKbSelect.addEventListener('change', () => {
  currentDocKbId = docKbSelect.value ? Number(docKbSelect.value) : null
  const docSearch = document.getElementById('doc-search')
  if (docSearch) docSearch.value = ''
  document.getElementById('doc-search-count').textContent = ''
  renderSyncSourcePanel()
  if (currentDocKbId) { uploadArea.classList.remove('hidden'); loadDocs() }
  else { uploadArea.classList.add('hidden') }
})

// 文档内容全文检索（防抖 300ms）
let docSearchTimer = null
document.addEventListener('input', e => {
  if (e.target.id !== 'doc-search') return
  clearTimeout(docSearchTimer)
  const q = e.target.value.trim()
  if (!q) { loadDocs(); document.getElementById('doc-search-count').textContent = ''; return }
  docSearchTimer = setTimeout(() => searchDocContent(q), 300)
})

/**
 * 执行文档内容全文检索并高亮展示匹配的分块片段
 * @param {string} q - 搜索关键词
 */
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

/**
 * 生成文档处理状态徽章 HTML（待解析 / 解析中 / 已索引 / 未索引 / 失败）
 * @param {object} doc - 文档记录
 * @returns {string} 状态徽章 HTML
 */
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

/**
 * 生成同步数据源标记徽章 HTML
 * @param {object} doc - 文档记录
 * @returns {string} 同步徽章 HTML
 */
function docSourceBadge(doc) {
  if (doc.source_type !== 'sync') return ''
  const title = doc.source_path ? ` title="${escHtml(doc.source_path)}"` : ''
  return `<span class="doc-source doc-source-sync"${title}>同步</span>`
}

/**
 * 计算并生成文档向量覆盖率徽章 HTML
 * @param {object} doc - 文档记录
 * @returns {string} 向量覆盖率徽章 HTML
 */
function vectorBadge(doc) {
  const chunks = doc.chunk_count ?? doc.chunks ?? 0
  const vecs   = doc.vec_count  ?? doc.vecs   ?? 0
  if (!chunks) return ''
  const pct = Math.round((vecs / chunks) * 100)
  const cls  = pct >= 90 ? 'vec-badge-full' : pct >= 40 ? 'vec-badge-partial' : 'vec-badge-low'
  return `<span class="doc-vec-badge ${cls}" title="向量覆盖率 ${pct}%（${vecs}/${chunks} 块）">⚡ ${pct}%</span>`
}

/**
 * 分页加载当前所选知识库的文档列表
 * 若存在处于 pending 或 processing 状态的任务，自动开启 3 秒轮询刷新
 * @param {boolean} [append=false] - 是否以追加模式加载更多
 */
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
  const docs = data.items ?? data   // 兼容无分页老接口格式

  if (!append) {
    docList.innerHTML = ''
    docTotal = data.total ?? docs.length
  }

  // 控制表头显隐
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
      <span class="doc-name" title="${escHtml(doc.original_name)}">${escHtml(doc.original_name)}${doc.source_type === 'sync' ? ' <span class="doc-source" title="本地同步">同步</span>' : ''}</span>
      ${docStatusBadge(doc)}
      <span class="doc-size">${fmtSize(doc.size)}</span>
      <span>${vecBadge}</span>
      <div class="doc-row-actions">
        ${doc.source_type === 'text' ? `<button class="btn btn-secondary btn-sm" data-edit-id="${doc.id}" data-edit-name="${escHtml(doc.original_name)}" title="编辑文档">编辑</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-preview-id="${doc.id}" title="预览文档内容">预览</button>
        <button class="btn btn-danger btn-sm" data-doc-id="${doc.id}" title="删除文档">删除</button>
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
    item.querySelector('[data-doc-id]').addEventListener('click', () => deleteDoc(doc.id, doc.original_name))
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

  // "加载更多" 翻页按钮处理
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

  document.getElementById('doc-bulk-bar').classList.remove('hidden')
  if (tableHeader) tableHeader.style.display = ''
  if (!append) { selectedDocIds.clear(); updateBulkBar(); syncSelectAllCheckbox() }
  updateBulkBar()

  // 若存在异步解析任务，定时轮询刷新列表状态
  const hasActiveIndexJobs = docs.some(doc => ['pending', 'processing'].includes(doc.index_status))
  if (!append && hasActiveIndexJobs) {
    docRefreshTimer = setTimeout(() => loadDocs(false), 3000)
  }
}

/**
 * 更新批量操作控制条已选条数文本与删除按钮状态
 */
function updateBulkBar() {
  const count = selectedDocIds.size
  document.getElementById('doc-selected-count').textContent = `已选 ${count} 项`
  document.getElementById('doc-bulk-delete-btn').disabled = count === 0
}

/**
 * 同步表头“全选”复选框的勾选与半选（indeterminate）状态
 */
function syncSelectAllCheckbox() {
  const allCbs   = [...document.querySelectorAll('.doc-cb')]
  const selectAll = document.getElementById('doc-select-all')
  if (!allCbs.length) { selectAll.checked = false; selectAll.indeterminate = false; return }
  const checked = allCbs.filter(c => c.checked).length
  selectAll.checked = checked === allCbs.length
  selectAll.indeterminate = checked > 0 && checked < allCbs.length
}

/* ── 文档批量操作模块 ────────────────────────────────── */

/**
 * 初始化文档全选与批量删除功能
 */
function initDocBulk() {
  // 全选/全不选复选框
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

  // 批量删除执行按钮
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

/* ── 文档全量重建索引模块 ────────────────────────────── */

/**
 * 初始化重建索引按钮，用于重新切分并生成该知识库全部文档的向量与全文索引
 */
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

/**
 * 获取当前选中的知识库元数据对象
 * @returns {object|null} 知识库对象或 null
 */
function selectedDocKb() {
  return allKbs.find(kb => kb.id === currentDocKbId) ?? null
}

/**
 * 判断当前登录用户是否有权限管理当前知识库（系统管理员或知识库 Owner）
 * @returns {boolean} 是否具备管理权限
 */
function canManageCurrentKb() {
  const kb = selectedDocKb()
  return Boolean(kb && (isAdmin || kb.owner_id === user.id))
}

/* ── 本地目录同步源数据管理模块 ──────────────────────── */

/**
 * 根据知识库状态渲染本地同步源配置面板
 */
function renderSyncSourcePanel() {
  if (!syncSourcePanel) return
  const kb = selectedDocKb()
  if (!kb || !canManageCurrentKb()) {
    syncSourcePanel.classList.add('hidden')
    if (syncPathInput) syncPathInput.value = ''
    if (syncStatusEl) syncStatusEl.textContent = ''
    return
  }
  syncSourcePanel.classList.remove('hidden')
  syncPathInput.value = kb.sync_source_path || ''
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

/**
 * 格式化同步任务执行结果汇总文本
 * @param {object} summary - 同步统计对象
 * @returns {string} 汇总描述字符串
 */
function syncSummaryText(summary) {
  const skipped = summary.skipped
    ? Object.values(summary.skipped).reduce((sum, value) => sum + Number(value || 0), 0)
    : 0
  return `新增 ${summary.added || 0} / 更新 ${summary.updated || 0} / 删除 ${summary.removed || 0} / 跳过 ${skipped}`
}

/**
 * 局部更新本地内存中的知识库属性缓存
 * @param {number} id - 知识库 ID
 * @param {object} patch - 增量属性补丁
 */
function updateKbLocal(id, patch) {
  const idx = allKbs.findIndex(kb => kb.id === id)
  if (idx >= 0) allKbs[idx] = { ...allKbs[idx], ...patch }
}

/**
 * 初始化本地同步源路径保存与即时同步执行逻辑
 */
function initSyncSource() {
  const saveBtn = document.getElementById('sync-save-btn')
  const runBtn  = document.getElementById('sync-run-btn')
  if (!saveBtn || !runBtn) return

  /**
   * 保存本地文件夹同步绝对路径
   */
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

  // 立即触发全量扫描同步
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

/**
 * 删除单个文档
 * @param {number} id - 文档 ID
 * @param {string} name - 文档原名
 */
async function deleteDoc(id, name) {
  if (!confirm(`确认删除文档「${name}」？`)) return
  const res = await fetch(`/api/kbs/${currentDocKbId}/docs/${id}`, { method: 'DELETE', headers: auth() })
  if (res.ok) { showToast('文档已删除', 'success'); loadDocs() }
  else { showToast('删除失败', 'error') }
}

/* ── 文档在线预览与关联推荐模态框 ───────────────────── */

/**
 * 初始化文档预览弹窗事件
 */
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

/**
 * 打开文档预览弹层，并发请求正文内容与语义相似的关联文档列表
 * @param {number} docId - 文档 ID
 * @param {string} originalName - 文档原始文件名
 * @param {string} [summary] - 可选的 AI 提炼摘要
 */
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

  // 主内容与关联推荐并行发起加载，缩短等待时间
  const [previewRes, relatedRes] = await Promise.allSettled([
    fetch(`/api/kbs/${currentDocKbId}/docs/${docId}/preview`, { headers: auth() }),
    fetch(`/api/kbs/${currentDocKbId}/docs/${docId}/related`, { headers: auth() }),
  ])

  // 渲染正文文本内容
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

  // 渲染语义相似度关联推荐列表
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

/* ── 文件上传拖拽交互与 XHR 进度条 ───────────────────── */

/**
 * 初始化文件拖拽区域与选择输入框事件
 */
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

/**
 * 封装原生 XMLHttpRequest 批量上传选中的本地文件，实时更新进度条与百分比
 * @param {File[]} files - 文件对象数组
 */
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

  // 监听上传进度
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100)
      progressBar.style.width = pct + '%'
      progressPct.textContent = pct + '%'
    }
  }

  // 上传完成或返回响应
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

/* ── 用户管理模块 (仅管理员权限) ─────────────────────── */

/**
 * 加载全平台注册用户列表，渲染角色修改下拉框与操作按钮
 */
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

/**
 * 删除指定用户账号
 * @param {number} id - 用户 ID
 * @param {string} name - 用户名
 */
async function deleteUser(id, name) {
  if (!confirm(`确认删除用户「${name}」？该用户的数据将保留但无法登录。`)) return
  const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: auth() })
  if (res.ok) { showToast('用户已删除', 'success'); loadUsers() }
  else { showToast('删除失败', 'error') }
}

/**
 * 初始化新建用户弹窗
 */
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

/* ── 安全审计日志模块 ────────────────────────────────── */
const AUDIT_PAGE_SIZE = 40
let auditOffset = 0
let auditTotal = 0
let auditLoading = false

/** 审计事件中文映射表 */
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
}

/**
 * 初始化审计日志检索过滤与分页按钮事件
 */
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

/**
 * 加载并分页渲染系统安全审计日志
 * @param {boolean} [append=false] - 是否为追加加载更多
 */
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

/**
 * 构建审计日志单行表格 DOM 节点
 * @param {object} item - 审计日志项
 * @returns {HTMLTableRowElement} 行元素
 */
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

/**
 * 解析审计明细字段为可读格式（键值对或纯文本）
 * @param {string} detail - 原始 detail 文本或 JSON 字符串
 * @returns {string} 格式化后的简短明细
 */
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

/* ── 知识库协作者成员权限管理模态框 ─────────────────── */
let currentMembersKbId = null

/**
 * 初始化成员管理弹窗
 */
function initMembersModal() {
  const modal  = document.getElementById('members-modal')
  const close  = () => modal.classList.add('hidden')

  document.getElementById('members-modal-close').addEventListener('click', close)
  document.getElementById('members-modal-close2').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  // 添加成员
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

/**
 * 唤起指定知识库的成员管理弹窗
 * @param {object} kb - 知识库对象
 */
async function openMembersModal(kb) {
  currentMembersKbId = kb.id
  document.getElementById('members-modal-title').textContent = `成员管理 — ${kb.name}`
  document.getElementById('member-username').value = ''
  document.getElementById('members-modal').classList.remove('hidden')
  await loadMembers(kb.id)
}

/**
 * 拉取指定知识库已授权的协作者列表
 * @param {number} kbId - 知识库 ID
 */
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

/* ── 管理员重置用户密码模态框 ───────────────────────── */

/**
 * 初始化管理员重置指定用户密码的模态弹窗与提交校验
 */
function initResetPwdModal() {
  const modal = document.getElementById('reset-pwd-modal')
  const close = () => {
    ['reset-pwd-new','reset-pwd-confirm'].forEach(id => { document.getElementById(id).value = '' })
    modal.classList.add('hidden')
  }

  document.getElementById('reset-pwd-close').addEventListener('click', close)
  document.getElementById('reset-pwd-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  // 提交重置密码
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

/**
 * 唤起重置指定用户密码模态框并回填目标用户信息
 * @param {number} uid - 用户 ID
 * @param {string} username - 用户名
 */
function openResetPwdModal(uid, username) {
  document.getElementById('reset-pwd-uid').value = uid
  document.getElementById('reset-pwd-username').textContent = username
  document.getElementById('reset-pwd-new').value = ''
  document.getElementById('reset-pwd-confirm').value = ''
  document.getElementById('reset-pwd-modal').classList.remove('hidden')
  document.getElementById('reset-pwd-new').focus()
}

/* ── 个人修改密码模态框 ─────────────────────────────── */

/**
 * 初始化当前登录用户修改个人密码的弹窗事件与逻辑
 */
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

  // 提交修改密码
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
    if (res.ok) { showToast('密码修改成功', 'success'); close() }
    else        { showToast(data.error ?? '修改失败', 'error') }
  })
}

/* ── 系统底层配置与大模型热切换 ─────────────────────── */

/**
 * 初始化系统设置面板中的 LLM 大模型动态切换下拉框
 * 支持免重启服务器即时更新后端推理模型
 */
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

/* ── 退出登录 ───────────────────────────────────────── */

/**
 * 初始化用户退出登录按钮，清除本地认证缓存并跳回登录页
 */
function initLogout() {
  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('kb_token')
    localStorage.removeItem('kb_user')
    location.href = '/login.html'
  })
}

/* ── 文本与数据格式化通用工具函数 ───────────────────── */

/**
 * 对 HTML 特殊敏感字符进行转义，抵御 XSS 注入攻击
 * @param {string} s - 输入文本
 * @returns {string} 转义后的安全文本
 */
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

/**
 * 将秒级时间戳格式化为本地短日期 (YYYY/MM/DD)
 * @param {number} ts - 秒级时间戳
 * @returns {string} 格式化日期
 */
function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' })
}

/**
 * 将秒级时间戳格式化为本地完整日期时间 (YYYY/MM/DD HH:mm)
 * @param {number} ts - 秒级时间戳
 * @returns {string} 格式化日期时间
 */
function fmtDateTime(ts) {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 将字节数值格式化为可读的文件大小字符串 (B / KB / MB)
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小字符串
 */
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/* ── 在线文本笔记与 Markdown 文档编辑器 ──────────────── */

/**
 * 初始化新建与编辑纯文本/Markdown 文档的轻量编辑器模态框
 * 支持实时 Markdown 双栏预览、字数统计、Tab 缩进与快捷提交
 */
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

  let editingDocId = null  // null 表示新建模式，number 表示编辑已有文档

  /**
   * 实时渲染右侧 Markdown 预览面板并进行 XSS 净化
   * @param {string} md - 原始 Markdown 内容
   */
  function renderPreview(md) {
    if (!md.trim()) {
      previewPane.innerHTML = '<div class="text-doc-preview-empty">预览将在右侧实时显示…</div>'
      return
    }
    try {
      const html = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(marked.parse(md))
        : marked.parse(md)
      previewPane.innerHTML = `<div class="md-preview">${html}</div>`
    } catch { previewPane.innerHTML = '<div class="text-doc-preview-empty">预览渲染失败</div>' }
  }

  /**
   * 唤起文本编辑器弹窗
   * @param {object} [opts={}] - 编辑选项（docId, title, content）
   */
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

  /**
   * 统计编辑器当前字数并触发预览更新
   */
  function updateCount() {
    const len = editor.value.length
    charCount.textContent = len.toLocaleString() + ' 字'
    charCount.style.color = len > 100000 ? 'var(--red)' : 'var(--light)'
    renderPreview(editor.value)
  }

  /**
   * 提交保存文本内容至服务端并触发后台向量化索引
   */
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

  // 绑定交互事件
  openBtn.addEventListener('click', () => open())
  closeBtn.addEventListener('click', close)
  cancelBtn.addEventListener('click', close)
  saveBtn.addEventListener('click', save)
  editor.addEventListener('input', updateCount)

  // 支持在代码/文本编辑中按 Tab 键缩进两个空格
  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const s = editor.selectionStart
      const v = editor.value
      editor.value = v.slice(0, s) + '  ' + v.slice(editor.selectionEnd)
      editor.selectionStart = editor.selectionEnd = s + 2
      updateCount()
    }
    // Ctrl/Meta+Enter 快速保存
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
  })

  modal.addEventListener('click', e => { if (e.target === modal) close() })

  // 挂载至全局，供列表“编辑”按钮跨作用域调用
  window._openTextDocModal = open
}

/* ── 用户回答质量反馈数据分析面板 ─────────────────────── */

/**
 * 初始化用户评价与差评归因分析看板模块 (Feedback Analysis Panel)
 * 统计点赞率、各分类错误出现频次及用户填写的详细建议
 */
function initFeedbackPanel() {
  const kbSelect      = document.getElementById('feedback-kb-select')
  const refreshBtn    = document.getElementById('feedback-refresh-btn')
  const loadMoreBtn   = document.getElementById('feedback-load-more')
  const statPositive  = document.getElementById('fb-positive')
  const statNegative  = document.getElementById('fb-negative')
  const statRate      = document.getElementById('fb-rate')
  const reasonsCard   = document.getElementById('feedback-reasons-card')
  const reasonsList   = document.getElementById('feedback-reasons-list')
  const feedbackList  = document.getElementById('feedback-list')
  const feedbackEmpty = document.getElementById('feedback-empty')

  /** 差评归因中文代号表 */
  const REASON_LABELS = {
    doc_missing: '知识库缺少文档',
    wrong_answer: '回答有误',
    not_found: '没找到内容',
    other: '其他',
  }

  let currentKbId = null
  let offset = 0
  const limit = 20

  /**
   * 填充知识库筛选下拉选项
   */
  function populateKbSelect() {
    kbSelect.innerHTML = ''
    const kbs = typeof allKbs !== 'undefined' ? allKbs : []
    if (!kbs.length) {
      kbSelect.innerHTML = '<option value="">暂无知识库</option>'
      return
    }
    for (const kb of kbs) {
      const opt = document.createElement('option')
      opt.value = kb.id
      opt.textContent = kb.name
      kbSelect.appendChild(opt)
    }
    currentKbId = kbs[0]?.id ?? null
    kbSelect.value = currentKbId
  }

  /**
   * 渲染好评数、差评数、好评率以及原因分布柱形条
   * @param {object} stats - 统计数据对象
   */
  function renderStats(stats) {
    statPositive.textContent = stats.positive
    statNegative.textContent = stats.negative
    const total = stats.positive + stats.negative
    statRate.textContent = total > 0 ? `${Math.round(stats.positive / total * 100)}%` : '—'

    const reasons = Object.entries(stats.byReason ?? {})
    if (reasons.length > 0) {
      reasonsList.innerHTML = ''
      for (const [key, cnt] of reasons.sort((a, b) => b[1] - a[1])) {
        const row = document.createElement('div')
        row.className = 'feedback-reason-row'
        row.innerHTML = `<span class="feedback-reason-name">${REASON_LABELS[key] ?? key}</span><span class="feedback-reason-cnt">${cnt} 次</span>`
        reasonsList.appendChild(row)
      }
      reasonsCard.style.display = ''
    } else {
      reasonsCard.style.display = 'none'
    }
  }

  /**
   * 渲染用户详细反馈表格列表
   * @param {Array<object>} items - 反馈明细数组
   * @param {boolean} [append=false] - 是否追加模式
   */
  function renderItems(items, append = false) {
    if (!append) feedbackList.innerHTML = ''
    if (!items.length && !append) {
      feedbackEmpty.classList.remove('hidden')
      return
    }
    feedbackEmpty.classList.add('hidden')
    for (const item of items) {
      const tr = document.createElement('tr')
      const date = new Date(item.created_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      const snippet = (item.question_snippet ?? '').slice(0, 60)
      const reason = item.reason ? (REASON_LABELS[item.reason] ?? item.reason) : '—'
      const comment = item.comment ? escHtml(item.comment.slice(0, 80)) : '—'
      tr.innerHTML = `
        <td style="white-space:nowrap;color:var(--muted);font-size:12px">${escHtml(date)}</td>
        <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(item.conversation_title ?? '—')}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)">${escHtml(snippet)}</td>
        <td><span class="badge badge-warn">${escHtml(reason)}</span></td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px">${comment}</td>
      `
      feedbackList.appendChild(tr)
    }
  }

  /**
   * 从服务端拉取指定知识库的质量反馈明细与统计指标
   * @param {boolean} [append=false] - 是否分页加载更多
   */
  async function loadFeedback(append = false) {
    if (!currentKbId) return
    if (!append) offset = 0
    try {
      const res = await fetch(`/api/admin/kbs/${currentKbId}/feedback?limit=${limit}&offset=${offset}`, { headers: auth() })
      if (!res.ok) return
      const data = await res.json()
      if (!append) renderStats(data.stats)
      renderItems(data.items, append)
      offset += data.items.length
      loadMoreBtn.classList.toggle('hidden', !data.hasMore)
    } catch {}
  }

  kbSelect.addEventListener('change', () => {
    currentKbId = kbSelect.value ? Number(kbSelect.value) : null
    loadFeedback()
  })
  refreshBtn.addEventListener('click', () => loadFeedback())
  loadMoreBtn.addEventListener('click', () => loadFeedback(true))

  // 切换到 feedback 标签页时动态触发加载
  document.querySelectorAll('.tab-btn[data-tab="feedback"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentKbId) populateKbSelect()
      loadFeedback()
    })
  })

  populateKbSelect()
}

/* ── MCP (Model Context Protocol) 开放平台接入管理 ───── */

/**
 * 初始化 Model Context Protocol (MCP) 接入管理面板
 * 负责分发和吊销 API Key，并针对 Claude Desktop / Cursor 生成标准客户端配置
 */
function initMcpPanel() {
  const keysListEl  = document.getElementById('mcp-keys-list')
  const createBtn   = document.getElementById('create-mcp-key-btn')

  // ── 创建 API Key 模态弹层 ──
  const createModal   = document.getElementById('mcp-key-modal')
  const createClose   = document.getElementById('mcp-key-modal-close')
  const createCancel  = document.getElementById('mcp-key-modal-cancel')
  const createConfirm = document.getElementById('mcp-key-modal-confirm')
  const labelInput    = document.getElementById('mcp-key-label')
  const kbCheckboxes  = document.getElementById('mcp-kb-checkboxes')

  // ── 生成成功展示凭证弹层 ──
  const resultModal   = document.getElementById('mcp-key-result-modal')
  const resultClose   = document.getElementById('mcp-key-result-close')
  const resultDone    = document.getElementById('mcp-key-result-done')
  const resultValue   = document.getElementById('mcp-key-result-value')
  const configSnippet = document.getElementById('mcp-config-snippet')
  const copyKeyBtn    = document.getElementById('mcp-key-copy-btn')
  const copyConfigBtn = document.getElementById('mcp-config-copy-btn')

  /**
   * 打开生成 Key 弹窗并渲染可授权的知识库多选列表
   */
  function openCreateModal() {
    labelInput.value = ''
    kbCheckboxes.innerHTML = ''
    const kbs = allKbs ?? []
    if (!kbs.length) {
      kbCheckboxes.innerHTML = '<span style="font-size:12px;color:var(--muted)">暂无知识库</span>'
    } else {
      for (const kb of kbs) {
        const label = document.createElement('label')
        label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer'
        label.innerHTML = `<input type="checkbox" value="${kb.id}"> ${escHtml(kb.name)}`
        kbCheckboxes.appendChild(label)
      }
    }
    createModal.classList.remove('hidden')
    labelInput.focus()
  }

  function closeCreateModal() { createModal.classList.add('hidden') }

  createBtn.addEventListener('click', openCreateModal)
  createClose.addEventListener('click', closeCreateModal)
  createCancel.addEventListener('click', closeCreateModal)
  createModal.addEventListener('click', e => { if (e.target === createModal) closeCreateModal() })

  // 提交生成新 API Key
  createConfirm.addEventListener('click', async () => {
    const label  = labelInput.value.trim()
    const kbIds  = Array.from(kbCheckboxes.querySelectorAll('input[type="checkbox"]:checked'))
                       .map(cb => Number(cb.value))

    createConfirm.disabled = true
    createConfirm.textContent = '生成中…'
    try {
      const res = await fetch('/api/mcp/keys', {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label || undefined, kb_ids: kbIds }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error ?? '生成失败', 'error'); return }

      closeCreateModal()
      const resolvedKbIds = Array.isArray(data.kb_ids) ? data.kb_ids : (typeof data.kb_ids === 'string' ? JSON.parse(data.kb_ids || '[]') : kbIds)
      showResultModal(data.key, resolvedKbIds)
      loadMcpKeys()
    } catch { showToast('网络错误', 'error') }
    finally { createConfirm.disabled = false; createConfirm.textContent = '生成' }
  })

  /**
   * 展示生成的明文 API Key，并提供 Claude Desktop 等接入配置示例
   * @param {string} rawKey - 完整明文 API Key
   * @param {number[]} kbIds - 授权绑定的知识库 ID 列表
   */
  function showResultModal(rawKey, kbIds) {
    resultValue.value = rawKey

    const origin  = location.origin
    const distPath = 'H:/enterprise-kb/dist/mcp-stdio.js'

    // HTTP 远程共享配置
    const httpCfg = JSON.stringify({
      mcpServers: {
        'enterprise-kb': {
          type: 'http',
          url: `${origin}/mcp`,
          headers: { Authorization: `Bearer ${rawKey}` },
        },
      },
    }, null, 2)

    // stdio 本地进程配置
    const stdioCfg = JSON.stringify({
      mcpServers: {
        'enterprise-kb': {
          command: 'node',
          args: [distPath, ...kbIds.map(id => `--kb-id=${id}`)],
          env: { MCP_API_KEY: rawKey },
        },
      },
    }, null, 2)

    configSnippet.textContent = `// HTTP 模式（推荐，远程团队共享）\n${httpCfg}\n\n// 或 stdio 本地模式\n${stdioCfg}`
    resultModal.classList.remove('hidden')
  }

  function closeResultModal() { resultModal.classList.add('hidden') }

  resultClose.addEventListener('click', closeResultModal)
  resultDone.addEventListener('click', closeResultModal)
  resultModal.addEventListener('click', e => { if (e.target === resultModal) closeResultModal() })

  copyKeyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(resultValue.value).then(() => showToast('已复制 API Key', 'success'))
  })
  copyConfigBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(configSnippet.textContent).then(() => showToast('已复制配置', 'success'))
  })

  /**
   * 加载现存的 MCP API Key 列表
   */
  async function loadMcpKeys() {
    keysListEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">加载中…</div>'
    try {
      const res = await fetch('/api/mcp/keys', { headers: auth() })
      if (!res.ok) { keysListEl.innerHTML = '<div style="color:var(--muted)">加载失败</div>'; return }
      const keys = await res.json()
      renderMcpKeys(keys)
    } catch { keysListEl.innerHTML = '<div style="color:var(--muted)">加载失败</div>' }
  }

  /**
   * 渲染 MCP Key 数据表格与删除操作
   * @param {Array<object>} keys - Key 列表数据
   */
  function renderMcpKeys(keys) {
    if (!keys.length) {
      keysListEl.innerHTML = '<div class="card" style="padding:20px;color:var(--muted);font-size:13px;max-width:720px">暂无 API Key，点击右上角「生成 API Key」创建第一个。</div>'
      return
    }

    const table = document.createElement('div')
    table.className = 'card'
    table.style.cssText = 'max-width:720px;overflow:hidden'
    table.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            <th style="padding:10px 16px;text-align:left;font-weight:600;color:var(--muted)">标签</th>
            <th style="padding:10px 16px;text-align:left;font-weight:600;color:var(--muted)">前缀</th>
            <th style="padding:10px 16px;text-align:left;font-weight:600;color:var(--muted)">KB 范围</th>
            <th style="padding:10px 16px;text-align:left;font-weight:600;color:var(--muted)">创建时间</th>
            <th style="padding:10px 16px;text-align:left;font-weight:600;color:var(--muted)">最近使用</th>
            <th style="padding:10px 16px"></th>
          </tr>
        </thead>
        <tbody id="mcp-keys-tbody"></tbody>
      </table>`
    keysListEl.innerHTML = ''
    keysListEl.appendChild(table)

    const tbody = document.getElementById('mcp-keys-tbody')
    for (const key of keys) {
      const kbIds  = JSON.parse(key.kb_ids || '[]')
      const kbText = kbIds.length
        ? kbIds.map(id => { const kb = allKbs.find(k => k.id === id); return kb ? kb.name : `KB#${id}` }).join(', ')
        : '全部可访问'
      const created = key.created_at ? new Date(key.created_at * 1000).toLocaleDateString('zh-CN') : '—'
      const used    = key.last_used_at ? new Date(key.last_used_at * 1000).toLocaleDateString('zh-CN') : '从未'
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid var(--border)'
      tr.innerHTML = `
        <td style="padding:10px 16px">${escHtml(key.label || '—')}</td>
        <td style="padding:10px 16px;font-family:monospace;color:var(--muted)">${escHtml(key.key_prefix)}…</td>
        <td style="padding:10px 16px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(kbText)}">${escHtml(kbText)}</td>
        <td style="padding:10px 16px;color:var(--muted)">${created}</td>
        <td style="padding:10px 16px;color:var(--muted)">${used}</td>
        <td style="padding:10px 16px;text-align:right">
          <button class="btn btn-sm" style="color:#ef4444;border-color:#ef4444" data-delete-key="${key.id}">删除</button>
        </td>`
      tbody.appendChild(tr)
    }

    // 吊销并删除 Key
    tbody.addEventListener('click', async e => {
      const btn = e.target.closest('[data-delete-key]')
      if (!btn) return
      const id = Number(btn.dataset.deleteKey)
      if (!confirm('确定删除此 API Key？删除后相关接入将立即失效。')) return
      const res = await fetch(`/api/mcp/keys/${id}`, { method: 'DELETE', headers: auth() })
      if (res.ok) { showToast('已删除', 'success'); loadMcpKeys() }
      else { const d = await res.json(); showToast(d.error ?? '删除失败', 'error') }
    })
  }

  // 切换到 MCP 标签页时触发数据加载
  document.querySelectorAll('.tab-btn[data-tab="mcp"]').forEach(btn => {
    btn.addEventListener('click', loadMcpKeys)
  })
}
