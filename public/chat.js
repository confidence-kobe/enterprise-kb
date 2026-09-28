/**
 * 企业知识库前端交互引擎 (Chat Client Application)
 *
 * 核心技术架构与交互设计：
 * 1. 认证与生命周期：从 localStorage 读取 JWT 令牌，解析过期时间 (exp) 并在到期前 5 分钟弹出警示 toast，过期自动重定向；
 * 2. 状态机管理：维护当前选中知识库 (currentKb)、会话 ID (currentConversationId)、消息上下文 (history) 与加载状态 (isLoading)；
 * 3. 实时流式传输：通过 Server-Sent Events (SSE) 协议消费大模型打字机输出、思考链切片及 ReAct 工具执行中间态；
 * 4. 动态富文本与防 XSS：结合 marked.js 与 DOMPurify 安全清洗并渲染 Markdown，支持代码块高亮与一键复制；
 * 5. 交互式溯源：识别回答中的 `文件名:行号` 模式并渲染为交互式 Chip，支持一键弹窗精准定位源文档并高亮目标行。
 */

/* ── 认证有效性预检 ───────────────────────────────────── */
const token = localStorage.getItem('kb_token')
let user = null
try { user = JSON.parse(localStorage.getItem('kb_user') || 'null') } catch { user = null }
// 若未登录或未存储有效凭据，立即重定向至登录页
if (!token || !user) { localStorage.removeItem('kb_user'); location.href = '/login.html' }

/* ── 主题模式初始化 ───────────────────────────────────── */
;(function initTheme() {
  const saved = localStorage.getItem('kb_theme')
  // 恢复之前持久化的深色主题偏好
  if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
})()

/* ── JWT 会话过期守护监听器 ──────────────────────────── */
;(function initSessionWatch() {
  if (!token) return
  try {
    // 解码 JWT Payload 结构体以提取 exp 过期时间戳
    const payload = JSON.parse(atob(token.split('.')[1]))
    const exp = payload.exp   // UNIX 秒级时间戳
    if (!exp) return
    const now = () => Math.floor(Date.now() / 1000)
    const WARN_BEFORE = 5 * 60   // 提前 5 分钟发出过期警告

    /** 定时比对当前时间与过期时间 */
    function check() {
      const remaining = exp - now()
      if (remaining <= 0) {
        // 已彻底过期：清除本地会话并跳转登录
        localStorage.removeItem('kb_token')
        localStorage.removeItem('kb_user')
        location.href = '/login.html'
        return
      }
      if (remaining <= WARN_BEFORE) {
        // 临近过期：弹出预警提示条
        const mins = Math.ceil(remaining / 60)
        const sessionToast = document.getElementById('session-toast')
        const sessionMsg   = document.getElementById('session-toast-msg')
        if (sessionToast) {
          sessionToast.classList.remove('hidden')
          sessionMsg.textContent = `⚠️ 会话将在 ${mins} 分钟后过期`
        }
      }
    }

    check()
    setInterval(check, 60_000) // 每分钟周期性检查一次

    // 重新登录按钮点击响应
    document.getElementById('session-relogin-btn')?.addEventListener('click', () => {
      localStorage.removeItem('kb_token')
      localStorage.removeItem('kb_user')
      location.href = '/login.html'
    })
  } catch { /* Token 解码失败忽略处理 */ }
})()

/* ── 全局响应式状态机 ───────────────────────────────── */
/** 当前激活选中的知识库对象（或全部知识库虚拟对象） */
let currentKb             = null
/** 当前对话的消息历史数组（供上下文追加与导出使用） */
let history               = []
/** 是否正在等待大模型或工具流式响应 */
let isLoading             = false
/** 用于中止正在进行的 SSE 流式请求的 AbortController 实例 */
let abortController       = null
/** 上一次提问的文本（用于失败重试） */
let lastQuestion          = ''
/** 当前激活的会话主键 ID (conversationId) */
let currentConversationId = null
/** 跨库全局提问虚拟知识库占位对象 */
const ALL_KBS_VIRTUAL     = { id: 'all', name: '全部知识库', is_public: 0, doc_count: 0 }
/** 当前知识库下的历史会话列表 */
let conversations         = []
/** 大模型服务是否可用在线 */
let llmOnline             = true
/** 会话分页拉取偏移量 */
let convOffset            = 0
/** 是否还有更多历史会话未加载 */
let convHasMore           = false
/** 历史会话加载中互斥锁 */
let convLoading           = false
/** 单次分页拉取会话条数 */
const CONV_PAGE_SIZE      = 20

/** 是否处于批量选择删除会话模式 */
let convBulkMode          = false
/** 批量选中的会话 ID 集合 */
const selectedConvIds     = new Set()
/** 本地存储记录的上次访问知识库 ID 键名 */
const LAST_KB_KEY         = 'kb_last_selected_id'

/** 文档原始小写名称 → docId 快速索引字典，用于将模型输出的引用标签转换为点击跳转弹窗 */
const kbDocMap = new Map()  // originalName (lower) → docId

/* ── DOM 节点引用缓存 ───────────────────────────────── */
const messagesEl   = document.getElementById('messages')
const welcomeEl    = document.getElementById('welcome')
const welcomeKbName = document.getElementById('welcome-kb-name')
const welcomeDocCount = document.getElementById('welcome-doc-count')
const welcomeConvCount = document.getElementById('welcome-conv-count')
const welcomeAccessCount = document.getElementById('welcome-access-count')
const welcomeStatsAction = document.getElementById('welcome-stats-action')
const welcomeManageAction = document.getElementById('welcome-manage-action')
const welcomeDocsAction = document.getElementById('welcome-docs-action')
const welcomeNewConvAction = document.getElementById('welcome-new-conv-action')
const welcomeRecentDocs = document.getElementById('welcome-recent-docs')
const welcomeRecentConvs = document.getElementById('welcome-recent-convs')
const welcomeTitle = document.getElementById('welcome-title')
const welcomeSub   = document.getElementById('welcome-sub')
const inputEl      = document.getElementById('question-input')
const sendBtn      = document.getElementById('send-btn')
const clearBtn     = document.getElementById('clear-btn')
const statsBtn     = document.getElementById('stats-btn')
const exportBtn    = document.getElementById('export-btn')
const statsModal   = document.getElementById('stats-modal')
const statsClose   = document.getElementById('stats-close')
const statsContent = document.getElementById('stats-content')
const thinkingEl   = document.getElementById('thinking-indicator')
const sidebarEl    = document.getElementById('sidebar')
const sidebarOverlay = document.getElementById('sidebar-overlay')
const sidebarToggleBtn = document.getElementById('sidebar-toggle')
const kbSearchEl   = document.getElementById('kb-search')
const historyCount = document.getElementById('history-count')
const topbarKb     = document.getElementById('topbar-kb')
const topbarModel  = document.getElementById('topbar-model')
const sidebarKbs   = document.getElementById('sidebar-kbs')
const convSection    = document.getElementById('conv-section')
const sidebarConvs   = document.getElementById('sidebar-convs')
const convSearchEl   = document.getElementById('conv-search')
const convSearchWrap = document.getElementById('conv-search-wrap')
const toastEl      = document.getElementById('toast')
const userNameEl   = document.getElementById('user-name')
const userBadgeEl  = document.getElementById('user-role-badge')
const themeToggleBtn      = document.getElementById('theme-toggle-btn')
const shortcutsModal      = document.getElementById('shortcuts-modal')
const pwdModal            = document.getElementById('pwd-modal')
const globalSearchBtn     = document.getElementById('global-search-btn')
const globalSearchPanel   = document.getElementById('global-search-panel')
const globalSearchInput   = document.getElementById('global-search-input')
const globalSearchClose   = document.getElementById('global-search-close')
const globalSearchResults = document.getElementById('global-search-results')
const bulkConvBtn         = document.getElementById('bulk-conv-btn')
const convBulkBar         = document.getElementById('conv-bulk-bar')
const convBulkDeleteBtn   = document.getElementById('conv-bulk-delete-btn')
const convBulkCancelBtn   = document.getElementById('conv-bulk-cancel-btn')

/* ── 客户端界面启动初始化 ───────────────────────────── */
userNameEl.textContent = user?.username ?? ''
userBadgeEl.textContent = user?.role === 'admin' ? '管理员' : '用户'
userBadgeEl.className = `badge badge-${user?.role ?? 'user'}`

// 拉取服务端大模型与向量引擎配置
fetch('/api/config', { headers: auth() })
  .then(r => r.json())
  .then(d => {
    topbarModel.textContent = d.model
    if (!d.llmOnline && !d.ollamaOnline) {
      llmOnline = false
      topbarModel.title = '模型服务连接失败，请检查模型配置'
      topbarModel.style.color = 'var(--red)'
      if (currentKb) {
        sendBtn.disabled = true
        sendBtn.title = '模型服务连接失败，无法发送'
      }
    } else if (d.provider) {
      topbarModel.title = `模型供应商：${d.provider}`
    }
    if (d.embeddingEnabled && d.embeddingModel) {
      topbarModel.title += `\n向量搜索：${d.embeddingModel}`
      const dot = document.createElement('span')
      dot.className = 'embedding-dot'
      dot.title = `语义向量搜索已启用（${d.embeddingModel}）`
      topbarModel.after(dot)
    }
  })

