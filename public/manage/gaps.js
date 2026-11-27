/**
 * 管理控制台 · 待补知识：没找到答案的问题，标记已补上/不需要补，重新验证。
 * 管理员看全部，知识库所有者只看自己的知识库（后端按身份过滤）。
 */

/* ── 待补知识 ─────────────────────────────────────────
 * 管理员看全部，知识库所有者只看自己的知识库（后端按身份过滤，这里不用区分）。
 * 每个缺口可以标成「已补上」或「不需要补」；已补上之后又有人问到，会自动回到待处理。
 */
let gapItems = []

function initGapsTab() {
  document.getElementById('gap-status')?.addEventListener('change', () => loadKnowledgeGaps())
  document.getElementById('gap-days')?.addEventListener('change', () => loadKnowledgeGaps())
  document.getElementById('gap-list')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-gap-action]')
    if (!btn) return
    const gap = gapItems[Number(btn.dataset.gapIndex)]
    if (!gap) return
    if (btn.dataset.gapAction === 'docs') { openDocsTab(gap.kb_id); return }
    if (btn.dataset.gapAction === 'verify') { await verifyGap(gap, btn); return }
    btn.disabled = true
    try {
      const res = await fetch('/api/gaps/status', {
        method: 'PUT',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kbId: gap.kb_id, question: gap.question,
          // 在已补上的缺口上点「不公开」「公开」：保持已补上，只改是否显示在聊天页
          status: btn.dataset.gapAction.startsWith('announce') ? 'resolved' : btn.dataset.gapAction,
          ...(btn.dataset.gapAction.startsWith('announce') ? { announce: btn.dataset.gapAction === 'announce-on' } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '操作失败')
      showToast({
        resolved: gap.kb_id ? '已标记为已补上，这个问题会显示在聊天页的「最近补充」里' : '已标记为已补上',
        dismissed: '已标记为不需要补', open: '已重新打开',
        'announce-on': '已在聊天页公开', 'announce-off': '已不在聊天页公开',
      }[btn.dataset.gapAction])
      loadKnowledgeGaps()
      if (isAdmin) loadInbox({ countOnly: true })
    } catch (err) {
      btn.disabled = false
      showToast(err.message, 'error')
    }
  })
}

/**
 * 重新验证：把缺口的问题用真实模型再问一遍。要等十几秒，期间按钮显示「验证中…」。
 * 能答上时提示去标「已补上」，但不替人做决定——答得对不对还得人看一眼回答。
 */
async function verifyGap(gap, btn) {
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = '验证中…'
  try {
    const res = await fetch('/api/gaps/verify', {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kbId: gap.kb_id, question: gap.question }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '验证失败')
    showToast(data.answerable
      ? '现在能答上了，看一眼回答没问题就可以标为已补上'
      : '还是答不上，试试补充或修改文档后再验证')
    await loadKnowledgeGaps()
  } catch (err) {
    btn.disabled = false
    btn.textContent = label
    showToast(err.message, 'error')
  }
}

/** 只有管理员和至少拥有一个知识库的人才有这个标签 */
function updateGapsTabVisibility() {
  const tab = document.getElementById('gaps-tab')
  if (!tab) return
  const visible = isAdmin || allKbs.some(kb => kb.owner_id === user.id)
  tab.style.display = visible ? '' : 'none'
  if (visible) loadKnowledgeGaps({ countOnly: true })
}

