/**
 * 管理控制台 · 公共部分：登录状态、主题、页面元素、提示条、格式化小工具、标签页切换。
 * 其他脚本都依赖它，所以最先加载。
 *
 * 管理控制台（manage.html）是原生 JS，没有框架和构建步骤。功能拆在 public/manage/ 下，
 * manage.html 按下面的顺序用 <script> 依次加载，它们共享同一个全局作用域：
 *   core → kbs → inbox → docs → versions → users → audit → feedback → gaps → settings → apikeys → init
 *
 * 每个功能文件的写法：initXxx() 负责绑定事件，loadXxx() 负责请求数据并渲染。
 *
 * 加载规则（重要）：
 *   - 除了本文件开头的登录检查和主题，其他文件顶层只放声明（函数、常量），不要写会立刻执行的语句。
 *   - 页面一加载就要做的事（绑定事件、首次加载数据）全部写在 init.js，它最后加载，
 *     这时所有文件里的函数和常量都已就绪。这样就不会再出现"初始化代码执行时，
 *     后面声明的 const 还没初始化，抛 ReferenceError 让整页失效"的老问题。
 *   - 修改任何一个文件后，把 manage.html 里所有 manage/*.js?v= 的版本号加一（浏览器缓存用）。
 */

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
    btn.innerHTML = isDark ? ICONS.sun : ICONS.moon
    btn.title = isDark ? '切换为浅色模式' : '切换为深色模式'
    btn.addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      if (dark) {
        document.documentElement.removeAttribute('data-theme')
        btn.innerHTML = ICONS.moon; btn.title = '切换为深色模式'
        localStorage.setItem('kb_theme', 'light')
      } else {
        document.documentElement.setAttribute('data-theme', 'dark')
        btn.innerHTML = ICONS.sun; btn.title = '切换为浅色模式'
        localStorage.setItem('kb_theme', 'dark')
      }
    })
  }
})()

/* ── DOM 元素 ──────────────────────────────────────────── */
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

function auth() { return { Authorization: `Bearer ${token}` } }

function showToast(msg, type = '') {
  toast.textContent = msg
  toast.className = type
  toast.classList.remove('hidden')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3000)
}

/* ── Tab 切换 ─────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
      if (btn.dataset.tab === 'inbox' && isAdmin) loadInbox()
      if (btn.dataset.tab === 'audit' && isAdmin) loadAuditLog(false)
      if (btn.dataset.tab === 'feedback' && isAdmin) loadFeedbackTab()
      if (btn.dataset.tab === 'gaps') loadKnowledgeGaps()
      if (btn.dataset.tab === 'settings' && isAdmin) loadBackups()
      if (btn.dataset.tab === 'api') loadApiKeys()
    })
  })
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtIsoTime(iso) {
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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
    if (!ok) throw new Error('复制失败')
  }
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

/** 最近活动时间：今天显示时刻，一周内显示几天前，更早显示日期 */
function fmtRelativeTime(ts) {
  const date = new Date(ts * 1000)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (date.getTime() >= startOfToday) {
    return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  }
  const days = Math.ceil((startOfToday - date.getTime()) / 86400000)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return fmtTime(ts)
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

/** 全局 Escape 关闭弹层 */
function initEscapeKey() {
  /* ── 全局 Escape 关闭弹层 ────────────────────────── */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'))
  })
}
