/**
 * 管理控制台 · 知识库：知识库列表和卡片、新建/编辑弹层、成员管理弹层。
 */

/* ── 知识库列表 ────────────────────────────────────── */
let allKbs = []

let feedbackMap = {}     // kb_id → { positive, negative }

let feedbackTotals = {}  // { positive, negative, satisfaction }

let initialRouteApplied = false

async function loadKbs() {
  try {
    const res = await fetch('/api/kbs', { headers: auth() })
    if (res.status === 401) { location.href = '/login.html'; return }
    allKbs = await res.json()

    if (isAdmin) {
      try {
        const fr = await fetch('/api/admin/feedback', { headers: auth() })
        if (fr.ok) {
          const data = await fr.json()
          feedbackMap = {}
          for (const s of data.items) feedbackMap[s.kb_id] = s
          feedbackTotals = { positive: data.total_positive, negative: data.total_negative, satisfaction: data.satisfaction }
        }
      } catch { /* 反馈统计不影响主流程 */ }
    }

    renderKbList()
    renderDocKbSelect()
    updateGapsTabVisibility()
    applyInitialManageRoute()
    if (isAdmin && document.getElementById('tab-inbox').classList.contains('active')) loadInbox()
    else if (isAdmin) loadInbox({ countOnly: true })
  } catch {
    kbList.innerHTML = '<div class="empty-state"><div>加载失败，请刷新重试</div></div>'
  }
}

function applyInitialManageRoute() {
  if (initialRouteApplied) return
  initialRouteApplied = true

  const params = new URLSearchParams(location.search)
  const tab = params.get('tab')
  const kbId = Number(params.get('kb'))
  if (tab && document.querySelector(`.tab-btn[data-tab="${tab}"]`)) {
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).click()
  }
  if (tab === 'docs' && kbId && allKbs.some(kb => kb.id === kbId)) {
    docKbSelect.value = String(kbId)
    docKbSelect.dispatchEvent(new Event('change'))
  }
}

/** 切到文档页并选中某个知识库 */
function openDocsTab(kbId) {
  document.querySelector('.tab-btn[data-tab="docs"]').click()
  if (kbId && allKbs.some(kb => kb.id === kbId)) {
    docKbSelect.value = String(kbId)
    docKbSelect.dispatchEvent(new Event('change'))
  }
}

/** 知识库列表：每行一个知识库，常用操作直接可点，编辑、公开/私有、删除收进「更多」菜单 */
function renderKbList() {
  kbList.innerHTML = ''

  if (!allKbs.length) {
    kbList.innerHTML = `<div class="inbox-all-clear">
      <div class="inbox-all-clear-title">还没有知识库</div>
      <div class="inbox-all-clear-text">点右上角「新建知识库」创建第一个，然后上传文档。</div>
    </div>`
    return
  }

  const totalDocs  = allKbs.reduce((s, k) => s + (k.doc_count  ?? 0), 0)
  const totalConvs = allKbs.reduce((s, k) => s + (k.conv_count ?? 0), 0)
  const summary = document.createElement('p')
  summary.className = 'kb-summary'
  summary.textContent = `${allKbs.length} 个知识库，共 ${totalDocs.toLocaleString()} 份文档、${totalConvs.toLocaleString()} 次对话` +
    (isAdmin && feedbackTotals.satisfaction != null ? `；回答满意度 ${feedbackTotals.satisfaction}%` : '')
  kbList.appendChild(summary)

  const list = document.createElement('div')
  list.className = 'kb-list'
  kbList.appendChild(list)

  for (const kb of allKbs) {
    const isOwner = kb.owner_id === user.id || isAdmin
    const fb = feedbackMap[kb.id]
    const row = document.createElement('div')
    row.className = 'kb-row'
    row.innerHTML = `
      <div class="kb-row-main">
        <div class="kb-row-name">
          <span>${escHtml(kb.name)}</span>
          ${kb.is_public ? '<span class="badge badge-public">公开</span>' : '<span class="badge badge-private">私有</span>'}
        </div>
        <div class="kb-row-desc">${kb.description ? escHtml(kb.description) : '还没有说明'}</div>
      </div>
      <div class="kb-row-stats">
        <span><strong>${kb.doc_count ?? 0}</strong> 份文档</span>
        <span>${kb.conv_count ? `<strong>${kb.conv_count}</strong> 次对话` : '暂无对话'}</span>
        ${fb && (fb.positive || fb.negative) ? `<span title="用户对回答的评价">${fb.positive} 个有帮助，${fb.negative} 个没帮助</span>` : ''}
      </div>
      <div class="kb-row-actions">
        <button class="btn btn-secondary btn-sm" data-action="open-chat" data-id="${kb.id}">进入问答</button>
        ${isOwner ? `
          <button class="btn btn-secondary btn-sm" data-action="members" data-id="${kb.id}">成员</button>
          <details class="row-menu">
            <summary aria-label="${escHtml(kb.name)} 的更多操作" title="更多操作">${ICONS.more}</summary>
            <div class="row-menu-pop" role="menu">
              <button type="button" role="menuitem" data-action="edit" data-id="${kb.id}">编辑名称和说明</button>
              <button type="button" role="menuitem" data-action="toggle-public" data-id="${kb.id}" data-public="${kb.is_public ? '1' : '0'}">${kb.is_public ? '设为私有' : '设为公开'}</button>
              <div class="row-menu-sep"></div>
              <button type="button" role="menuitem" class="danger" data-action="delete-kb" data-id="${kb.id}">删除知识库</button>
            </div>
          </details>` : ''}
      </div>
    `
    list.appendChild(row)
  }
}

