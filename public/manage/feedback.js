/**
 * 管理控制台 · 回答反馈（管理员）：满意度、差评原因分布、差评明细。
 */

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
  document.getElementById('feedback-refresh-btn').addEventListener('click', () => loadFeedbackTab())
  document.getElementById('feedback-load-more').addEventListener('click', () => loadNegativeFeedback(true))
}

function loadFeedbackTab() {
  loadFeedbackSummary()
  loadNegativeFeedback(false)
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
        <div class="manage-stat-label">有帮助</div>
      </div>
      <div class="manage-stat-card">
        <div class="manage-stat-value">${data.total_negative.toLocaleString()}</div>
        <div class="manage-stat-label">没帮助</div>
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
