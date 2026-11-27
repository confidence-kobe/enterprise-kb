/**
 * 管理控制台 · 待处理（管理员首页）：把没找到答案的问题、最近的差评、没能入库的文件汇总在一页。
 */

/* ── 待处理（管理员首页） ─────────────────────────────── */
/**
 * 把三类需要管理员动手的事情放在一页：
 *   待补知识   近 30 天没找到答案的问题（/api/admin/gaps）
 *   差评反馈   最近的差评（/api/admin/feedback/negative）
 *   没能入库   解析失败的文件（逐个知识库读文档列表，筛出 index_status = error）
 * 数据都来自已有接口，这里只是汇总展示。countOnly 为 true 时只更新导航上的数字。
 */
const INBOX_LIMIT = 5

async function loadInbox({ countOnly = false } = {}) {
  const contentEl = document.getElementById('inbox-content')
  const countEl = document.getElementById('inbox-count')
  if (!isAdmin) return
  if (!countOnly) contentEl.innerHTML = '<div class="feedback-empty">加载中…</div>'

  const getJson = url => fetch(url, { headers: auth() }).then(r => r.ok ? r.json() : null).catch(() => null)
  const [gapData, negData, docLists] = await Promise.all([
    getJson('/api/admin/gaps?days=30'),
    getJson(`/api/admin/feedback/negative?limit=${INBOX_LIMIT}&offset=0`),
    Promise.all(allKbs.filter(kb => kb.doc_count > 0).map(kb =>
      getJson(`/api/kbs/${kb.id}/docs`).then(docs => (Array.isArray(docs) ? docs : []).map(d => ({ ...d, kb })))
    )),
  ])
  const gaps = gapData?.items ?? []
  const negatives = negData?.items ?? []
  const negativeTotal = negData?.total ?? negatives.length
  const failedDocs = docLists.flat().filter(d => d.index_status === 'error')

  // 导航上的数字只算「补上就会消失」的事：待补知识和入库失败的文件。
  // 差评没有「已处理」状态，计进去数字会一直不减，所以只在页面里展示最近几条。
  const total = gaps.length + failedDocs.length
  countEl.textContent = total > 99 ? '99+' : String(total)
  countEl.classList.toggle('hidden', total === 0)
  if (countOnly) return

  if (!total && !negatives.length) {
    contentEl.innerHTML = `<div class="inbox-all-clear">
      <div class="inbox-all-clear-title">暂时没有需要处理的事情</div>
      <div class="inbox-all-clear-text">近 30 天员工的问题都找到了答案，没有差评，所有文件都已入库。</div>
    </div>`
    return
  }

  const section = (title, sub, rows, more) => `
    <section class="inbox-section">
      <div class="inbox-section-head">
        <h2 class="inbox-section-title">${title}</h2>
        <span class="inbox-section-sub">${sub}</span>
        ${more ?? ''}
      </div>
      ${rows.length
        ? `<div class="inbox-list">${rows.join('')}</div>`
        : `<div class="inbox-empty">${ICONS.check}<span>没有需要处理的</span></div>`}
    </section>`

  const gapRows = gaps.slice(0, INBOX_LIMIT).map(gap => `
    <div class="inbox-row">
      <div class="inbox-row-main">
        <div class="inbox-row-title">${escHtml(gap.question)}</div>
        <div class="inbox-row-meta">${escHtml(gap.kb_name ?? '全部知识库')}，被问到 ${gap.count} 次，最近一次 ${fmtDateTime(gap.last_at)}</div>
      </div>
      ${gap.kb_id ? `<button class="btn btn-secondary btn-sm" data-inbox-docs="${gap.kb_id}">补充文档</button>` : ''}
    </div>`)

  const negRows = negatives.map(item => {
    const reasonKey = item.reason ?? 'none'
    return `
    <div class="inbox-row">
      <div class="inbox-row-main">
        <div class="inbox-row-title">${escHtml(item.question || '（无提问记录）')}<span class="inbox-tag">${escHtml(feedbackReasonLabels[reasonKey] || reasonKey)}</span></div>
        ${item.comment ? `<div class="inbox-row-quote">“${escHtml(item.comment)}”</div>` : ''}
        <div class="inbox-row-meta">${escHtml(item.username || '已删除用户')}，${escHtml(item.kb_name)}，${fmtDateTime(item.created_at)}</div>
      </div>
    </div>`
  })

  const failedRows = failedDocs.slice(0, INBOX_LIMIT).map(doc => `
    <div class="inbox-row">
      <div class="inbox-row-main">
        <div class="inbox-row-title">${escHtml(doc.original_name)}</div>
        <div class="inbox-row-error">${escHtml(doc.index_error || '解析失败')}</div>
        <div class="inbox-row-meta">${escHtml(doc.kb.name)}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-inbox-docs="${doc.kb.id}">去文档页处理</button>
    </div>`)

  contentEl.innerHTML =
    section('待补知识', gaps.length ? `近 30 天有 ${gaps.length} 个问题没找到答案` : '近 30 天',
      gapRows, gaps.length > INBOX_LIMIT ? '<button class="inbox-section-link" data-inbox-tab="gaps">查看全部</button>' : '') +
    section('最近的差评', negativeTotal ? `共 ${negativeTotal} 条，这里显示最近 ${negatives.length} 条` : '',
      negRows, negativeTotal > negatives.length ? '<button class="inbox-section-link" data-inbox-tab="feedback">查看全部</button>' : '') +
    section('文件没能入库', failedDocs.length ? `${failedDocs.length} 份` : '', failedRows)

  contentEl.querySelectorAll('[data-inbox-docs]').forEach(btn => btn.addEventListener('click', () => openDocsTab(Number(btn.dataset.inboxDocs))))
  contentEl.querySelectorAll('[data-inbox-tab]').forEach(btn => btn.addEventListener('click', () =>
    document.querySelector(`.tab-btn[data-tab="${btn.dataset.inboxTab}"]`)?.click()))
}