async function loadKnowledgeGaps({ countOnly = false } = {}) {
  const listEl = document.getElementById('gap-list')
  const statusEl = document.getElementById('gap-status')
  if (!listEl || !statusEl) return
  const days = document.getElementById('gap-days')?.value || '30'
  const status = countOnly ? 'open' : statusEl.value
  if (!countOnly) listEl.innerHTML = '<div class="feedback-empty">加载中…</div>'
  try {
    const res = await fetch(`/api/gaps?days=${encodeURIComponent(days)}&status=${status}`, { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')

    // 各状态的数量标在下拉选项上，导航上的数字是待处理数
    const labels = { open: '待处理', resolved: '已补上', dismissed: '不需要补' }
    for (const option of statusEl.options) option.textContent = `${labels[option.value]}（${data.counts[option.value]}）`
    const countEl = document.getElementById('gaps-count')
    countEl.textContent = data.counts.open > 99 ? '99+' : String(data.counts.open)
    countEl.classList.toggle('hidden', data.counts.open === 0)
    if (countOnly) return

    gapItems = data.items
    if (!data.items.length) {
      const empty = {
        open: `近 ${data.days} 天没有待处理的缺口。`,
        resolved: `近 ${data.days} 天没有标记为已补上的缺口。`,
        dismissed: `近 ${data.days} 天没有标记为不需要补的缺口。`,
      }[data.status]
      listEl.innerHTML = `<div class="feedback-empty">${empty}</div>`
      return
    }
    listEl.innerHTML = data.items.map((gap, index) => {
      const tags = [
        gap.reopened ? '<span class="gap-tag gap-tag-user" title="标记已补上之后，又有人问到同一个问题">补上后又被问到</span>' : '',
        gap.sources.ai_not_found ? `<span class="gap-tag">AI 未找到 ×${gap.sources.ai_not_found}</span>` : '',
        gap.sources.feedback_not_found ? `<span class="gap-tag gap-tag-user">用户反馈 ×${gap.sources.feedback_not_found}</span>` : '',
        gap.sources.search_empty ? `<span class="gap-tag" title="AI 助手通过 MCP 检索，没有找到任何内容">检索无结果 ×${gap.sources.search_empty}</span>` : '',
      ].join('')
      const check = gap.check
        ? `<span class="gap-tag ${gap.check.answerable ? 'gap-tag-ok' : 'gap-tag-user'}" title="${escHtml(`${gap.check.checked_by || '未知'}，${fmtDateTime(gap.check.checked_at)}`)}">验证：${gap.check.answerable ? '能答上了' : '仍答不上'}</span>`
        : ''
      const checkAnswer = gap.check
        ? `<details class="gap-check"><summary>查看验证时的回答</summary><div class="gap-check-answer">${escHtml(gap.check.answer || '（模型没有给出回答）')}</div></details>`
        : ''
      const handled = gap.status !== 'open'
        ? ` · ${gap.status === 'resolved' ? '已补上' : '不需要补'}（${escHtml(gap.status_by || '未知')}，${fmtDateTime(gap.status_at)}）`
          + (gap.status === 'resolved' && gap.kb_id ? (gap.announce ? ' · 显示在聊天页' : ' · 不在聊天页显示') : '')
        : ''
      const btn = (action, label, kind = 'secondary') =>
        `<button class="btn btn-${kind} btn-sm" data-gap-action="${action}" data-gap-index="${index}">${label}</button>`
      const actions = gap.status === 'open'
        ? [gap.kb_id ? btn('docs', '补充文档') : '', gap.kb_id ? btn('verify', '重新验证') : '', btn('resolved', '已补上'), btn('dismissed', '不需要补')]
        : [gap.status === 'resolved' && gap.kb_id ? btn('verify', '重新验证') : '',
           gap.status === 'resolved' && gap.kb_id ? btn(gap.announce ? 'announce-off' : 'announce-on', gap.announce ? '不公开' : '公开') : '',
           btn('open', '重新打开')]
      return `
        <div class="gap-row">
          <span class="gap-count" title="被问到的次数">${gap.count}</span>
          <div class="gap-main">
            <div class="gap-question">${escHtml(gap.question)}</div>
            <div class="gap-meta">${escHtml(gap.kb_name ?? '全部知识库')} · 最近 ${fmtDateTime(gap.last_at)}${handled} ${tags} ${check}</div>
            ${checkAnswer}
          </div>
          <div class="gap-actions">${actions.join('')}</div>
        </div>`
    }).join('')
  } catch (e) {
    if (!countOnly) listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}