function openKbChat(id) {
  localStorage.setItem('kb_last_selected_id', String(id))
  location.href = '/index.html'
}

function renderDocKbSelect() {
  docKbSelect.innerHTML = '<option value="">— 选择知识库 —</option>'
  for (const kb of allKbs) {
    const opt = document.createElement('option')
    opt.value = kb.id
    opt.textContent = kb.name
    docKbSelect.appendChild(opt)
  }
}

async function togglePublic(id, isPublic) {
  await fetch(`/api/kbs/${id}/public`, {
    method: 'PATCH',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_public: isPublic }),
  })
  showToast(isPublic ? '已设为公开' : '已设为私有', 'success')
  loadKbs()
}

async function deleteKb(id, name) {
  if (!confirm(`确认删除知识库「${name}」？\n此操作将同时删除所有文档，不可恢复！`)) return
  const res = await fetch(`/api/kbs/${id}`, { method: 'DELETE', headers: auth() })
  if (res.ok) { showToast('知识库已删除', 'success'); loadKbs() }
  else { showToast('删除失败', 'error') }
}

/* ── 新建/编辑知识库弹层 ────────────────────────────── */
function initKbModal() {
  const modal    = document.getElementById('kb-modal')
  const titleEl  = document.getElementById('kb-modal-title')
  const confirmBtn = document.getElementById('kb-modal-confirm')
  const editIdEl = document.getElementById('kb-edit-id')

  const close = () => { modal.classList.add('hidden'); editIdEl.value = '' }

  function openCreate() {
    titleEl.textContent = '新建知识库'
    confirmBtn.textContent = '创建'
    editIdEl.value = ''
    document.getElementById('kb-name').value = ''
    document.getElementById('kb-desc').value = ''
    document.getElementById('kb-system-prompt').value = ''
    document.getElementById('kb-system-prompt-group').style.display = 'none'
    modal.classList.remove('hidden')
    document.getElementById('kb-name').focus()
  }

  document.getElementById('create-kb-btn').addEventListener('click', openCreate)
  document.getElementById('kb-modal-close').addEventListener('click', close)
  document.getElementById('kb-modal-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  confirmBtn.addEventListener('click', async () => {
    const name = document.getElementById('kb-name').value.trim()
    const desc = document.getElementById('kb-desc').value.trim()
    if (!name) { alert('请输入知识库名称'); return }

    const editId = editIdEl.value
    const systemPrompt = document.getElementById('kb-system-prompt').value.trim()
    let res
    if (editId) {
      // 编辑模式
      res = await fetch(`/api/kbs/${editId}`, {
        method: 'PATCH',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc, system_prompt: systemPrompt || null }),
      })
    } else {
      // 创建模式
      res = await fetch('/api/kbs', {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc }),
      })
    }
    const data = await res.json()
    if (res.ok) {
      showToast(editId ? '知识库已更新' : '知识库创建成功', 'success')
      close()
      loadKbs()
    } else {
      showToast(data.error ?? (editId ? '更新失败' : '创建失败'), 'error')
    }
  })
}

function openKbEditModal(kb) {
  document.getElementById('kb-modal-title').textContent = '编辑知识库'
  document.getElementById('kb-modal-confirm').textContent = '保存'
  document.getElementById('kb-edit-id').value = kb.id
  document.getElementById('kb-name').value = kb.name
  document.getElementById('kb-desc').value = kb.description ?? ''
  document.getElementById('kb-system-prompt').value = kb.system_prompt ?? ''
  document.getElementById('kb-system-prompt-group').style.display = ''
  document.getElementById('kb-modal').classList.remove('hidden')
  document.getElementById('kb-name').focus()
}

