/* ── 认证检查 ──────────────────────────────────────── */
const token = localStorage.getItem('kb_token')
const user  = JSON.parse(localStorage.getItem('kb_user') || 'null')
if (!token || !user) { location.href = '/login.html' }

/* ── 主题初始化 ─────────────────────────────────────── */
;(function initTheme() {
  const saved = localStorage.getItem('kb_theme')
  if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
})()

/* ── 会话过期检测 ────────────────────────────────────── */
;(function initSessionWatch() {
  if (!token) return
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    const exp = payload.exp   // seconds since epoch
    if (!exp) return
    const now = () => Math.floor(Date.now() / 1000)
    const WARN_BEFORE = 5 * 60   // 5 minutes

    function check() {
      const remaining = exp - now()
      if (remaining <= 0) {
        localStorage.removeItem('kb_token')
        localStorage.removeItem('kb_user')
        location.href = '/login.html'
        return
      }
      if (remaining <= WARN_BEFORE) {
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
    setInterval(check, 60_000)

    document.getElementById('session-relogin-btn')?.addEventListener('click', () => {
      localStorage.removeItem('kb_token')
      localStorage.removeItem('kb_user')
      location.href = '/login.html'
    })
  } catch { /* token decode failed, ignore */ }
})()

/* ── 状态 ─────────────────────────────────────────── */
let currentKb             = null
let history               = []
let isLoading             = false
let currentConversationId = null
let conversations         = []
let ollamaOnline          = true
let convOffset            = 0
let convHasMore           = false
let convLoading           = false
const CONV_PAGE_SIZE      = 20

let convBulkMode          = false
const selectedConvIds     = new Set()

// 文档名 → docId 映射，用于 source-ref 点击预览
const kbDocMap = new Map()  // originalName (lower) → docId

/* ── DOM ──────────────────────────────────────────── */
const messagesEl   = document.getElementById('messages')
const welcomeEl    = document.getElementById('welcome')
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

/* ── 初始化 ───────────────────────────────────────── */
userNameEl.textContent = user.username
userBadgeEl.textContent = user.role === 'admin' ? '管理员' : '用户'
userBadgeEl.className = `badge badge-${user.role}`

fetch('/api/config', { headers: auth() })
  .then(r => r.json())
  .then(d => {
    topbarModel.textContent = d.model
    if (!d.ollamaOnline) {
      ollamaOnline = false
      topbarModel.title = 'Ollama 未连接，请先运行 ollama serve'
      topbarModel.style.color = 'var(--red)'
      if (currentKb) {
        sendBtn.disabled = true
        sendBtn.title = 'Ollama 未连接，无法发送'
      }
    }
  })

loadKbs()

function auth() {
  return { Authorization: `Bearer ${token}` }
}

/* ── 加载知识库列表 ────────────────────────────────── */
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

    // 只有一个知识库时自动选中
    if (kbs.length === 1) {
      kbSearchEl.value = ''
      selectKb(kbs[0])
    }

  } catch (e) {
    sidebarKbs.innerHTML = `<div class="no-kb-hint" style="color:var(--red)">加载失败</div>`
  }
}

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

async function selectKb(kb) {
  currentKb = kb
  currentConversationId = null
  history = []
  messagesEl.innerHTML = ''
  updateHistoryCount()
  closeSidebar()

  // 更新侧边栏高亮
  document.querySelectorAll('.kb-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id == kb.id)
  })

  topbarKb.textContent = kb.name
  sendBtn.disabled = !ollamaOnline
  sendBtn.title = ollamaOnline ? '发送' : 'Ollama 未连接，无法发送'
  statsBtn.disabled = false
  exportBtn.disabled = history.length === 0
  inputEl.placeholder = `在「${kb.name}」中提问…`

  // 欢迎屏
  welcomeEl.classList.remove('hidden')
  const descPart = kb.description ? `${kb.description}` : ''
  const statPart = kb.doc_count != null ? `${kb.doc_count} 份文档` : ''
  welcomeSub.textContent = [descPart, statPart].filter(Boolean).join('　·　') || '暂无文档，请前往管理页上传'
  renderWelcomeChips(kb)

  // 加载文档名→ID 映射，供 source-ref 点击使用
  kbDocMap.clear()
  fetch(`/api/kbs/${kb.id}/docs`, { headers: auth() })
    .then(r => r.json())
    .then(docs => { docs.forEach(d => kbDocMap.set(d.original_name.toLowerCase(), d.id)) })
    .catch(() => {})

  // 显示对话历史区块并加载
  convSection.classList.remove('hidden')
  convSearchWrap.classList.remove('hidden')
  sidebarConvs.classList.remove('hidden')
  convSearchEl.value = ''
  await loadConversations(kb.id)
}

