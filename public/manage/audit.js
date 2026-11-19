/**
 * 管理控制台 · 审计日志（管理员）：操作记录的筛选、分页和中文显示。
 */

/* ── 审计日志 ──────────────────────────────────────── */
const AUDIT_PAGE_SIZE = 40

let auditOffset = 0

let auditTotal = 0

let auditLoading = false

/** 上一次加载还没结束时又改了筛选条件：等它结束后按新条件重新加载，而不是把这次操作吞掉 */
let auditReloadQueued = false

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
  'doc.update_text': '编辑文档',
  'doc.restore_version': '恢复历史版本',
  'qa.ask': '知识库问答',
  'qa.ask_global': '跨库问答',
  'gap.status': '处理待补知识',
  'gap.verify': '验证待补知识',
  'backup.create': '创建备份',
  'backup.failed': '备份失败',
}

const auditEntityLabels = {
  auth: '登录', user: '用户', kb: '知识库', kb_member: '成员', doc: '文档', conversation: '对话',
  config: '配置', backup: '备份', api_key: 'API 密钥', global: '全部知识库',
}

/** 详情里常见字段的中文名；没列出的字段原样显示 */
const auditDetailLabels = {
  question: '问题', turns: '检索轮数', convId: '对话', kbCount: '知识库数', channel: '渠道',
  title: '标题', name: '名称', names: '文件', count: '数量', size: '大小', original_name: '文件',
  username: '用户名', role: '角色', is_public: '公开', model: '模型',
  requested: '请求数', deleted: '已删除', indexed: '已索引', failed: '失败', total: '总数',
  added: '新增', updated: '更新', removed: '移除', queued: '排队', unchanged: '未变', scanned: '扫描', skipped: '跳过',
  errors: '错误', error: '错误', documents: '文档数', versionId: '版本', changed: '有改动',
  path: '路径', sourcePath: '同步目录', prefix: '密钥', owner: '所属用户', expiresAt: '过期时间',
  via: '方式', apiKey: '密钥', status: '状态', answerable: '能答上', announce: '聊天页公开',
}

const auditDetailValues = {
  via: { api_key: 'API 密钥' },
  channel: { mcp: 'MCP' },
  role: { admin: '管理员', user: '普通用户' },
  status: { open: '重新打开', resolved: '已补上', dismissed: '不需要补' },
}

function initAuditLog() {
  const refreshBtn = document.getElementById('audit-refresh-btn')
  const loadMoreBtn = document.getElementById('audit-load-more')
  const actionInput = document.getElementById('audit-action-filter')
  const userInput = document.getElementById('audit-user-filter')
  if (!refreshBtn || !loadMoreBtn) return

  refreshBtn.addEventListener('click', () => loadAuditLog(false))
  loadMoreBtn.addEventListener('click', () => loadAuditLog(true))
  actionInput?.addEventListener('change', () => loadAuditLog(false))
  ;[userInput].filter(Boolean).forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') loadAuditLog(false)
    })
  })
}

async function loadAuditLog(append = false) {
  if (!isAdmin || !auditList) return
  if (auditLoading) {
    if (!append) auditReloadQueued = true
    return
  }
  // 操作下拉框在第一次打开审计页时填充（页面初始化时操作名称表还没定义）
  const actionSelect = document.getElementById('audit-action-filter')
  if (actionSelect && actionSelect.options.length <= 1) {
    actionSelect.insertAdjacentHTML('beforeend', Object.entries(auditActionLabels)
      .map(([code, label]) => `<option value="${escHtml(code)}">${escHtml(label)}</option>`).join(''))
  }
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
    if (auditReloadQueued) {
      auditReloadQueued = false
      loadAuditLog(false)
    }
  }
}

function renderAuditRow(item) {
  const tr = document.createElement('tr')
  const detail = formatAuditDetail(item.detail)
  tr.innerHTML = `
    <td style="white-space:nowrap;color:var(--muted)">${fmtDateTime(item.created_at)}</td>
    <td>${escHtml(item.username || '系统')}</td>
    <td><span class="audit-action">${escHtml(auditActionLabels[item.action] || item.action)}</span></td>
    <td>${escHtml(auditEntityLabels[item.entity_type] || item.entity_type)}${item.entity_id ? ` #${item.entity_id}` : ''}</td>
    <td>${item.kb_id ? (item.kb_name ? escHtml(item.kb_name) : `<span style="color:var(--muted)">#${item.kb_id}（已删除）</span>`) : ''}</td>
    <td class="audit-detail" title="${escHtml(detail)}">${escHtml(detail)}</td>
  `
  return tr
}

function formatAuditValue(key, val) {
  if (auditDetailValues[key]?.[val]) return auditDetailValues[key][val]
  if (typeof val === 'boolean') return val ? '是' : '否'
  if (key === 'size' && typeof val === 'number') return fmtBytes(val)
  if (key === 'expiresAt' && typeof val === 'number') return fmtTime(val)
  if (Array.isArray(val)) return val.map(v => (typeof v === 'object' ? JSON.stringify(v) : v)).join('、')
  if (val && typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

/** 把审计日志的 detail（JSON）变成中文的"字段：值"文本，字段名用 auditDetailLabels 翻译 */
function formatAuditDetail(detail) {
  if (!detail) return ''
  try {
    const value = JSON.parse(detail)
    if (value && typeof value === 'object') {
      return Object.entries(value)
        .filter(([, val]) => val !== null && val !== undefined && val !== '')
        .map(([key, val]) => `${auditDetailLabels[key] || key}：${formatAuditValue(key, val)}`)
        .join(' · ')
        .slice(0, 240)
    }
  } catch { /* 不是 JSON，按纯文本处理 */ }
  return String(detail).slice(0, 240)
}