// 初始加载知识库清单
loadKbs()
clearAutofilledSidebarSearches()

// 仪表盘快捷操作按钮事件监听
welcomeStatsAction?.addEventListener('click', () => {
  if (!currentKb) return
  openStats()
})

welcomeManageAction?.addEventListener('click', () => {
  location.href = '/manage.html'
})

welcomeDocsAction?.addEventListener('click', () => {
  if (!currentKb) return
  location.href = `/manage.html?tab=docs&kb=${currentKb.id}`
})

welcomeNewConvAction?.addEventListener('click', () => {
  if (!currentKb) return
  startNewConversation()
})

/**
 * 组装带有 Bearer JWT 的 HTTP 请求授权头
 * @returns 包含 Authorization 标头的对象
 */
function auth() {
  return { Authorization: `Bearer ${token}` }
}

/**
 * 规避浏览器对侧边栏 input 历史记录的自动填充干扰
 * 页面加载时若检测到非用户主动输入的搜索框内容则执行清理
 */
function clearAutofilledSidebarSearches() {
  const clearIfAutofilled = input => {
    if (!input || !input.value || input.dataset.userEdited === 'true') return
    input.value = ''
    input.dispatchEvent(new Event('input'))
  }

  ;[kbSearchEl, convSearchEl].forEach(input => {
    input?.addEventListener('input', e => {
      if (e.isTrusted) input.dataset.userEdited = 'true'
    })
  })

  requestAnimationFrame(() => {
    clearIfAutofilled(kbSearchEl)
    clearIfAutofilled(convSearchEl)
  })
  setTimeout(() => {
    clearIfAutofilled(kbSearchEl)
    clearIfAutofilled(convSearchEl)
  }, 500)
}

/* ── 知识库列表加载与交互 ──────────────────────────── */

/**
 * 异步获取当前登录用户有权访问的知识库列表并渲染至侧边栏
 * 包含多知识库时的“全部知识库”虚拟入口以及上一次选择的记忆恢复
 */
async function loadKbs() {
  try {
    const res = await fetch('/api/kbs', { headers: auth() })
    if (res.status === 401) { location.href = '/login.html'; return }
    const kbs = await res.json()

    sidebarKbs.innerHTML = ''
    if (!kbs.length) {
      sidebarKbs.innerHTML = '<div class="no-kb-hint">暂无知识库<br><a href="/manage.html">去管理页创建</a></div>'
      return
    }

    // 若存在多个知识库，渲染一个可同时进行跨库检索的虚拟“全部知识库”卡片
    if (kbs.length > 1) {
      const allBtn = document.createElement('button')
      allBtn.className = 'kb-item kb-item-all'
      allBtn.dataset.id = 'all'
      allBtn.innerHTML = `
        <span class="kb-item-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="1.5" x2="8" y2="14.5"/><path d="M1.5 8h13"/><path d="M2.5 4.5C4 6 6 7 8 7s4-1 5.5-2.5M2.5 11.5C4 10 6 9 8 9s4 1 5.5 2.5"/></svg></span>
        <span class="kb-item-name">全部知识库</span>
      `
      allBtn.addEventListener('click', () => selectKb(ALL_KBS_VIRTUAL))
      sidebarKbs.appendChild(allBtn)
    }

    // 渲染各具名知识库项
    for (const kb of kbs) {
      const btn = document.createElement('button')
      btn.className = 'kb-item'
      btn.dataset.id = kb.id
      btn.innerHTML = `
        <span class="kb-item-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.086a1 1 0 0 1 .707.293L7.5 4h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5z"/></svg></span>
        <span class="kb-item-name">${escHtml(kb.name)}</span>
        ${kb.is_public ? '<span class="kb-item-pub">公开</span>' : ''}
      `
      btn.addEventListener('click', () => selectKb(kb))
      sidebarKbs.appendChild(btn)
    }

    // 自动恢复上次选中的知识库偏好
    const lastKbId = Number(localStorage.getItem(LAST_KB_KEY) || '')
    const preferredKb = kbs.find(kb => kb.id === lastKbId) || kbs[0]
    if (preferredKb && !currentKb) {
      kbSearchEl.value = ''
      selectKb(preferredKb)
    }

  } catch (e) {
    sidebarKbs.innerHTML = `<div class="no-kb-hint" style="color:var(--red)">加载失败</div>`
  }
}

/**
 * 为欢迎面板渲染常见引导提问词卡片 (Chips)
 * @param kb 当前选中的知识库对象
 */
function renderWelcomeChips(kb) {
  const hintsEl  = document.getElementById('welcome-hints')
  const chipsEl  = document.getElementById('welcome-chips')
  if (!hintsEl || !chipsEl) return

  const suggestions = [
    `${kb.name} 包含哪些核心内容？`,
    '有没有相关的使用指南或操作步骤？',
    '总结一下最重要的几个知识点',
    '有哪些常见问题和解决方案？',
  ]

  chipsEl.innerHTML = ''
  suggestions.forEach(text => {
    const chip = document.createElement('button')
    chip.className = 'welcome-chip'
    chip.textContent = text
    chip.addEventListener('click', () => {
      inputEl.value = text
      inputEl.dispatchEvent(new Event('input'))
      inputEl.focus()
    })
    chipsEl.appendChild(chip)
  })
  hintsEl.style.display = kb.doc_count > 0 ? '' : 'none'
}

/**
 * 切换并激活指定的知识库
 * 重置当前聊天流、加载其文档名称字典并拉取历史会话
 *
 * @param kb 目标知识库元数据对象
 */
async function selectKb(kb) {
  currentKb = kb
  localStorage.setItem(LAST_KB_KEY, String(kb.id))
  currentConversationId = null
  history = []
  messagesEl.innerHTML = ''
  updateHistoryCount()
  closeSidebar()

  // 更新侧边栏项的高亮状态
  document.querySelectorAll('.kb-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id == kb.id)
  })

  const isAll = kb.id === 'all'

  topbarKb.textContent = kb.name
  if (welcomeTitle) welcomeTitle.textContent = kb.name
  sendBtn.disabled = !llmOnline
  sendBtn.title = llmOnline ? '发送' : '模型服务连接失败，无法发送'
  statsBtn.disabled = isAll
  exportBtn.disabled = history.length === 0
  inputEl.placeholder = isAll ? '跨所有知识库提问，Enter 发送' : `在「${kb.name}」中提问，Enter 发送`

  // 跨库搜索模式配置调整
  if (isAll) {
    if (welcomeKbName) welcomeKbName.textContent = '跨库搜索'
    if (welcomeDocCount) welcomeDocCount.textContent = '—'
    if (welcomeConvCount) welcomeConvCount.textContent = '—'
    if (welcomeAccessCount) welcomeAccessCount.textContent = '—'
    welcomeSub.textContent = '将同时搜索你可访问的全部知识库'
    welcomeEl.classList.remove('hidden')
    convSection.classList.add('hidden')
    convSearchWrap.classList.add('hidden')
    sidebarConvs.classList.add('hidden')
    document.getElementById('new-conv-btn')?.classList.add('hidden')
    kbDocMap.clear()
    return
  }

  // 单知识库模式：渲染看板元数据
  if (welcomeKbName) welcomeKbName.textContent = kb.is_public ? '公开知识库' : '私有知识库'
  if (welcomeDocCount) welcomeDocCount.textContent = kb.doc_count ?? 0
  if (welcomeConvCount) welcomeConvCount.textContent = kb.conv_count ?? 0
  if (welcomeAccessCount) welcomeAccessCount.textContent = kb.is_public ? '公开' : '受限'
  welcomeEl.classList.remove('hidden')

  const descPart = kb.description ? `${kb.description}` : ''
  const statPart = kb.doc_count != null ? `${kb.doc_count} 份文档` : ''
  const accessPart = kb.is_public ? '公开可访问' : '成员权限控制'
  welcomeSub.textContent = [descPart, statPart, accessPart].filter(Boolean).join('　·　') || '暂无文档，请前往管理页上传'
  renderWelcomeChips(kb)
  loadDashboardDocs(kb.id)

  // 预加载文档名 → ID 映射，供模型回答中的 source-ref 点击时即时响应
  kbDocMap.clear()
  fetch(`/api/kbs/${kb.id}/docs`, { headers: auth() })
    .then(r => r.json())
    .then(docs => { docs.forEach(d => kbDocMap.set(d.original_name.toLowerCase(), d.id)) })
    .catch(() => {})

  // 展示并拉取该知识库下的对话历史
  convSection.classList.remove('hidden')
  convSearchWrap.classList.remove('hidden')
  sidebarConvs.classList.remove('hidden')
  document.getElementById('new-conv-btn').classList.remove('hidden')
  convSearchEl.value = ''
  await loadConversations(kb.id)
}

/**
 * 在欢迎卡片面板中拉取并展示前 5 个最近收录的文档
 * @param kbId 知识库 ID
 */