/* ── 发送问题 ──────────────────────────────────────── */
async function sendQuestion(question) {
  question = question || inputEl.value.trim()
  if (!question || isLoading || !currentKb) return

  setLoading(true)
  inputEl.value = ''
  resizeTextarea()
  welcomeEl.classList.add('hidden')

  appendUserMessage(question)
  const { row, toolsLog, responseText, cursorEl, copyBtn } = appendAssistantSkeleton()

  try {
    const res = await fetch(`/api/kbs/${currentKb.id}/ask`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history, conversationId: currentConversationId }),
    })

    if (res.status === 401) { location.href = '/login.html'; return }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      throw new Error(e.error ?? `HTTP ${res.status}`)
    }

    await readSSE(res, { toolsLog, responseText, cursorEl, row, copyBtn })
  } catch (err) {
    cursorEl.remove()
    responseText.textContent = `⚠️ ${err.message}`
    responseText.style.color = 'var(--red)'
    setLoading(false)
  }
}

async function readSSE(response, { toolsLog, responseText, cursorEl, row, copyBtn }) {
  const reader  = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastToolBody = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data: ')) continue
      let ev
      try { ev = JSON.parse(line.slice(6)) } catch { continue }

      switch (ev.type) {
        case 'tool_call': {
          const { el, body } = addToolCall(toolsLog, ev.name, ev.input)
          lastToolBody = body
          scrollBottom()
          break
        }
        case 'tool_result': {
          if (lastToolBody) {
            const preview = ev.output?.split('\n').slice(0, 5).join('\n') ?? ''
            lastToolBody.textContent = preview || '（空结果）'
            lastToolBody.className = `tool-call-body ${ev.isError ? 'tool-err' : 'tool-ok'}`
          }
          break
        }
        case 'text': {
          const raw = (responseText.dataset.raw ?? '') + ev.text
          responseText.dataset.raw = raw
          renderMd(responseText, raw, true)
          scrollBottom()
          break
        }
        case 'done': {
          cursorEl.remove()
          renderMd(responseText, responseText.dataset.raw ?? '', false)
          if (Array.isArray(ev.messages)) history = ev.messages
          updateHistoryCount()
          row.querySelector('.msg-meta').textContent = `${ev.turns} 轮检索`
          if (copyBtn) copyBtn.classList.remove('hidden')
          setLoading(false)
          scrollBottom()
          if (ev.conversationId) {
            const isNew = currentConversationId === null
            currentConversationId = ev.conversationId
            if (isNew) await loadConversations(currentKb.id)
            updateConvHighlight()
          }
          break
        }
        case 'error': {
          cursorEl.remove()
          responseText.textContent = `⚠️ ${ev.message}`
          responseText.style.color = 'var(--red)'
          setLoading(false)
          break
        }
      }
    }
  }
}

/* ── DOM 工具 ──────────────────────────────────────── */

function appendUserMessage(text) {
  const row = document.createElement('div')
  row.className = 'msg-user'
  row.innerHTML = `<span class="msg-user-label">Q</span><div class="msg-user-text">${escHtml(text).replace(/\n/g, '<br>')}</div>`
  messagesEl.appendChild(row)
  scrollBottom()
}

