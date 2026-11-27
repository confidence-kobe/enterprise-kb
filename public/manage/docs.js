/**
 * 管理控制台 · 文档：文档列表和搜索、上传、预览、批量操作、文件夹同步、新建/编辑文本文档。
 */

/* ── 文档管理 ──────────────────────────────────────── */
let currentDocKbId = null

const selectedDocIds = new Set()

// 文档内容搜索（防抖 300ms）
let docSearchTimer = null

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
      // 片段是文档原文，必须先转义再把 >>> <<< 高亮标记换成 <mark>，否则文档里的 HTML 会被执行
      const snippet = escHtml(r.snippet).replace(/&gt;&gt;&gt;/g, '<mark>').replace(/&lt;&lt;&lt;/g, '</mark>')
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

/** 文档的索引状态标签：待解析、解析中（图片显示"识别中"）、已索引、失败（鼠标悬停显示失败原因） */
function docStatusBadge(doc) {
  const status = doc.index_status ?? 'ready'
  const labels = {
    pending: '待解析',
    processing: isImageDoc(doc) ? '识别中' : '解析中',
    ready: doc.index_version ? '已索引' : '未索引',
    error: '失败',
  }
  const title = status === 'error' && doc.index_error
    ? ` title="${escHtml(doc.index_error)}"`
    : ''
  return `<span class="doc-status doc-status-${status}"${title}>${labels[status] ?? status}</span>`
}

const OCR_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp']

function isImageDoc(doc) {
  return OCR_IMAGE_EXTS.some(ext => doc.original_name.toLowerCase().endsWith(ext))
}

function ocrBadge(doc) {
  if (!doc.ocr_pages) return ''
  const what = isImageDoc(doc) ? '这张图片' : `${doc.ocr_pages} 页扫描内容`
  return ` <span class="doc-source doc-source-ocr" title="${what}的文字由 OCR 识别，可能有个别错字，可点「预览」核对">OCR</span>`
}

function docSourceBadge(doc) {
  if (doc.source_type !== 'sync') return ''
  const title = doc.source_path ? ` title="${escHtml(doc.source_path)}"` : ''
  return `<span class="doc-source doc-source-sync"${title}>同步</span>`
}

function vectorBadge(doc) {
  // 文档带有分块数和向量数时，显示向量覆盖率
  const chunks = doc.chunk_count ?? doc.chunks ?? 0
  const vecs   = doc.vec_count  ?? doc.vecs   ?? 0
  if (!chunks) return ''
  const pct = Math.round((vecs / chunks) * 100)
  const cls  = pct >= 90 ? 'vec-badge-full' : pct >= 40 ? 'vec-badge-partial' : 'vec-badge-low'
  return `<span class="doc-vec-badge ${cls}" title="向量覆盖率 ${pct}%（${vecs}/${chunks} 块）">${pct}%</span>`
}