async function loadDashboardDocs(kbId) {
  if (!welcomeRecentDocs) return
  welcomeRecentDocs.innerHTML = '<div class="dashboard-empty">加载文档中…</div>'
  try {
    const res = await fetch(`/api/kbs/${kbId}/docs?limit=5&offset=0`, { headers: auth() })
    if (!res.ok) throw new Error('加载失败')
    const data = await res.json()
    const docs = Array.isArray(data) ? data : data.items
    welcomeRecentDocs.innerHTML = ''
    if (!docs.length) {
      welcomeRecentDocs.innerHTML = '<div class="dashboard-empty">这个知识库还没有文档。</div>'
      return
    }
    docs.forEach(doc => {
      const item = document.createElement('button')
      item.className = 'dashboard-list-item'
      item.type = 'button'
      item.innerHTML = `
        <span class="dashboard-list-icon">DOC</span>
        <span class="dashboard-list-copy">
          <span class="dashboard-list-title">${escHtml(doc.original_name)}</span>
          <span class="dashboard-list-meta">${formatFileSize(doc.size)} · ${formatDashboardTime(doc.uploaded_at)}</span>
        </span>
        <span class="dashboard-list-arrow">›</span>
      `
      item.addEventListener('click', () => openSrcPreview(doc.id, doc.original_name, 0))
      welcomeRecentDocs.appendChild(item)
    })
  } catch {
    welcomeRecentDocs.innerHTML = '<div class="dashboard-empty">文档加载失败。</div>'
  }
}

/**
 * 在欢迎面板中展示最近活跃的 5 个对话会话
 */
function renderDashboardConversations() {
  if (!welcomeRecentConvs) return
  welcomeRecentConvs.innerHTML = ''
  const recent = conversations.slice(0, 5)
  if (!recent.length) {
    welcomeRecentConvs.innerHTML = '<div class="dashboard-empty">还没有会话，先发起一个问题。</div>'
    return
  }
  recent.forEach(conv => {
    const item = document.createElement('button')
    item.className = 'dashboard-list-item'
    item.type = 'button'
    item.innerHTML = `
      <span class="dashboard-list-icon">${conv.is_pinned ? 'PIN' : 'AI'}</span>
      <span class="dashboard-list-copy">
        <span class="dashboard-list-title">${escHtml(conv.title)}</span>
        <span class="dashboard-list-meta">${formatDashboardTime(conv.updated_at)}</span>
      </span>
      <span class="dashboard-list-arrow">›</span>
    `
    item.addEventListener('click', () => loadConversation(conv))
    welcomeRecentConvs.appendChild(item)
  })
}

/**
 * 文件字节大小转可读字符串 (B / KB / MB)
 * @param bytes 字节数
 * @returns 格式化后的字符串
 */
function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 仪表盘简易时间戳格式化
 * @param ts 秒级时间戳
 */
function formatDashboardTime(ts) {
  if (!ts) return '暂无更新时间'
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/**
 * 开启一个全新对话会话
 * 清除当前对话流并展示欢迎看板，聚焦输入框
 */
function startNewConversation() {
  currentConversationId = null
  history = []
  messagesEl.innerHTML = ''
  welcomeEl.classList.remove('hidden')
  updateConvHighlight()
  updateHistoryCount()
  inputEl.focus()
}

/**
 * 打开当前知识库的数据指标统计弹窗 (KBStats)
 */
async function openStats() {
  if (!currentKb) return
  statsModal.classList.remove('hidden')
  statsContent.textContent = '加载中…'
  try {
    const res = await fetch(`/api/kbs/${currentKb.id}/stats`, { headers: auth() })
    const data = await res.json()
    statsContent.textContent = data.stats ?? '无数据'
  } catch (err) {
    statsContent.textContent = `请求失败：${err.message}`
  }
}

/* ── 发送问题与流式问答交互 ─────────────────────────── */

/**
 * 向服务器提交用户提问并开启 SSE (Server-Sent Events) 流式响应
 * @param {string} [question] - 可选的提问内容；若未传则读取输入框当前文本
 * @param {object} [options] - 选项配置
 * @param {boolean} [options.skipUserMsg=false] - 是否跳过追加用户消息气泡（用于重试时避免重复添加）
 */
async function sendQuestion(question, { skipUserMsg = false } = {}) {
  question = question || inputEl.value.trim()
  if (!question || isLoading || !currentKb) return

  lastQuestion = question
  setLoading(true)
  if (!skipUserMsg) {
    inputEl.value = ''
    resizeTextarea()
    welcomeEl.classList.add('hidden')
    appendUserMessage(question)
  }
  // 在对话流中插入助手占位骨架元素，获取内部挂载节点
  const { row, toolsLog, responseText, cursorEl, copyBtn, thumbUp, thumbDown, sourcesSection } = appendAssistantSkeleton()

  // 创建中断控制器，以便用户点击“停止”按钮时能够立即终止请求
  abortController = new AbortController()

  try {
    const isAllKbs = currentKb.id === 'all'
    const askUrl = isAllKbs ? '/api/ask' : `/api/kbs/${currentKb.id}/ask`
    const askBody = isAllKbs
      ? { question }
      : { question, conversationId: currentConversationId }
    const res = await fetch(askUrl, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(askBody),
      signal: abortController.signal,
    })

    // 鉴权失效（401）重定向至登录页
    if (res.status === 401) { location.href = '/login.html'; return }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      throw new Error(e.error ?? `HTTP ${res.status}`)
    }

    // 读取并解析 SSE 数据流
    await readSSE(res, { toolsLog, responseText, cursorEl, row, copyBtn, thumbUp, thumbDown, sourcesSection, question })
  } catch (err) {
    cursorEl.remove()
    if (err.name === 'AbortError') {
      // 用户主动点击了停止生成
      const raw = responseText.dataset.raw ?? ''
      if (raw) {
        renderMd(responseText, raw, false)
        responseText.insertAdjacentHTML('beforeend', '<p style="color:var(--muted);font-size:12px;margin-top:8px">（已停止）</p>')
      } else {
        responseText.innerHTML = '<span style="color:var(--muted)">（已停止）</span>'
      }
    } else {
      // 网络错误或服务异常，展示错误信息并附带重试按钮
      responseText.innerHTML = `<span style="color:var(--red)">⚠️ ${escHtml(err.message)}</span>`
      appendRetryBtn(row, question)
    }
    setLoading(false)
  }
}

/**
 * 在失败的回答消息气泡下方追加“重试”按钮
 * @param {HTMLElement} row - 助手消息容器行
 * @param {string} question - 需要重新发送的问题文本
 */
function appendRetryBtn(row, question) {
  const btn = document.createElement('button')
  btn.className = 'msg-retry-btn'
  btn.textContent = '↻ 重试'
  btn.addEventListener('click', () => {
    row.remove()
    sendQuestion(question, { skipUserMsg: true })
  })
  row.querySelector('.msg-ai-body')?.appendChild(btn)
}

/**
 * 读取并逐事件解析服务器推送的 SSE 流式数据
 * @param {Response} response - Fetch 返回的 Response 对象
 * @param {object} context - UI 元素和状态上下文
 * @param {HTMLElement} context.toolsLog - 工具执行调用折叠容器
 * @param {HTMLElement} context.responseText - AI 回答内容显示容器
 * @param {HTMLElement} context.cursorEl - 打字机闪烁光标元素
 * @param {HTMLElement} context.row - 整个助手消息行元素
 * @param {HTMLElement} context.copyBtn - 一键复制按钮
 * @param {HTMLElement} context.thumbUp - 点赞按钮
 * @param {HTMLElement} context.thumbDown - 点踩按钮
 * @param {HTMLElement} context.sourcesSection - 参考文档来源列表区域
 * @param {string} context.question - 当前提问文本
 */
async function readSSE(response, { toolsLog, responseText, cursorEl, row, copyBtn, thumbUp, thumbDown, sourcesSection, question }) {
  const reader  = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastToolBody = null
  let lastToolStatus = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // SSE 协议按照连续两个换行符 '\n\n' 分割数据包
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data: ')) continue
      let ev
      try { ev = JSON.parse(line.slice(6)) } catch { continue }

      switch (ev.type) {
        // 工具调用开始事件：创建工具执行卡片
        case 'tool_call': {
          const { el, body, statusSpan } = addToolCall(toolsLog, ev.name, ev.input)
          lastToolBody = body
          lastToolStatus = statusSpan
          scrollBottom()
          break
        }
        // 工具执行结果返回事件：更新工具输出摘要与状态标签
        case 'tool_result': {
          if (lastToolBody) {
            const preview = ev.output?.split('\n').slice(0, 5).join('\n') ?? ''
            lastToolBody.textContent = preview || '（空结果）'
            lastToolBody.className = `tool-call-body ${ev.isError ? 'tool-err' : 'tool-ok'}`
          }
          if (lastToolStatus) {
            lastToolStatus.textContent = ev.isError ? '失败' : '完成'
            lastToolStatus.className = `tool-call-status ${ev.isError ? 'tool-status-err' : 'tool-status-ok'}`
          }
          break
        }
        // 增量文本输出事件：拼接 raw 数据并触发流式 Markdown 渲染
        case 'text': {
          const raw = (responseText.dataset.raw ?? '') + ev.text
          responseText.dataset.raw = raw
          renderMd(responseText, raw, true)
          scrollBottom()
          break
        }
        // 回答完成事件：移除光标、定稿 Markdown、合并历史、渲染来源和评价面板
        case 'done': {
          cursorEl.remove()
          renderMd(responseText, responseText.dataset.raw ?? '', false)
          if (Array.isArray(ev.messages)) history = [...history, ...ev.messages]
          updateHistoryCount()
          row.querySelector('.msg-meta').textContent = ev.context?.truncated
            ? `${ev.turns} 轮检索 · 已使用最近上下文`
            : `${ev.turns} 轮检索`
          if (Array.isArray(ev.sources) && ev.sources.length > 0 && sourcesSection) {
            renderSources(sourcesSection, ev.sources)
            sourcesSection.classList.remove('hidden')
          }
          if (copyBtn) copyBtn.classList.remove('hidden')
          setLoading(false)
          scrollBottom()
          if (ev.conversationId) {
            row.dataset.conversationId = ev.conversationId
            if (thumbUp) thumbUp.classList.remove('hidden')
            if (thumbDown) thumbDown.classList.remove('hidden')
            const isNew = currentConversationId === null
            currentConversationId = ev.conversationId
            if (isNew && currentKb?.id !== 'all') await loadConversations(currentKb.id)
            updateConvHighlight()
          }
          break
        }
        // 服务端错误事件
        case 'error': {
          cursorEl.remove()
          responseText.innerHTML = `<span style="color:var(--red)">⚠️ ${escHtml(ev.message ?? '未知错误')}</span>`
          appendRetryBtn(row, question)
          setLoading(false)
          break
        }
      }
    }
  }
}