function appendAssistantSkeleton() {
  const row = document.createElement('div')
  row.className = 'msg-assistant'

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

  const copyBtn = document.createElement('button')
  copyBtn.className = 'msg-copy-btn hidden'
  copyBtn.title = '复制回答'
  copyBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>`
  copyBtn.addEventListener('click', () => {
    const text = responseText.dataset.raw ?? ''
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><polyline points="2 8 6 12 14 4"/></svg>`
      setTimeout(() => {
        copyBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M3 11V3a1 1 0 0 1 1-1h8"/></svg>`
      }, 1500)
    })
  })
  meta.appendChild(copyBtn)

  row.append(toolsLog, responseText, meta)
  messagesEl.appendChild(row)
  scrollBottom()

  return { row, toolsLog, responseText, cursorEl, copyBtn }
}

function addToolCall(container, name, input) {
  const el = document.createElement('details')
  el.className = 'tool-call'

  const summary = document.createElement('summary')
  summary.innerHTML = `<span class="tool-toggle">▶</span>🔍 <strong>${escHtml(name)}</strong> ${summarizeInput(name, input)}`

  const body = document.createElement('div')
  body.className = 'tool-call-body tool-wait'
  body.textContent = '执行中…'

  el.append(summary, body)
  container.appendChild(el)
  return { el, body }
}

function shortenPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/')
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p
}

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
function ensureMarked() {
  if (_markedReady || typeof marked === 'undefined') return
  marked.setOptions({ breaks: true, gfm: true })
  _markedReady = true
}

function renderMd(el, raw, streaming) {
  const cursor = el.querySelector('.cursor')
  ensureMarked()

  let html
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    // 主路径：marked 解析 + DOMPurify 净化
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
    // 降级路径（CDN 未加载）：原有正则方案
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

  // source-ref 补标 + 点击跳转
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
    }
  })
}

/* ── 辅助 ─────────────────────────────────────────── */

function setLoading(val) {
  isLoading = val
  sendBtn.disabled = val || !currentKb || !ollamaOnline
  inputEl.disabled = val
  thinkingEl.classList.toggle('hidden', !val)
  if (!val && currentKb && !ollamaOnline) {
    sendBtn.title = 'Ollama 未连接，无法发送'
  } else if (!val) {
    sendBtn.title = '发送'
  }
}

function updateHistoryCount() {
  const turns = Math.floor(history.length / 2)
  historyCount.textContent = turns > 0 ? `${turns} 轮对话` : ''
  if (exportBtn) exportBtn.disabled = !currentKb || history.length === 0
}

function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight }

function resizeTextarea() {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function showToast(msg, type = '') {
  toastEl.textContent = msg
  toastEl.className = type
  toastEl.classList.remove('hidden')
  clearTimeout(toastEl._timer)
  toastEl._timer = setTimeout(() => toastEl.classList.add('hidden'), 3000)
}

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

/* ── 对话历史 ──────────────────────────────────────── */

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
  } catch {
    if (reset) sidebarConvs.innerHTML = '<div class="no-kb-hint" style="color:var(--red)">加载失败</div>'
  } finally {
    convLoading = false
  }
}

