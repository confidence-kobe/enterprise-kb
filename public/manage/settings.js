/**
 * 管理控制台 · 设置（管理员）：模型热切换、数据备份。
 */

/* ── 系统设置（模型热切换） ──────────────────────────── */
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

/* ── 数据备份 ─────────────────────────────────────── */
let backupPollTimer = null

function renderBackupStatus(status) {
  const scheduleEl = document.getElementById('backup-schedule')
  const lastEl     = document.getElementById('backup-last')
  const listEl     = document.getElementById('backup-list')
  const btn        = document.getElementById('backup-now-btn')

  scheduleEl.innerHTML = status.enabled
    ? `自动备份：每 ${status.intervalHours} 小时一次，保留最近 ${status.keep} 份${status.nextAt && !status.running ? ` · 下次约 ${escHtml(fmtIsoTime(status.nextAt))}` : ''}`
    : `自动备份未开启。在服务器的 <code>.env</code> 中设置 <code>BACKUP_INTERVAL_HOURS=24</code> 即可每天自动备份。`

  btn.disabled = status.running
  btn.textContent = status.running ? '备份中…' : '立即备份'

  const last = status.last
  lastEl.classList.toggle('hidden', !last)
  if (last) {
    const how = last.trigger === 'manual' ? '手动' : '自动'
    lastEl.className = `backup-last ${last.ok ? 'ok' : 'failed'}`
    lastEl.textContent = last.ok
      ? `上次${how}备份成功 · ${fmtIsoTime(last.at)}`
      : `上次${how}备份失败 · ${fmtIsoTime(last.at)} · ${last.error}`
  }

  listEl.innerHTML = status.backups.length
    ? status.backups.map(b => `
        <div class="gap-row backup-row">
          <div class="gap-main">
            <div class="gap-question">${escHtml(fmtIsoTime(b.createdAt))}</div>
            <div class="gap-meta">
              <span>${escHtml(b.name)}</span>
              <span>v${escHtml(b.appVersion)}</span>
              <span>${b.counts.knowledgeBases} 个知识库 · ${b.counts.documents} 份文档 · ${b.counts.users} 个用户</span>
              <span>${fmtBytes(b.storageBytes)}</span>
            </div>
          </div>
        </div>`).join('')
    : '<div class="feedback-empty">还没有备份。</div>'

  clearTimeout(backupPollTimer)
  if (status.running) backupPollTimer = setTimeout(loadBackups, 3000)
}

async function loadBackups() {
  const listEl = document.getElementById('backup-list')
  if (!listEl) return
  try {
    const res  = await fetch('/api/admin/backups', { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    renderBackupStatus(data)
  } catch (e) {
    document.getElementById('backup-schedule').textContent = ''
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

function initBackupSettings() {
  const btn = document.getElementById('backup-now-btn')
  if (!btn) return
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = '备份中…'
    try {
      const res  = await fetch('/api/admin/backups', { method: 'POST', headers: auth() })
      const data = await res.json()
      if (res.ok) {
        showToast(`备份完成：${data.name}`, 'success')
        renderBackupStatus(data.status)
      } else {
        showToast(data.error ?? '备份失败', 'error')
        loadBackups()
      }
    } catch {
      showToast('备份请求失败，请检查网络', 'error')
      loadBackups()
    }
  })
}