/* ── DOM 渲染与消息节点构建 ──────────────────────────── */

/**
 * 在消息流末尾追加用户发言气泡
 * @param {string} text - 用户提问的纯文本
 */
function appendUserMessage(text) {
  const row = document.createElement('div')
  row.className = 'msg-user'
  row.innerHTML = `<div class="msg-user-bubble">${escHtml(text).replace(/\n/g, '<br>')}</div>`
  messagesEl.appendChild(row)
  scrollBottom()
}

/**
 * 在消息流中构建助手的占位骨架结构
 * 包括头像、工具执行日志卡片、回答容器、参考来源列表、反馈评分面板与元数据操作条
 * @returns {object} 返回构建的各核心 DOM 节点引用
 */
function appendAssistantSkeleton() {
  const row = document.createElement('div')
  row.className = 'msg-assistant'

  // AI 头像
  const avatar = document.createElement('div')
  avatar.className = 'msg-ai-avatar'
  avatar.textContent = 'AI'

  // 消息主体内容卡片
  const content = document.createElement('div')
  content.className = 'msg-ai-content'

  const toolsLog = document.createElement('div')
  toolsLog.className = 'tools-log'

  const responseText = document.createElement('div')
  responseText.className = 'response-text'
  responseText.dataset.raw = ''

  const cursorEl = document.createElement('span')
  cursorEl.className = 'cursor'
  responseText.appendChild(cursorEl)

  const meta = document.createElement('div')
  meta.className = 'msg-meta'

  // 一键复制按钮
  const copyBtn = document.createElement('button')
  copyBtn.className = 'msg-copy-btn hidden'
  copyBtn.title = '复制回答'
  copyBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>`
  copyBtn.addEventListener('click', () => {
    const text = responseText.dataset.raw ?? ''
    navigator.clipboard.writeText(text).then(() => {
      // 成功复制后展示对勾动画并在 1.5 秒后复原
      copyBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><polyline points="2 8 6 12 14 4"/></svg>`
      setTimeout(() => {
        copyBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>`
      }, 1500)
    })
  })
  // 点赞 / 点踩反馈按钮
  const thumbUp = document.createElement('button')
  thumbUp.className = 'msg-feedback-btn hidden'
  thumbUp.title = '有帮助'
  thumbUp.textContent = '👍'

  const thumbDown = document.createElement('button')
  thumbDown.className = 'msg-feedback-btn hidden'
  thumbDown.title = '没帮助'
  thumbDown.textContent = '👎'

  // ── 来源卡片区 ────────────────────────────────────────
  const sourcesSection = document.createElement('div')
  sourcesSection.className = 'sources-section hidden'

  // ── 结构化差评面板（选择具体原因及填写补充说明） ────
  const feedbackReasonPanel = document.createElement('div')
  feedbackReasonPanel.className = 'feedback-reason-panel hidden'
  feedbackReasonPanel.innerHTML = `
    <div class="feedback-reason-label">帮我们改进，选择一个原因：</div>
    <div class="feedback-reason-chips">
      <button class="feedback-reason-chip" data-reason="doc_missing">知识库缺少文档</button>
      <button class="feedback-reason-chip" data-reason="wrong_answer">回答有误</button>
      <button class="feedback-reason-chip" data-reason="not_found">没找到内容</button>
      <button class="feedback-reason-chip" data-reason="other">其他</button>
    </div>
    <textarea class="feedback-comment" placeholder="补充说明（可选）" rows="2" maxlength="500"></textarea>
    <div class="feedback-reason-actions">
      <button class="feedback-skip-btn">跳过</button>
      <button class="feedback-submit-btn" disabled>提交</button>
    </div>
  `

  let selectedReason = null
  feedbackReasonPanel.querySelectorAll('.feedback-reason-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      feedbackReasonPanel.querySelectorAll('.feedback-reason-chip').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      selectedReason = btn.dataset.reason
      feedbackReasonPanel.querySelector('.feedback-submit-btn').disabled = false
    })
  })

  /**
   * 提交对当前回答的反馈评分至后台
   * @param {number} rating - 1 表示有帮助，-1 表示没有帮助
   * @param {string|null} reason - 差评原因分类代号
   * @param {string|null} comment - 用户输入的补充文本说明
   */
  function doSubmitFeedback(rating, reason, comment) {
    const convId = row.dataset.conversationId
    if (!convId) return
    thumbUp.classList.toggle('active', rating === 1)
    thumbDown.classList.toggle('active', rating === -1)
    feedbackReasonPanel.classList.add('hidden')
    fetch(`/api/conversations/${convId}/feedback`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, reason: reason ?? undefined, comment: comment ?? undefined }),
    }).catch(() => {})
  }

  feedbackReasonPanel.querySelector('.feedback-submit-btn').addEventListener('click', () => {
    const comment = feedbackReasonPanel.querySelector('.feedback-comment').value.trim() || null
    doSubmitFeedback(-1, selectedReason, comment)
  })
  feedbackReasonPanel.querySelector('.feedback-skip-btn').addEventListener('click', () => {
    doSubmitFeedback(-1, null, null)
  })

  thumbUp.addEventListener('click', () => {
    feedbackReasonPanel.classList.add('hidden')
    doSubmitFeedback(1, null, null)
  })
  thumbDown.addEventListener('click', () => {
    if (thumbDown.classList.contains('active')) return
    selectedReason = null
    feedbackReasonPanel.querySelectorAll('.feedback-reason-chip').forEach(b => b.classList.remove('active'))
    feedbackReasonPanel.querySelector('.feedback-comment').value = ''
    feedbackReasonPanel.querySelector('.feedback-submit-btn').disabled = true
    feedbackReasonPanel.classList.toggle('hidden')
    scrollBottom()
  })

  meta.append(copyBtn, thumbUp, thumbDown)

  content.append(toolsLog, responseText, sourcesSection, feedbackReasonPanel, meta)
  row.append(avatar, content)
  messagesEl.appendChild(row)
  scrollBottom()

  return { row, toolsLog, responseText, cursorEl, copyBtn, thumbUp, thumbDown, sourcesSection }
}

/**
 * 向工具执行日志容器中添加一个可折叠的工具调用卡片
 * @param {HTMLElement} container - 工具日志外层容器
 * @param {string} name - 调用的工具名称（如 Read、Grep、Glob、KBStats）
 * @param {any} input - 工具入参对象
 * @returns {{ el: HTMLElement, body: HTMLElement, statusSpan: HTMLElement }} 卡片及子元素引用
 */
function addToolCall(container, name, input) {
  const el = document.createElement('details')
  el.className = 'tool-call'

  const summary = document.createElement('summary')
  const statusSpan = document.createElement('span')
  statusSpan.className = 'tool-call-status tool-status-wait'
  statusSpan.textContent = '执行中'
  summary.innerHTML = `<span class="tool-toggle">▶</span><span class="tool-call-label">🔍 ${escHtml(name)} ${summarizeInput(name, input)}</span>`
  summary.appendChild(statusSpan)

  const body = document.createElement('div')
  body.className = 'tool-call-body tool-wait'
  body.textContent = '执行中…'

  el.append(summary, body)
  container.appendChild(el)
  return { el, body, statusSpan }
}

/**
 * 缩短文件路径显示，防止长绝对路径撑破卡片宽度
 * @param {string} p - 原始文件路径
 * @returns {string} 缩略后的路径（例如 …/dir/file.txt）
 */
function shortenPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/')
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p
}

/**
 * 在回答下方渲染检索参考文档来源列表，并绑定点击跳转预览事件
 * @param {HTMLElement} container - 来源区域容器
 * @param {Array<{ name: string, line: number, docId?: number }>} sources - 来源项数组
 */
function renderSources(container, sources) {
  const details = document.createElement('details')
  details.className = 'sources-details'

  const summary = document.createElement('summary')
  summary.className = 'sources-summary'
  summary.textContent = `参考来源（${sources.length}）`
  details.appendChild(summary)

  const list = document.createElement('div')
  list.className = 'sources-list'

  for (const src of sources) {
    const card = document.createElement('div')
    card.className = 'source-card'
    const shortName = src.name.length > 40 ? '…' + src.name.slice(-38) : src.name
    card.innerHTML = `<span class="source-name">${escHtml(shortName)}</span><span class="source-line">行 ${src.line}</span>`

    // 若有关联的 docId 且当前非“全部知识库”视图，支持点击在模态框中预览原文
    if (src.docId && currentKb?.id && currentKb.id !== 'all') {
      card.classList.add('source-card-clickable')
      card.addEventListener('click', () => openSrcPreview(src.docId, src.name, src.line))
    }
    list.appendChild(card)
  }

  details.appendChild(list)
  container.appendChild(details)
}

/**
 * 为不同工具调用生成友好的入参摘要字符串
 * @param {string} name - 工具名
 * @param {any} input - 工具入参
 * @returns {string} HTML 格式化后的参数摘要
 */
function summarizeInput(name, input) {
  if (!input) return ''
  if (name === 'Grep') return `<span class="tool-ok">"${escHtml(String(input.pattern ?? ''))}"</span>`
  if (name === 'Glob') return `<span class="tool-ok">"${escHtml(String(input.pattern ?? ''))}"</span>`
  if (name === 'Read') return `<span class="tool-path">${escHtml(shortenPath(String(input.file_path ?? '')))}</span>`
  if (name === 'KBStats') return input.dir ? `<span class="tool-path">${escHtml(String(input.dir))}</span>` : ''
  return `<code>${escHtml(JSON.stringify(input).slice(0, 80))}</code>`
}

/* ── Markdown 渲染（marked.js + DOMPurify，CDN 降级兼容） ── */
let _markedReady = false

/**
 * 初始化配置 marked.js 解析器选项（只执行一次）
 */
function ensureMarked() {
  if (_markedReady || typeof marked === 'undefined') return
  marked.setOptions({ breaks: true, gfm: true })
  _markedReady = true
}

/**
 * 将 Markdown 字符串渲染并净化后挂载到目标 DOM 节点中
 * @param {HTMLElement} el - 承载 HTML 的容器节点
 * @param {string} raw - 原始 Markdown 文本
 * @param {boolean} streaming - 是否处于流式传输中（若为 true 则在末尾保留光标）
 */
function renderMd(el, raw, streaming) {
  const cursor = el.querySelector('.cursor')
  ensureMarked()

  let html
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    // 主路径：采用 marked 解析并通过 DOMPurify 严格白名单过滤，防止 XSS
    html = DOMPurify.sanitize(marked.parse(raw), {
      ALLOWED_TAGS: [
        'p','br','strong','em','code','pre','blockquote',
        'h1','h2','h3','h4','h5','h6',
        'ul','ol','li','table','thead','tbody','tr','th','td',
        'a','span','details','summary','hr',
      ],
      ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
      ALLOW_DATA_ATTR: false,
    })
  } else {
    // 降级路径：在离线或 CDN 未加载时，采用基础正则解析常用 Markdown 标记
    html = escHtml(raw)
      .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
        `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`)
      .replace(/`([^`\n]+)`/g, (_, c) =>
        /[\w.\-/\\]+\.\w+:\d+/.test(c)
          ? `<span class="source-ref">${c}</span>`
          : `<code>${c}</code>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^#{1,3} (.+)$/gm, (_, t) => `<p><strong>${t}</strong></p>`)
      .replace(/^[-*] (.+)$/gm, '• $1')
      .replace(/^\d+\. (.+)$/gm, '• $1')
      .split(/\n{2,}/).map(p => p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '').join('')
  }

  el.innerHTML = html
  if (streaming && cursor) el.appendChild(cursor)

  // 识别文中出现的 `filename:line` 引用标记，绑定点击跳转预览事件
  el.querySelectorAll('code').forEach(c => {
    const text = c.textContent ?? ''
    const m = text.match(/^([\w.\-/ \\]+\.\w+):(\d+)$/)
    if (!m) return
    c.className = 'source-ref'
    const basename = m[1].split(/[/\\]/).pop()?.toLowerCase() ?? ''
    const line = Number(m[2])
    const docId = kbDocMap.get(m[1].toLowerCase()) ?? kbDocMap.get(basename)
    if (docId) {
      c.dataset.docId = docId
      c.addEventListener('click', () => openSrcPreview(docId, m[1], line))
    } else {
      c.addEventListener('click', () => showToast(`文档 "${m[1]}" 暂无预览`, 'error'))
    }
  })
}

/* ── 界面辅助工具函数 ───────────────────────────────── */

const SEND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`
const STOP_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`

/**
 * 切换界面全局加载状态及按钮交互形态（发送 / 停止生成）
 * @param {boolean} val - 是否处于加载中
 */
function setLoading(val) {
  isLoading = val
  inputEl.disabled = val
  thinkingEl.classList.toggle('hidden', !val)
  if (val) {
    sendBtn.disabled = false
    sendBtn.classList.add('stop-mode')
    sendBtn.title = '停止生成'
    sendBtn.innerHTML = STOP_ICON
  } else {
    sendBtn.classList.remove('stop-mode')
    sendBtn.disabled = !currentKb || !llmOnline
    sendBtn.title = (currentKb && !llmOnline) ? '模型服务连接失败，无法发送' : '发送'
    sendBtn.innerHTML = SEND_ICON
  }
}

/**
 * 更新界面顶栏对话轮数统计与导出按钮可用状态
 */
function updateHistoryCount() {
  const turns = Math.floor(history.length / 2)
  historyCount.textContent = turns > 0 ? `${turns} 轮对话` : ''
  if (exportBtn) exportBtn.disabled = !currentKb || history.length === 0
}

/**
 * 自动滚动对话主容器至最底部
 */
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight }

/**
 * 根据输入文本内容自动调整输入框高度（自适应多行，最大 160px）
 */
function resizeTextarea() {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'
}

/**
 * 对文本进行基础的 HTML 字符转义，防御 XSS
 * @param {string} s - 输入文本
 * @returns {string} 转义后的文本
 */
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

/**
 * 弹出全屏浮层提示信息 (Toast)，3 秒后自动隐藏
 * @param {string} msg - 提示内容
 * @param {'success'|'error'|''} [type=''] - 提示样式类
 */
function showToast(msg, type = '') {
  toastEl.textContent = msg
  toastEl.className = type
  toastEl.classList.remove('hidden')
  clearTimeout(toastEl._timer)
  toastEl._timer = setTimeout(() => toastEl.classList.add('hidden'), 3000)
}

/**
 * 将当前对话的全部历史记录（包括用户提问、工具调用链路与 AI 最终回答）
 * 格式化导出为标准的 GitHub Markdown 文件并触发浏览器本地下载
 */
function exportConversation() {
  if (!currentKb || !history.length) return

  const conv    = conversations.find(c => c.id === currentConversationId)
  const title   = conv?.title ?? '未命名对话'
  const kbName  = currentKb.name
  const now     = new Date()
  const pad     = n => String(n).padStart(2, '0')
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`
  const timeStr = `${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}`

  const lines = [
    `# ${title}`, '',
    `> 知识库：${kbName}  `,
    `> 导出时间：${timeStr}`, '',
    '---', '',
  ]

  let i = 0
  while (i < history.length) {
    const msg = history[i]

    if (msg.role === 'user' && msg.content) {
      lines.push('## User', '', String(msg.content), '', '---', '')
      i++; continue
    }

    if (msg.role === 'assistant') {
      const toolCalls = []
      let assistantContent = null
      let j = i
      while (j < history.length) {
        const m = history[j]
        if (m.role === 'assistant') {
          if (m.tool_calls) {
            for (const tc of m.tool_calls) {
              const name  = tc.function?.name ?? tc.name ?? '工具'
              const input = tc.function?.arguments ?? tc.input ?? ''
              toolCalls.push({ name, input, output: null, id: tc.id })
            }
          }
          if (m.content) { assistantContent = m.content; j++; break }
          j++
        } else if (m.role === 'tool') {
          const match = toolCalls.slice().reverse().find(t => t.id === m.tool_call_id)
                     ?? toolCalls.slice().reverse().find(t => t.output === null)
          if (match) match.output = m.content ?? ''
          j++
        } else { break }
      }
      lines.push('## Assistant', '')
      if (toolCalls.length > 0) {
        lines.push('<details>', `<summary>🔍 工具调用（共 ${toolCalls.length} 次）</summary>`, '')
        for (const tc of toolCalls) {
          let inputStr = ''
          try { inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input) } catch { inputStr = String(tc.input) }
          lines.push(`**${tc.name}**`)
          lines.push(`- 输入：\`${inputStr.slice(0, 300)}\``)
          if (tc.output !== null) {
            const preview = String(tc.output).split('\n').slice(0, 5).join('\n')
            lines.push(`- 结果：${preview.slice(0, 400)}`)
          }
          lines.push('')
        }
        lines.push('</details>', '')
      }
      if (assistantContent) lines.push(assistantContent)
      lines.push('', '---', '')
      i = j; continue
    }

    i++
  }

  const md   = lines.join('\n')
  const blob = new Blob([md], { type: 'text/markdown; charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `${title.replace(/[/\\?%*:|"<>]/g, '_')}_${dateStr}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  showToast('对话已导出为 Markdown', 'success')
}

/* ── 对话历史会话管理 ────────────────────────────────── */

/**
 * 分页加载当前知识库下的历史对话会话列表
 * @param {string|number} kbId - 知识库 ID
 * @param {boolean} [reset=true] - 是否重置偏移量从第 1 页开始加载
 */
async function loadConversations(kbId, reset = true) {
  if (reset) { conversations = []; convOffset = 0; convHasMore = false }
  if (convLoading) return
  convLoading = true
  try {
    const res = await fetch(
      `/api/kbs/${kbId}/conversations?limit=${CONV_PAGE_SIZE}&offset=${convOffset}`,
      { headers: auth() }
    )
    if (res.status === 401) { location.href = '/login.html'; return }
    const data = await res.json()
    conversations = reset ? data.items : [...conversations, ...data.items]
    convHasMore   = data.hasMore
    convOffset    = data.nextOffset
    renderConversations()
    renderDashboardConversations()
  } catch {
    if (reset) sidebarConvs.innerHTML = '<div class="no-kb-hint" style="color:var(--red)">加载失败</div>'
  } finally {
    convLoading = false
  }
}

/**
 * 根据时间戳将对话划分为不同的人性化时间分组区间
 * @param {number} ts - 秒级或毫秒级更新时间戳
 * @returns {string} 分组标签（如 '今天'、'昨天'、'最近 7 天'、'最近 30 天'、'YYYY 年 M 月'）
 */
function convDateGroup(ts) {
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts)
  const now = new Date()
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays < 1) return '今天'
  if (diffDays < 2) return '昨天'
  if (diffDays < 7) return '最近 7 天'
  if (diffDays < 30) return '最近 30 天'
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
}

/**
 * 渲染侧边栏对话历史列表
 * 包含置顶收藏项、按日期分段的分组标题以及“加载更多”按钮
 */
function renderConversations() {
  sidebarConvs.innerHTML = ''
  if (!conversations.length) {
    sidebarConvs.innerHTML = `
      <div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px;color:var(--sb-muted)">
        暂无对话记录<br>
        <span style="font-size:11px;opacity:.6">点击上方按钮开始第一个对话</span>
      </div>`
    return
  }

  // 区分置顶收藏与常规未置顶对话
  const pinned = conversations.filter(c => c.is_pinned)
  const unpinned = conversations.filter(c => !c.is_pinned)

  let lastGroup = null
  const renderGroup = (label) => {
    const el = document.createElement('div')
    el.className = 'conv-date-group'
    el.textContent = label
    sidebarConvs.appendChild(el)
  }

  // 优先渲染置顶收藏分组
  if (pinned.length) {
    renderGroup('收藏')
    pinned.forEach(conv => appendConvItem(conv))
  }

  // 按日期归类渲染常规对话
  for (const conv of unpinned) {
    const group = convDateGroup(conv.updated_at ?? conv.created_at)
    if (group !== lastGroup) { renderGroup(group); lastGroup = group }
    appendConvItem(conv)
  }

  // 分页未完结时展示“加载更多”按钮
  if (convHasMore) {
    const loadMoreBtn = document.createElement('button')
    loadMoreBtn.className = 'conv-load-more'
    loadMoreBtn.textContent = '加载更多…'
    loadMoreBtn.addEventListener('click', () => {
      if (!currentKb || convLoading) return
      loadConversations(currentKb.id, false)
    })
    sidebarConvs.appendChild(loadMoreBtn)
  }
  updateConvHighlight()
}

/**
 * 在侧边栏对话容器中构建并追加单个对话项 DOM 元素
 * 支持复选框选择、置顶/取消置顶、删除、以及双击原地修改标题
 * @param {object} conv - 对话记录对象
 */
function appendConvItem(conv) {
  const btn = document.createElement('button')
  btn.className = 'conv-item'
  btn.dataset.id = conv.id
  const isPinned = Boolean(conv.is_pinned)
  const isChecked = selectedConvIds.has(conv.id)
  btn.innerHTML = `
    <input type="checkbox" class="conv-item-cb ${convBulkMode ? 'visible' : ''}"
           data-id="${conv.id}" ${isChecked ? 'checked' : ''} title="选择">
    <span class="conv-item-icon">${isPinned
      ? `<svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" style="color:#fbbf24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="11" height="11"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
    }</span>
    <span class="conv-item-title">${escHtml(conv.title)}</span>
    <button class="conv-item-pin ${isPinned ? 'pinned' : ''}" data-id="${conv.id}"
            title="${isPinned ? '取消收藏' : '收藏对话'}">★</button>
    <button class="conv-item-del" data-id="${conv.id}" title="删除对话">×</button>
  `
    // 点击会话项加载对话或在批量模式下切换勾选状态
    btn.addEventListener('click', e => {
      if (e.target.closest('.conv-item-del') || e.target.closest('.conv-item-pin')) return
      if (convBulkMode) {
        const cb = btn.querySelector('.conv-item-cb')
        cb.checked = !cb.checked
        if (cb.checked) selectedConvIds.add(conv.id)
        else selectedConvIds.delete(conv.id)
        updateConvBulkBar()
        return
      }
      loadConversation(conv)
    })
    // 勾选框事件
    btn.querySelector('.conv-item-cb').addEventListener('click', e => {
      e.stopPropagation()
      if (e.target.checked) selectedConvIds.add(conv.id)
      else selectedConvIds.delete(conv.id)
      updateConvBulkBar()
    })
    // 切换置顶/取消置顶
    btn.querySelector('.conv-item-pin').addEventListener('click', async e => {
      e.stopPropagation()
      const newPinned = !Boolean(conv.is_pinned)
      try {
        const res = await fetch(`/api/conversations/${conv.id}/pin`, {
          method: 'PATCH',
          headers: { ...auth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: newPinned }),
        })
        if (res.ok) {
          conv.is_pinned = newPinned ? 1 : 0
          const idx = conversations.findIndex(c => c.id === conv.id)
          if (idx !== -1) conversations[idx].is_pinned = conv.is_pinned
          conversations.sort((a, b) => (b.is_pinned - a.is_pinned) || (b.updated_at - a.updated_at))
          renderConversations()
          showToast(newPinned ? '对话已收藏' : '已取消收藏', 'success')
        } else {
          showToast('操作失败', 'error')
        }
      } catch {
        showToast('操作失败', 'error')
      }
    })
    // 删除单个会话
    btn.querySelector('.conv-item-del').addEventListener('click', e => {
      e.stopPropagation()
      deleteConversationLocal(conv.id)
    })
    // 双击标题开启原地内联编辑
    btn.querySelector('.conv-item-title').addEventListener('dblclick', e => {
      e.stopPropagation()
      startEditConvTitle(btn, conv)
    })
  sidebarConvs.appendChild(btn)
}

/**
 * 更新侧边栏所有对话项的高亮状态，仅当前激活会话添加 .active 类
 */
function updateConvHighlight() {
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.id) === currentConversationId)
  })
}

/**
 * 从服务端加载指定对话的历史消息记录并重建界面
 * @param {object} conv - 对话记录对象
 */
async function loadConversation(conv) {
  try {
    const res = await fetch(`/api/conversations/${conv.id}/messages`, { headers: auth() })
    if (res.status === 401) { location.href = '/login.html'; return }
    const msgs = await res.json()
    history = msgs
    currentConversationId = conv.id
    messagesEl.innerHTML = ''
    welcomeEl.classList.add('hidden')
    rebuildChatUI(msgs)
    updateHistoryCount()
    updateConvHighlight()
    closeSidebar()
  } catch (e) {
    showToast('加载对话失败：' + e.message, 'error')
  }
}

/**
 * 根据历史消息数组重建聊天对话界面
 * @param {Array<object>} msgs - 历史消息数组
 */
function rebuildChatUI(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    if (msg.role === 'user' && msg.content) {
      appendUserMessage(msg.content)
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        const { responseText, cursorEl, copyBtn } = appendAssistantSkeleton()
        cursorEl.remove()
        renderMd(responseText, msg.content, false)
        if (copyBtn) copyBtn.classList.remove('hidden')
        const rows = messagesEl.querySelectorAll('.msg-assistant')
        const lastRow = rows[rows.length - 1]
        if (lastRow) lastRow.querySelector('.msg-meta').textContent = ''
      }
    }
  }
  scrollBottom()
}

/**
 * 删除单个对话记录并在成功后更新视图
 * @param {number} id - 对话 ID
 */
async function deleteConversationLocal(id) {
  if (!confirm('删除这条对话记录？')) return
  try {
    const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: auth() })
    if (!res.ok) { showToast('删除失败', 'error'); return }
    if (currentConversationId === id) {
      currentConversationId = null
      history = []
      messagesEl.innerHTML = ''
      welcomeEl.classList.remove('hidden')
      exportBtn.disabled = true
      updateHistoryCount()
    }
    await loadConversations(currentKb.id, true)
  } catch (e) {
    showToast('删除失败：' + e.message, 'error')
  }
}

/* ── 批量删除对话 ─────────────────────────────────── */

/**
 * 更新批量操作工具条的已选计数文本及删除按钮可用状态
 */
function updateConvBulkBar() {
  const count = selectedConvIds.size
  document.getElementById('conv-selected-count').textContent = `已选 ${count} 条`
  convBulkDeleteBtn.disabled = count === 0
}

/**
 * 进入对话批量管理模式，显示所有项的复选框及底部操作栏
 */
function enterBulkMode() {
  convBulkMode = true
  selectedConvIds.clear()
  convBulkBar.classList.remove('hidden')
  renderConversations()
  updateConvBulkBar()
}

/**
 * 退出对话批量管理模式，清空选择并隐藏操作栏
 */
function exitBulkMode() {
  convBulkMode = false
  selectedConvIds.clear()
  convBulkBar.classList.add('hidden')
  renderConversations()
}

/* ── 全局跨会话搜索 ─────────────────────────────────── */

/**
 * 唤起全局对话搜索弹层
 */
function openGlobalSearch() {
  globalSearchPanel.classList.remove('hidden')
  globalSearchInput.value = ''
  globalSearchResults.innerHTML = '<div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px">输入关键词搜索…</div>'
  globalSearchInput.focus()
}

/**
 * 关闭全局对话搜索弹层
 */
function closeGlobalSearch() {
  globalSearchPanel.classList.add('hidden')
}

let _gsTimer = null

/**
 * 防抖执行全局搜索（300ms 延迟）
 * @param {string} q - 搜索关键词
 */
function debounceSearch(q) {
  clearTimeout(_gsTimer)
  if (!q.trim()) {
    globalSearchResults.innerHTML = '<div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px">输入关键词搜索…</div>'
    return
  }
  globalSearchResults.innerHTML = '<div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px">搜索中…</div>'
  _gsTimer = setTimeout(() => performGlobalSearch(q.trim()), 300)
}

/**
 * 向服务器发起全局搜索请求
 * @param {string} q - 搜索关键词
 */
async function performGlobalSearch(q) {
  try {
    const res = await fetch(`/api/search/conversations?q=${encodeURIComponent(q)}&limit=20`, { headers: auth() })
    if (res.status === 401) { location.href = '/login.html'; return }
    const data = await res.json()
    renderSearchResults(data.items ?? [], q)
  } catch (e) {
    globalSearchResults.innerHTML = `<div class="no-kb-hint" style="color:var(--red);font-size:12px;text-align:center;padding:16px 8px">搜索失败</div>`
  }
}

/**
 * 渲染全局搜索匹配结果卡片，并高亮匹配的关键词
 * 点击结果条目可自动切换所属知识库并拉取对应对话内容
 * @param {Array<object>} items - 搜索命中条目
 * @param {string} q - 搜索关键词
 */
function renderSearchResults(items, q) {
  if (!items.length) {
    globalSearchResults.innerHTML = '<div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px">未找到相关对话</div>'
    return
  }
  globalSearchResults.innerHTML = ''

  function highlight(text, q) {
    if (!text || !q) return escHtml(text ?? '')
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return escHtml(text).replace(new RegExp(escaped, 'gi'), m => `<mark>${m}</mark>`)
  }

  for (const item of items) {
    const div = document.createElement('div')
    div.className = 'global-search-result-item'
    const snippet = (item.snippet ?? '').slice(0, 120).replace(/\n/g, ' ')
    div.innerHTML = `
      <div class="gs-result-kb">${escHtml(item.kb_name)}</div>
      <div class="gs-result-title">${highlight(item.conv_title, q)}</div>
      <div class="gs-result-snippet">${highlight(snippet, q)}</div>
    `
    div.addEventListener('click', async () => {
      closeGlobalSearch()
      // 如命中结果属于其他知识库，先行自动切换知识库
      const kbId = item.kb_id
      if (!currentKb || currentKb.id !== kbId) {
        const kbBtn = document.querySelector(`.kb-item[data-id="${kbId}"]`)
        if (kbBtn) {
          const res2 = await fetch('/api/kbs', { headers: auth() })
          const kbs = await res2.json()
          const kb = kbs.find(k => k.id === kbId)
          if (kb) await selectKb(kb)
        }
      }
      // 加载命中的具体对话内容
      const convRes = await fetch(`/api/conversations/${item.conv_id}/messages`, { headers: auth() })
      if (!convRes.ok) { showToast('加载对话失败', 'error'); return }
      const msgs = await convRes.json()
      history = msgs
      currentConversationId = item.conv_id
      messagesEl.innerHTML = ''
      welcomeEl.classList.add('hidden')
      rebuildChatUI(msgs)
      updateHistoryCount()
      // 高亮选中的对话列表项
      const convIdx = conversations.findIndex(c => c.id === item.conv_id)
      if (convIdx === -1 && currentKb?.id === kbId) {
        await loadConversations(kbId)
      }
      updateConvHighlight()
      closeSidebar()
    })
    globalSearchResults.appendChild(div)
  }
}

/**
 * 开启会话标题的原地内联编辑输入框
 * 支持回车保存、Esc 取消或失焦后自动持久化
 * @param {HTMLElement} btn - 侧边栏对话按钮节点
 * @param {object} conv - 对话记录对象
 */
function startEditConvTitle(btn, conv) {
  const titleEl  = btn.querySelector('.conv-item-title')
  const original = conv.title

  const input = document.createElement('input')
  input.className = 'conv-title-input'
  input.value = original
  input.maxLength = 60
  titleEl.replaceWith(input)
  input.focus()
  input.select()
  input.addEventListener('click', e => e.stopPropagation())

  let committed = false

  function restoreSpan(text) {
    const span = document.createElement('span')
    span.className = 'conv-item-title'
    span.textContent = text
    span.addEventListener('dblclick', e => { e.stopPropagation(); startEditConvTitle(btn, conv) })
    input.replaceWith(span)
  }

  async function save() {
    if (committed) return
    committed = true
    input.removeEventListener('blur', save)
    const newTitle = input.value.trim()
    if (newTitle && newTitle !== original) {
      try {
        const res = await fetch(`/api/conversations/${conv.id}`, {
          method: 'PATCH',
          headers: { ...auth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        })
        if (res.ok) {
          conv.title = newTitle
          const idx = conversations.findIndex(c => c.id === conv.id)
          if (idx !== -1) conversations[idx].title = newTitle
          showToast('标题已保存', 'success')
          restoreSpan(newTitle)
        } else {
          showToast('保存失败', 'error')
          restoreSpan(original)
        }
      } catch {
        showToast('网络错误', 'error')
        restoreSpan(original)
      }
    } else {
      restoreSpan(conv.title)
    }
  }

  function cancel() {
    if (committed) return
    committed = true
    input.removeEventListener('blur', save)
    restoreSpan(original)
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); save() }
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
  input.addEventListener('blur', save)
}

/* ── DOM 事件监听与绑定 ─────────────────────────────── */

// 点击发送按钮：若正在生成中则触发中止，否则发送提问
sendBtn.addEventListener('click', () => {
  if (isLoading) { abortController?.abort(); return }
  if (!currentKb) { showToast('请先从左侧选择一个知识库', 'error'); return }
  sendQuestion()
})

// 回车键快捷发送（Shift/Ctrl/Meta+Enter 换行）
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    sendQuestion()
  }
})

// 输入内容变化时动态自适应高度
inputEl.addEventListener('input', resizeTextarea)

// Ctrl+Enter 辅助快捷键
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendQuestion() }
}, true)

// 清屏新建对话按钮
clearBtn.addEventListener('click', () => {
  if (!confirm('新开一轮对话？（历史记录不会删除）')) return
  currentConversationId = null
  history = []
  messagesEl.innerHTML = ''
  welcomeEl.classList.remove('hidden')
  updateHistoryCount()
  updateConvHighlight()
})

// 退出登录：清理 localStorage 令牌并跳转至登录页
document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('kb_token')
  localStorage.removeItem('kb_user')
  location.href = '/login.html'
})

// 导出当前对话为 Markdown
exportBtn.addEventListener('click', () => {
  if (!currentKb || !history.length) return
  exportConversation()
})

/* ── 知识库指标统计模态框 ───────────────────────────── */
statsBtn.addEventListener('click', async () => {
  if (!currentKb) return
  statsModal.classList.remove('hidden')
  statsContent.textContent = '加载中…'
  try {
    const res = await fetch(`/api/kbs/${currentKb.id}/stats`, { headers: auth() })
    const data = await res.json()
    statsContent.textContent = data.stats ?? '无数据'
  } catch (err) {
    statsContent.textContent = `请求失败：${err.message}`
  }
})

statsClose.addEventListener('click', () => statsModal.classList.add('hidden'))
statsModal.addEventListener('click', e => { if (e.target === statsModal) statsModal.classList.add('hidden') })

/* ── 移动端侧边栏抽屉切换 ───────────────────────────── */
function openSidebar()  { sidebarEl.classList.add('open'); sidebarOverlay.classList.add('visible') }
function closeSidebar() { sidebarEl.classList.remove('open'); sidebarOverlay.classList.remove('visible') }
sidebarToggleBtn.addEventListener('click', () =>
  sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar()
)
sidebarOverlay.addEventListener('click', closeSidebar)

document.getElementById('new-conv-btn').addEventListener('click', () => {
  if (!currentKb) return
  currentConversationId = null
  history = []
  messagesEl.innerHTML = ''
  welcomeEl.classList.remove('hidden')
  updateConvHighlight()
  updateHistoryCount()
})

/* ── 知识库本地即时过滤 ─────────────────────────────── */
kbSearchEl.addEventListener('input', () => {
  const q = kbSearchEl.value.trim().toLowerCase()
  let anyVisible = false
  document.querySelectorAll('.kb-item').forEach(el => {
    const name = el.querySelector('.kb-item-name')?.textContent?.toLowerCase() ?? ''
    const show = !q || name.includes(q)
    el.style.display = show ? '' : 'none'
    if (show) anyVisible = true
  })
  let noHint = document.getElementById('kb-no-results')
  if (!anyVisible && q) {
    if (!noHint) {
      noHint = document.createElement('div')
      noHint.id = 'kb-no-results'
      noHint.className = 'no-kb-hint'
      noHint.innerHTML = `未找到匹配的知识库&nbsp;<button onclick="document.getElementById('kb-search').value='';document.getElementById('kb-search').dispatchEvent(new Event('input'))" style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0">清除</button>`
      sidebarKbs.appendChild(noHint)
    }
    noHint.style.display = ''
  } else if (noHint) {
    noHint.style.display = 'none'
  }
})