function renderConversations() {
  sidebarConvs.innerHTML = ''
  if (!conversations.length) {
    sidebarConvs.innerHTML = `
      <div class="no-kb-hint" style="font-size:12px;text-align:center;padding:12px 8px">
        暂无对话<br>
        <button onclick="document.getElementById('new-conv-btn').click()"
                style="margin-top:6px;font-size:11.5px;color:var(--blue);background:none;border:none;cursor:pointer;padding:0">
          点击 ＋ 开始第一个对话
        </button>
      </div>`
    return
  }
  for (const conv of conversations) {
    const btn = document.createElement('button')
    btn.className = 'conv-item'
    btn.dataset.id = conv.id
    const isPinned = Boolean(conv.is_pinned)
    const isChecked = selectedConvIds.has(conv.id)
    btn.innerHTML = `
      <input type="checkbox" class="conv-item-cb ${convBulkMode ? 'visible' : ''}"
             data-id="${conv.id}" ${isChecked ? 'checked' : ''} title="选择">
      <span class="conv-item-icon">${isPinned ? '⭐' : '💬'}</span>
      <span class="conv-item-title">${escHtml(conv.title)}</span>
      <button class="conv-item-pin ${isPinned ? 'pinned' : ''}" data-id="${conv.id}"
              title="${isPinned ? '取消收藏' : '收藏对话'}">★</button>
      <button class="conv-item-del" data-id="${conv.id}" title="删除对话">×</button>
    `
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
    btn.querySelector('.conv-item-cb').addEventListener('click', e => {
      e.stopPropagation()
      if (e.target.checked) selectedConvIds.add(conv.id)
      else selectedConvIds.delete(conv.id)
      updateConvBulkBar()
    })
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
    btn.querySelector('.conv-item-del').addEventListener('click', e => {
      e.stopPropagation()
      deleteConversationLocal(conv.id)
    })
    btn.querySelector('.conv-item-title').addEventListener('dblclick', e => {
      e.stopPropagation()
      startEditConvTitle(btn, conv)
    })
    sidebarConvs.appendChild(btn)
  }
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

function updateConvHighlight() {
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.id) === currentConversationId)
  })
}

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
      // tool_calls only — skip rendering, will show in next tool_result if needed
    }
    // role=tool: skip
  }
  scrollBottom()
}

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

function updateConvBulkBar() {
  const count = selectedConvIds.size
  document.getElementById('conv-selected-count').textContent = `已选 ${count} 条`
  convBulkDeleteBtn.disabled = count === 0
}

function enterBulkMode() {
  convBulkMode = true
  selectedConvIds.clear()
  convBulkBar.classList.remove('hidden')
  renderConversations()
  updateConvBulkBar()
}

function exitBulkMode() {
  convBulkMode = false
  selectedConvIds.clear()
  convBulkBar.classList.add('hidden')
  renderConversations()
}

/* ── 全局搜索 ─────────────────────────────────────── */

function openGlobalSearch() {
  globalSearchPanel.classList.remove('hidden')
  globalSearchInput.value = ''
  globalSearchResults.innerHTML = '<div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px">输入关键词搜索…</div>'
  globalSearchInput.focus()
}

function closeGlobalSearch() {
  globalSearchPanel.classList.add('hidden')
}

let _gsTimer = null
function debounceSearch(q) {
  clearTimeout(_gsTimer)
  if (!q.trim()) {
    globalSearchResults.innerHTML = '<div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px">输入关键词搜索…</div>'
    return
  }
  globalSearchResults.innerHTML = '<div class="no-kb-hint" style="font-size:12px;text-align:center;padding:16px 8px">搜索中…</div>'
  _gsTimer = setTimeout(() => performGlobalSearch(q.trim()), 300)
}

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
      // switch KB if needed
      const kbId = item.kb_id
      if (!currentKb || currentKb.id !== kbId) {
        // find kb in sidebar and select it
        const kbBtn = document.querySelector(`.kb-item[data-id="${kbId}"]`)
        if (kbBtn) {
          const res2 = await fetch('/api/kbs', { headers: auth() })
          const kbs = await res2.json()
          const kb = kbs.find(k => k.id === kbId)
          if (kb) await selectKb(kb)
        }
      }
      // load conversation
      const convRes = await fetch(`/api/conversations/${item.conv_id}/messages`, { headers: auth() })
      if (!convRes.ok) { showToast('加载对话失败', 'error'); return }
      const msgs = await convRes.json()
      history = msgs
      currentConversationId = item.conv_id
      messagesEl.innerHTML = ''
      welcomeEl.classList.add('hidden')
      rebuildChatUI(msgs)
      updateHistoryCount()
      // highlight active conv
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

/* ── 事件绑定 ──────────────────────────────────────── */

sendBtn.addEventListener('click', () => {
  if (!currentKb) { showToast('请先从左侧选择一个知识库', 'error'); return }
  sendQuestion()
})

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendQuestion() }
})

inputEl.addEventListener('input', resizeTextarea)

