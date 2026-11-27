/**
 * 管理控制台 · API 接入：创建和撤销接口密钥、MCP 配置示例（所有人可见）。
 */

/* ── API 接入 ─────────────────────────────────────── */
const apiAccess = { newKey: null, snippet: 'claude-code' }

const API_KEY_PLACEHOLDER = '<你的 API 密钥>'

function mcpUrl() { return `${location.origin}/mcp` }

const MCP_SNIPPETS = {
  'claude-code': {
    hint: '在终端运行这条命令，之后在 Claude Code 里直接提问即可。',
    render: key => `claude mcp add --transport http enterprise-kb ${mcpUrl()} \\\n  --header "Authorization: Bearer ${key}"`,
  },
  json: {
    hint: 'Cursor 写入 ~/.cursor/mcp.json；其他客户端按各自的说明填写服务地址和请求头。',
    render: key => JSON.stringify({
      mcpServers: { 'enterprise-kb': { type: 'http', url: mcpUrl(), headers: { Authorization: `Bearer ${key}` } } },
    }, null, 2),
  },
  curl: {
    hint: '返回知识库列表就说明接入成功。',
    render: key => [
      `curl -s ${mcpUrl()} \\`,
      `  -H "Authorization: Bearer ${key}" \\`,
      '  -H "Content-Type: application/json" \\',
      '  -H "Accept: application/json, text/event-stream" \\',
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_knowledge_bases","arguments":{}}}'`,
    ].join('\n'),
  },
}

function renderMcpSnippet() {
  const snippet = MCP_SNIPPETS[apiAccess.snippet]
  document.getElementById('mcp-snippet').textContent = snippet.render(apiAccess.newKey ?? API_KEY_PLACEHOLDER)
  document.getElementById('mcp-snippet-hint').textContent = apiAccess.newKey
    ? `${snippet.hint}（已填入刚创建的密钥）`
    : `${snippet.hint}把 ${API_KEY_PLACEHOLDER} 换成你的密钥。`
  document.querySelectorAll('.api-snippet-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.snippet === apiAccess.snippet)
  })
}

function apiKeyRow(k, scope) {
  const expired = k.expires_at != null && k.expires_at * 1000 <= Date.now()
  return `
    <div class="gap-row api-key-row">
      <div class="gap-main">
        <div class="gap-question">${escHtml(k.name)} <span class="gap-tag">${escHtml(k.prefix)}…</span>${expired ? ' <span class="gap-tag gap-tag-user">已过期</span>' : ''}</div>
        <div class="gap-meta">
          ${scope === 'admin' ? `<span>${escHtml(k.username)}</span>` : ''}
          <span>创建于 ${fmtTime(k.created_at)}</span>
          <span>${k.last_used_at ? `最近使用 ${fmtDateTime(k.last_used_at)}` : '从未使用'}</span>
          <span>${k.expires_at ? `${expired ? '已于' : '有效期至'} ${fmtTime(k.expires_at)}${expired ? ' 过期' : ''}` : '永久有效'}</span>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" type="button" data-revoke-key="${k.id}" data-scope="${scope}" data-name="${escHtml(k.name)}">撤销</button>
    </div>`
}

async function loadApiKeys() {
  const listEl = document.getElementById('api-key-list')
  renderMcpSnippet()
  try {
    const res  = await fetch('/api/me/api-keys', { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    listEl.innerHTML = data.items.length
      ? data.items.map(k => apiKeyRow(k, 'me')).join('')
      : '<div class="feedback-empty">还没有密钥。创建一个，就能把知识库接入 AI 助手。</div>'
  } catch (e) {
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
  if (isAdmin) loadAdminApiKeys()
}

async function loadAdminApiKeys() {
  const card   = document.getElementById('admin-api-key-card')
  const listEl = document.getElementById('admin-api-key-list')
  card.classList.remove('hidden')
  try {
    const res  = await fetch('/api/admin/api-keys', { headers: auth() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    listEl.innerHTML = data.items.length
      ? data.items.map(k => apiKeyRow(k, 'admin')).join('')
      : '<div class="feedback-empty">还没有人创建密钥。</div>'
  } catch (e) {
    listEl.innerHTML = `<div class="feedback-empty" style="color:var(--red)">加载失败：${escHtml(e.message)}</div>`
  }
}

function initApiAccess() {
  const panel = document.getElementById('tab-api')
  const form  = document.getElementById('api-key-form')
  document.getElementById('mcp-url').textContent = mcpUrl()

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const nameInput = document.getElementById('api-key-name')
    const name = nameInput.value.trim()
    if (!name) { showToast('请填写密钥用途，方便以后辨认', 'error'); nameInput.focus(); return }
    const expiry = document.getElementById('api-key-expiry').value
    const btn = document.getElementById('api-key-create-btn')
    btn.disabled = true
    try {
      const res  = await fetch('/api/me/api-keys', {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, expiresInDays: expiry ? Number(expiry) : null }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error ?? '创建失败', 'error'); return }
      apiAccess.newKey = data.key
      document.getElementById('api-key-new-value').textContent = data.key
      document.getElementById('api-key-new').classList.remove('hidden')
      nameInput.value = ''
      renderMcpSnippet()
      loadApiKeys()
    } catch {
      showToast('创建失败，请检查网络', 'error')
    } finally {
      btn.disabled = false
    }
  })

  panel.addEventListener('click', async e => {
    const copyBtn = e.target.closest('[data-copy-target]')
    if (copyBtn) {
      try {
        await copyText(document.getElementById(copyBtn.dataset.copyTarget).textContent)
        showToast('已复制', 'success')
      } catch {
        showToast('复制失败，请手动选择文字复制', 'error')
      }
      return
    }

    const tab = e.target.closest('[data-snippet]')
    if (tab) { apiAccess.snippet = tab.dataset.snippet; renderMcpSnippet(); return }

    const revokeBtn = e.target.closest('[data-revoke-key]')
    if (revokeBtn) {
      if (!confirm(`撤销密钥「${revokeBtn.dataset.name}」？使用它的工具会立即失去访问权限。`)) return
      const url = revokeBtn.dataset.scope === 'admin'
        ? `/api/admin/api-keys/${revokeBtn.dataset.revokeKey}`
        : `/api/me/api-keys/${revokeBtn.dataset.revokeKey}`
      revokeBtn.disabled = true
      try {
        const res = await fetch(url, { method: 'DELETE', headers: auth() })
        const data = await res.json()
        if (!res.ok) { showToast(data.error ?? '撤销失败', 'error'); revokeBtn.disabled = false; return }
        showToast('密钥已撤销', 'success')
        loadApiKeys()
      } catch {
        showToast('撤销失败，请检查网络', 'error')
        revokeBtn.disabled = false
      }
    }
  })
}