/* ── 对话会话本地过滤 ───────────────────────────────── */
convSearchEl.addEventListener('input', () => {
  const q = convSearchEl.value.trim().toLowerCase()
  document.querySelectorAll('.conv-item').forEach(el => {
    const title = el.querySelector('.conv-item-title')?.textContent?.toLowerCase() ?? ''
    el.style.display = (!q || title.includes(q)) ? '' : 'none'
  })
})

/* ── 全局搜索面板事件 ───────────────────────────────── */
globalSearchBtn.addEventListener('click', openGlobalSearch)
globalSearchClose.addEventListener('click', closeGlobalSearch)
globalSearchInput.addEventListener('input', e => debounceSearch(e.target.value))
globalSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeGlobalSearch()
  if (e.key === 'Enter') { clearTimeout(_gsTimer); performGlobalSearch(globalSearchInput.value.trim()) }
})

/* ── 批量管理对话事件 ───────────────────────────────── */
bulkConvBtn.addEventListener('click', () => {
  if (convBulkMode) exitBulkMode()
  else enterBulkMode()
})
convBulkCancelBtn.addEventListener('click', exitBulkMode)
convBulkDeleteBtn.addEventListener('click', async () => {
  if (!selectedConvIds.size) return
  if (!confirm(`删除选中的 ${selectedConvIds.size} 条对话？`)) return
  try {
    const res = await fetch('/api/conversations/batch', {
      method: 'DELETE',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedConvIds] }),
    })
    if (!res.ok) { showToast('批量删除失败', 'error'); return }
    const deletedIds = new Set(selectedConvIds)
    if (deletedIds.has(currentConversationId)) {
      currentConversationId = null
      history = []
      messagesEl.innerHTML = ''
      welcomeEl.classList.remove('hidden')
      exportBtn.disabled = true
      updateHistoryCount()
    }
    exitBulkMode()
    await loadConversations(currentKb.id, true)
    showToast(`已删除 ${deletedIds.size} 条对话`, 'success')
  } catch (e) {
    showToast('批量删除失败：' + e.message, 'error')
  }
})

