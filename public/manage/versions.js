/**
 * 管理控制台 · 文本文档的历史版本：版本列表、对比差异、恢复。
 */

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