/* ── 成员管理弹层 ──────────────────────────────────── */
let currentMembersKbId = null

function initMembersModal() {
  const modal  = document.getElementById('members-modal')
  const close  = () => modal.classList.add('hidden')

  document.getElementById('members-modal-close').addEventListener('click', close)
  document.getElementById('members-modal-close2').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('member-add-btn').addEventListener('click', async () => {
    const username = document.getElementById('member-username').value.trim()
    if (!username) return
    const res = await fetch(`/api/kbs/${currentMembersKbId}/members`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    })
    const data = await res.json()
    if (res.ok) {
      document.getElementById('member-username').value = ''
      showToast(`已添加 ${data.username}`, 'success')
      loadMembers(currentMembersKbId)
    } else {
      showToast(data.error ?? '添加失败', 'error')
    }
  })

  document.getElementById('member-username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('member-add-btn').click()
  })
}

async function openMembersModal(kb) {
  currentMembersKbId = kb.id
  document.getElementById('members-modal-title').textContent = `成员管理 — ${kb.name}`
  document.getElementById('member-username').value = ''
  document.getElementById('members-modal').classList.remove('hidden')
  await loadMembers(kb.id)
}

/** 管理员添加成员时提示可选的用户名（不含所有者和已有成员）；普通用户看不到用户列表 */
async function fillMemberSuggestions(kbId, members) {
  const datalist = document.getElementById('member-suggestions')
  datalist.innerHTML = ''
  if (!isAdmin) return
  try {
    const res = await fetch('/api/admin/users', { headers: auth() })
    if (!res.ok) return
    const users = await res.json()
    const ownerId = allKbs.find(k => k.id === kbId)?.owner_id
    const taken = new Set(members.map(m => m.id))
    datalist.innerHTML = users
      .filter(u => u.id !== ownerId && !taken.has(u.id))
      .map(u => `<option value="${escHtml(u.username)}">${u.role === 'admin' ? '管理员' : ''}</option>`)
      .join('')
  } catch { /* 提示不可用时仍可手动输入 */ }
}

async function loadMembers(kbId) {
  const list = document.getElementById('member-list')
  list.innerHTML = '<div style="color:var(--muted);font-size:13px">加载中…</div>'
  const res     = await fetch(`/api/kbs/${kbId}/members`, { headers: auth() })
  const members = await res.json()

  list.innerHTML = ''
  fillMemberSuggestions(kbId, members)
  if (!members.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px">暂无额外成员（仅限公开访问或创建者）</div>'
    return
  }
  for (const m of members) {
    const row = document.createElement('div')
    row.className = 'doc-item'
    row.innerHTML = `
      <span class="manage-nav-avatar" aria-hidden="true">${escHtml((m.username || '?').slice(0, 1).toUpperCase())}</span>
      <span style="flex:1;font-size:13.5px">${escHtml(m.username)}</span>
      <span class="badge badge-${m.role}" style="margin-right:6px">${m.role === 'admin' ? '管理员' : '用户'}</span>
      <button class="btn btn-danger btn-sm" data-uid="${m.id}">移除</button>
    `
    row.querySelector('[data-uid]').addEventListener('click', async () => {
      if (!confirm(`确认移除 ${m.username} 的访问权限？`)) return
      await fetch(`/api/kbs/${kbId}/members/${m.id}`, { method: 'DELETE', headers: auth() })
      showToast(`已移除 ${m.username}`, 'success')
      loadMembers(kbId)
    })
    list.appendChild(row)
  }
}

/** 知识库卡片上的按钮（事件委托）和「更多」菜单：点菜单以外的地方时收起菜单 */
function initRowMenus() {
  // 事件委托：知识库卡片每次刷新都会重新生成，所以不在每张卡片上绑事件，
  // 而是在外层容器上绑一次，按按钮的 data-action 分发

  kbList.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    btn.closest('details.row-menu')?.removeAttribute('open')
    const id = Number(btn.dataset.id)
    const kb = allKbs.find(k => k.id === id)
    if (!kb) return
    const action = btn.dataset.action
    if (action === 'open-chat')     openKbChat(id)
    if (action === 'edit')          openKbEditModal(kb)
    if (action === 'members')       openMembersModal(kb)
    if (action === 'toggle-public') togglePublic(id, !kb.is_public)
    if (action === 'delete-kb')     deleteKb(id, kb.name)
  })

  /* 点击菜单以外的地方时，收起打开着的「更多」菜单 */
  document.addEventListener('click', e => {
    document.querySelectorAll('details.row-menu[open]').forEach(d => { if (!d.contains(e.target)) d.removeAttribute('open') })
  })
}