/** 加载当前知识库的文档列表（分页，append 为 true 时是"加载更多"） */
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

  // 显示或隐藏表头
  const tableHeader = document.getElementById('doc-table-header')
  if (tableHeader) tableHeader.style.display = !docs.length && !append ? 'none' : ''

  if (!docs.length && !append) {
    docList.innerHTML = `<div class="inbox-all-clear"><div class="inbox-all-clear-title">这个知识库还没有文档</div><div class="inbox-all-clear-text">把文件拖到上面的上传区，或点击上传区选择文件。</div></div>`
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
      <span class="doc-name" title="${escHtml(doc.original_name)}">${escHtml(doc.original_name)}${doc.source_type === 'sync' ? ' <span class="doc-source doc-source-sync" title="本地同步">同步</span>' : doc.source_type === 'text' ? ' <span class="doc-source doc-source-text" title="内联文本文档">文本</span>' : ''}${ocrBadge(doc)}</span>
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
    summaryEl.textContent = `AI 摘要：${summary}`
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
        <div class="related-doc-item" data-doc-id="${Number(item.doc_id)}" title="${escHtml(item.original_name)}">
          <span class="related-doc-name">${escHtml(item.original_name)}</span>
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

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/** 服务器每次请求最多接收的文件数 */
const UPLOAD_BATCH_SIZE = 20

/** 上传前检查格式和大小（支持的格式以上传框的 accept 为准），不合格的列出原因 */
function checkUploadFiles(files) {
  const accepted = new Set(fileInput.accept.split(',').map(ext => ext.trim().toLowerCase()))
  const ok = []
  const skipped = []
  for (const f of files) {
    const ext = (f.name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
    if (!accepted.has(ext)) skipped.push(`${f.name}（不支持的格式）`)
    else if (f.size > UPLOAD_MAX_BYTES) skipped.push(`${f.name}（超过 50 MB）`)
    else ok.push(f)
  }
  return { ok, skipped }
}

/**
 * 上传文件：先在浏览器里挑出格式不支持和超过 50 MB 的文件（不浪费上传流量），
 * 剩下的每 20 个一批发给服务端（服务端一次最多收 20 个），最后汇总成一条提示。
 * 上传成功只代表文件到了服务器，解析和建索引在后台进行，文档列表里会显示进度。
 */
async function uploadFiles(files) {
  if (!currentDocKbId || !files.length) return
  const { ok, skipped } = checkUploadFiles(files)
  const skippedNote = skipped.length ? `跳过 ${skipped.length} 个：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}` : ''
  if (!ok.length) { showToast(skippedNote, 'error'); return }

  const progressWrap = document.getElementById('upload-progress-wrap')
  const progressText = document.getElementById('upload-progress-text')
  const progressBar  = document.getElementById('upload-progress-bar')
  uploadZone.style.opacity = '.5'
  progressWrap.classList.remove('hidden')
  progressBar.style.background = ''

  const batches = []
  for (let i = 0; i < ok.length; i += UPLOAD_BATCH_SIZE) batches.push(ok.slice(i, i + UPLOAD_BATCH_SIZE))
  let uploaded = 0
  let error = ''
  for (const [i, batch] of batches.entries()) {
    const label = batches.length > 1 ? `上传第 ${i + 1}/${batches.length} 批（${batch.length} 个文件）…` : `上传 ${batch.length} 个文件…`
    try {
      await sendUploadBatch(batch, label)
      uploaded += batch.length
    } catch (e) {
      error = e.message
      break
    }
  }

  uploadZone.style.opacity = '1'
  if (uploaded) loadDocs()
  const parts = []
  if (uploaded) parts.push(`已上传 ${uploaded} 个文件，正在后台解析`)
  if (error) parts.push(`${ok.length - uploaded} 个上传失败：${error}`)
  if (skippedNote) parts.push(skippedNote)
  const failed = Boolean(error || skippedNote)
  progressText.textContent = parts.join('；')
  progressBar.style.width = '100%'
  if (failed) progressBar.style.background = error ? 'var(--red)' : 'var(--amber, #d97706)'
  showToast(parts.join('；'), failed ? 'error' : 'success')
  // 有文件被跳过时多停留一会儿，方便看清是哪些文件
  setTimeout(() => {
    progressWrap.classList.add('hidden')
    progressBar.style.background = ''
  }, failed ? 8000 : 2000)
}

function sendUploadBatch(files, label) {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const progressBar  = document.getElementById('upload-progress-bar')
  const progressPct  = document.getElementById('upload-progress-pct')
  const progressText = document.getElementById('upload-progress-text')
  progressBar.style.width = '0%'
  progressPct.textContent = '0%'
  progressText.textContent = label

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/kbs/${currentDocKbId}/docs`)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return
      const pct = Math.round((e.loaded / e.total) * 100)
      progressBar.style.width = pct + '%'
      progressPct.textContent = pct + '%'
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return }
      let errMsg = '上传失败'
      try { errMsg = JSON.parse(xhr.responseText)?.error ?? errMsg } catch {}
      reject(new Error(errMsg))
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.send(form)
  })
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

  let editingDocId = null  // null 表示新建，数字表示正在编辑的文档

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

/** 文档页：切换知识库时刷新文档列表；文档内容搜索（防抖 300ms） */
function initDocSearch() {
  docKbSelect.addEventListener('change', () => {
    currentDocKbId = docKbSelect.value ? Number(docKbSelect.value) : null
    const docSearch = document.getElementById('doc-search')
    if (docSearch) docSearch.value = ''
    document.getElementById('doc-search-count').textContent = ''
    renderSyncSourcePanel()
    if (currentDocKbId) { uploadArea.classList.remove('hidden'); loadDocs() }
    else { uploadArea.classList.add('hidden') }
  })

  document.addEventListener('input', e => {
    if (e.target.id !== 'doc-search') return
    clearTimeout(docSearchTimer)
    const q = e.target.value.trim()
    if (!q) { loadDocs(); document.getElementById('doc-search-count').textContent = ''; return }
    docSearchTimer = setTimeout(() => searchDocContent(q), 300)
  })
}