/* ── 深色模式与主题切换 ─────────────────────────────── */

/**
 * 切换与持久化系统明暗主题外观
 * @param {boolean} dark - 是否启用深色主题
 */
function applyTheme(dark) {
  if (dark) {
    document.documentElement.setAttribute('data-theme', 'dark')
    themeToggleBtn.textContent = '☀️'
    themeToggleBtn.title = '切换为浅色模式'
    localStorage.setItem('kb_theme', 'dark')
  } else {
    document.documentElement.removeAttribute('data-theme')
    themeToggleBtn.textContent = '🌙'
    themeToggleBtn.title = '切换为深色模式'
    localStorage.setItem('kb_theme', 'light')
  }
}

// 依据用户持久化偏好或操作系统色彩方案设定初始外观
;(() => {
  const saved = localStorage.getItem('kb_theme')
  const isDark = saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)
  applyTheme(isDark)
})()

themeToggleBtn.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  applyTheme(!isDark)
})

/* ── 快捷键帮助弹层 ────────────────────────────────── */
document.getElementById('shortcuts-close').addEventListener('click', () => shortcutsModal.classList.add('hidden'))
shortcutsModal.addEventListener('click', e => { if (e.target === shortcutsModal) shortcutsModal.classList.add('hidden') })

/* ── 修改个人密码弹窗（chat 页面） ─────────────────── */
function openPwdModal() {
  ['chat-pwd-current','chat-pwd-new','chat-pwd-confirm'].forEach(id => { document.getElementById(id).value = '' })
  pwdModal.classList.remove('hidden')
  document.getElementById('chat-pwd-current').focus()
}
function closePwdModal() { pwdModal.classList.add('hidden') }