clearBtn.addEventListener('click', () => {
  if (!confirm('新开一轮对话？（历史记录不会删除）')) return
  currentConversationId = null
  history = []
  messagesEl.innerHTML = ''
  welcomeEl.classList.remove('hidden')
  updateHistoryCount()
  updateConvHighlight()
})

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('kb_token')
  localStorage.removeItem('kb_user')
  location.href = '/login.html'
})

exportBtn.addEventListener('click', () => {
  if (!currentKb || !history.length) return
  exportConversation()
})

/* ── 统计弹层 ──────────────────────────────────────── */
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

/* ── 移动端侧边栏切换 ── */
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

/* ── 知识库搜索过滤 ── */
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

/* ── 对话搜索过滤 ── */
convSearchEl.addEventListener('input', () => {
  const q = convSearchEl.value.trim().toLowerCase()
  document.querySelectorAll('.conv-item').forEach(el => {
    const title = el.querySelector('.conv-item-title')?.textContent?.toLowerCase() ?? ''
    el.style.display = (!q || title.includes(q)) ? '' : 'none'
  })
})

/* ── 全局搜索事件 ── */
globalSearchBtn.addEventListener('click', openGlobalSearch)
globalSearchClose.addEventListener('click', closeGlobalSearch)
globalSearchInput.addEventListener('input', e => debounceSearch(e.target.value))
globalSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeGlobalSearch()
  if (e.key === 'Enter') { clearTimeout(_gsTimer); performGlobalSearch(globalSearchInput.value.trim()) }
})

/* ── 批量管理对话事件 ── */
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

/* ── 深色模式切换 ──────────────────────────────────── */
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
// Set initial icon based on saved or system preference
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

/* ── 修改密码弹层（chat 页） ───────────────────────── */
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

/* ── 全局键盘快捷键 ─────────────────────────────────── */
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName
  const inInput = ['INPUT','TEXTAREA','SELECT'].includes(tag)

  // Escape: close any open modal/panel
  if (e.key === 'Escape') {
    if (!shortcutsModal.classList.contains('hidden'))    { shortcutsModal.classList.add('hidden'); return }
    if (!pwdModal.classList.contains('hidden'))          { closePwdModal(); return }
    if (!globalSearchPanel.classList.contains('hidden')) { closeGlobalSearch(); return }
    if (!statsModal.classList.contains('hidden'))        { statsModal.classList.add('hidden'); return }
    return
  }

  if (inInput) return  // don't intercept when typing

  // ? → shortcuts help
  if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
    shortcutsModal.classList.remove('hidden')
    e.preventDefault()
    return
  }
  // Ctrl+K → global search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    openGlobalSearch()
    e.preventDefault()
    return
  }
  // / → focus KB search
  if (e.key === '/') {
    kbSearchEl.focus()
    kbSearchEl.select()
    e.preventDefault()
    return
  }
  // N → new conversation
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

/* ── 来源文件预览 ────────────────────────────────────── */

const srcModal    = document.getElementById('src-modal')
const srcTitle    = document.getElementById('src-modal-title')
const srcContent  = document.getElementById('src-modal-content')

document.getElementById('src-modal-close').addEventListener('click', () => srcModal.classList.add('hidden'))
srcModal.addEventListener('click', e => { if (e.target === srcModal) srcModal.classList.add('hidden') })

async function openSrcPreview(docId, label, targetLine) {
  srcTitle.textContent = label
  srcContent.textContent = '加载中…'
  srcModal.classList.remove('hidden')

  try {
    const res = await fetch(`/api/kbs/${currentKb.id}/docs/${docId}/preview`, { headers: auth() })
    if (!res.ok) { srcContent.textContent = '加载失败'; return }
    const data = await res.json()

    // 高亮目标行
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

    // 滚动到目标行（行高约 19px）
    srcContent.scrollTop = Math.max(0, (targetLine - 6)) * 19
  } catch (e) {
    srcContent.textContent = `错误：${e.message}`
  }
}

/* ── 页面可见时刷新顶栏模型名（管理页切换模型后返回即更新） ── */
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
