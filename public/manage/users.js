/**
 * 管理控制台 · 账号：用户管理（管理员）、重置他人密码（管理员）、修改自己的密码。
 */

/* ── 用户管理 ──────────────────────────────────────── */
async function loadUsers() {
  const res   = await fetch('/api/admin/users', { headers: auth() })
  const users = await res.json()

  userList.innerHTML = ''
  for (const u of users) {
    const tr = document.createElement('tr')
    const isSelf = u.id === user.id
    tr.innerHTML = `
      <td><strong>${escHtml(u.username)}</strong></td>
      <td>
        <select class="input input-sm role-select" data-uid="${u.id}" ${isSelf ? 'disabled' : ''}>
          <option value="user"  ${u.role === 'user'  ? 'selected' : ''}>普通用户</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select>
      </td>
      <td style="color:var(--muted)" title="${u.last_active_at ? escHtml(fmtDateTime(u.last_active_at)) : ''}">${u.last_active_at ? fmtRelativeTime(u.last_active_at) : '从未使用'}</td>
      <td class="user-num">${u.questions_30d ?? 0}</td>
      <td style="color:var(--muted)">${fmtTime(u.created_at)}</td>
      <td>
        <div class="user-actions">
          ${isSelf
            ? '<span style="color:var(--muted);font-size:12px">当前用户</span>'
            : `<button class="btn btn-secondary btn-sm" data-action="reset-pwd" data-uid="${u.id}">重置密码</button>
               <button class="btn btn-danger btn-sm" data-action="del-user" data-uid="${u.id}">删除</button>`
          }
        </div>
      </td>
    `
    if (!isSelf) {
      tr.querySelector('[data-action="reset-pwd"]').addEventListener('click',
        () => openResetPwdModal(u.id, u.username))
      tr.querySelector('[data-action="del-user"]').addEventListener('click',
        () => deleteUser(u.id, u.username))
      tr.querySelector('.role-select').addEventListener('change', async e => {
        const role = e.target.value
        const res = await fetch(`/api/admin/users/${u.id}/role`, {
          method: 'PATCH',
          headers: { ...auth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        })
        if (!res.ok) { showToast('修改角色失败', 'error'); loadUsers() }
        else showToast('角色已更新', 'success')
      })
    }
    userList.appendChild(tr)
  }
}

async function deleteUser(id, name) {
  if (!confirm(`确认删除用户「${name}」？\n他将无法登录，API 密钥同时作废；他创建的知识库会转到你名下，文档和对话都保留。`)) return
  const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: auth() })
  const data = await res.json().catch(() => ({}))
  if (res.ok) {
    showToast(data.transferredKbs ? `用户已删除，${data.transferredKbs} 个知识库已转到你名下` : '用户已删除', 'success')
    loadUsers()
    if (data.transferredKbs) loadKbs()
  } else {
    showToast(data.error ?? '删除失败', 'error')
  }
}

function initUserModal() {
  const modal = document.getElementById('user-modal')
  const open  = () => { ['new-username','new-password'].forEach(id => document.getElementById(id).value = ''); modal.classList.remove('hidden') }
  const close = () => modal.classList.add('hidden')

  document.getElementById('create-user-btn').addEventListener('click', open)
  document.getElementById('user-modal-close').addEventListener('click', close)
  document.getElementById('user-modal-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('user-modal-confirm').addEventListener('click', async () => {
    const username = document.getElementById('new-username').value.trim()
    const password = document.getElementById('new-password').value
    const role     = document.getElementById('new-role').value

    if (!username || !password) { alert('请填写用户名和密码'); return }

    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    })
    const data = await res.json()
    if (res.ok) { showToast('用户创建成功', 'success'); close(); loadUsers() }
    else { showToast(data.error ?? '创建失败', 'error') }
  })
}

/* ── 管理员重置用户密码 ────────────────────────────── */
function initResetPwdModal() {
  const modal = document.getElementById('reset-pwd-modal')
  const close = () => {
    ['reset-pwd-new','reset-pwd-confirm'].forEach(id => { document.getElementById(id).value = '' })
    modal.classList.add('hidden')
  }

  document.getElementById('reset-pwd-close').addEventListener('click', close)
  document.getElementById('reset-pwd-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('reset-pwd-confirm-btn').addEventListener('click', async () => {
    const uid     = document.getElementById('reset-pwd-uid').value
    const newPwd  = document.getElementById('reset-pwd-new').value
    const confirm = document.getElementById('reset-pwd-confirm').value

    if (!newPwd || !confirm) { alert('请填写新密码'); return }
    if (newPwd !== confirm)  { alert('两次输入不一致'); return }
    if (newPwd.length < 6)   { alert('密码至少 6 位'); return }

    const res = await fetch(`/api/admin/users/${uid}/reset-password`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: newPwd }),
    })
    const data = await res.json()
    if (res.ok) { showToast('密码已重置', 'success'); close() }
    else        { showToast(data.error ?? '重置失败', 'error') }
  })
}

function openResetPwdModal(uid, username) {
  document.getElementById('reset-pwd-uid').value = uid
  document.getElementById('reset-pwd-username').textContent = username
  document.getElementById('reset-pwd-new').value = ''
  document.getElementById('reset-pwd-confirm').value = ''
  document.getElementById('reset-pwd-modal').classList.remove('hidden')
  document.getElementById('reset-pwd-new').focus()
}

/* ── 修改密码弹层 ───────────────────────────────────── */
function initPwdModal() {
  const modal  = document.getElementById('pwd-modal')
  const close  = () => {
    ['pwd-current','pwd-new','pwd-confirm'].forEach(id => { document.getElementById(id).value = '' })
    modal.classList.add('hidden')
  }

  document.getElementById('change-pwd-btn').addEventListener('click', () => modal.classList.remove('hidden'))
  document.getElementById('pwd-modal-close').addEventListener('click', close)
  document.getElementById('pwd-modal-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  document.getElementById('pwd-modal-confirm').addEventListener('click', async () => {
    const current = document.getElementById('pwd-current').value
    const next    = document.getElementById('pwd-new').value
    const confirm = document.getElementById('pwd-confirm').value

    if (!current || !next || !confirm) { alert('请填写全部字段'); return }
    if (next !== confirm) { alert('两次输入的新密码不一致'); return }
    if (next.length < 6)  { alert('新密码至少 6 位'); return }

    const res = await fetch('/api/me/password', {
      method: 'PATCH',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    })
    const data = await res.json()
    if (res.ok) {
      // 改密后旧 Token 失效，换用服务器签发的新 Token（其他设备需重新登录）
      if (data.token) { token = data.token; localStorage.setItem('kb_token', data.token) }
      showToast('密码修改成功，其他设备需重新登录', 'success'); close()
    }
    else        { showToast(data.error ?? '修改失败', 'error') }
  })
}