document.getElementById('change-pwd-btn').addEventListener('click', openPwdModal)
document.getElementById('pwd-modal-close').addEventListener('click', closePwdModal)
document.getElementById('pwd-modal-cancel').addEventListener('click', closePwdModal)
pwdModal.addEventListener('click', e => { if (e.target === pwdModal) closePwdModal() })

document.getElementById('pwd-modal-confirm').addEventListener('click', async () => {
  const current  = document.getElementById('chat-pwd-current').value
  const next     = document.getElementById('chat-pwd-new').value
  const confirm  = document.getElementById('chat-pwd-confirm').value
  if (!current || !next) { showToast('请填写当前密码和新密码', 'error'); return }
  if (next.length < 6)   { showToast('新密码至少 6 位', 'error'); return }
  if (next !== confirm)  { showToast('两次输入的密码不一致', 'error'); return }
  try {
    const res = await fetch('/api/me/password', {
      method: 'PATCH',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.error ?? '修改失败', 'error'); return }
    closePwdModal()
    showToast('密码已修改，请重新登录', 'success')
    setTimeout(() => {
      localStorage.removeItem('kb_token')
      localStorage.removeItem('kb_user')
      location.href = '/login.html'
    }, 1800)
  } catch (e) {
    showToast('网络错误：' + e.message, 'error')
  }
})

/* ── 全局键盘快捷键捕获 ─────────────────────────────── */
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName
  const inInput = ['INPUT','TEXTAREA','SELECT'].includes(tag)

  // Escape 键：关闭当前激活的任何模态层或搜索浮层
  if (e.key === 'Escape') {
    if (!shortcutsModal.classList.contains('hidden'))    { shortcutsModal.classList.add('hidden'); return }
    if (!pwdModal.classList.contains('hidden'))          { closePwdModal(); return }
    if (!globalSearchPanel.classList.contains('hidden')) { closeGlobalSearch(); return }
    if (!statsModal.classList.contains('hidden'))        { statsModal.classList.add('hidden'); return }
    return
  }

  if (inInput) return  // 当用户在表单控件中打字时，不劫持快捷按键

  // 按 '?' 打开快捷键指南
  if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
    shortcutsModal.classList.remove('hidden')
    e.preventDefault()
    return
  }
  // 按 Ctrl+K 开启全局对话搜索
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    openGlobalSearch()
    e.preventDefault()
    return
  }
  // 按 '/' 聚焦到知识库筛选框
  if (e.key === '/') {
    kbSearchEl.focus()
    kbSearchEl.select()
    e.preventDefault()
    return
  }
  // 按 'N' 开启全新对话
  if (e.key === 'n' || e.key === 'N') {
    if (!currentKb) return
    currentConversationId = null
    history = []
    messagesEl.innerHTML = ''
    welcomeEl.classList.remove('hidden')
    updateConvHighlight()
    updateHistoryCount()
    inputEl.focus()
    e.preventDefault()
    return
  }
})

/* ── 来源文档原文在线预览 ───────────────────────────── */

const srcModal    = document.getElementById('src-modal')
const srcTitle    = document.getElementById('src-modal-title')
const srcContent  = document.getElementById('src-modal-content')

document.getElementById('src-modal-close').addEventListener('click', () => srcModal.classList.add('hidden'))
srcModal.addEventListener('click', e => { if (e.target === srcModal) srcModal.classList.add('hidden') })

/**
 * 打开参考来源文件在线预览模态框，并自动高亮并定位滚动至命中行
 * @param {number} docId - 知识库文档 ID
 * @param {string} label - 模态框标题（文件名）
 * @param {number} targetLine - 目标行号（1-based）
 */
async function openSrcPreview(docId, label, targetLine) {
  srcTitle.textContent = label
  srcContent.textContent = '加载中…'
  srcModal.classList.remove('hidden')

  try {
    const res = await fetch(`/api/kbs/${currentKb.id}/docs/${docId}/preview`, { headers: auth() })
    if (!res.ok) { srcContent.textContent = '加载失败'; return }
    const data = await res.json()

    // 按行切分并为目标行增加高亮 CSS 类名
    const lines = data.content.split('\n')
    const frag  = document.createDocumentFragment()
    lines.forEach((ln, i) => {
      const span = document.createElement('span')
      span.textContent = ln + '\n'
      if (i + 1 === targetLine) span.className = 'src-line-highlight'
      frag.appendChild(span)
    })
    srcContent.textContent = ''
    srcContent.appendChild(frag)

    // 精准滚动至目标行视图（以每行平均高度 19px 计算）
    srcContent.scrollTop = Math.max(0, (targetLine - 6)) * 19
  } catch (e) {
    srcContent.textContent = `错误：${e.message}`
  }
}

/* ── 标签页恢复可见时同步刷新顶栏大模型名称 ───────────── */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    try {
      const res = await fetch('/api/config/models', { headers: auth() })
      if (res.ok) {
        const data = await res.json()
        if (data.current) topbarModel.textContent = data.current
      }
    } catch {}
  }
})

