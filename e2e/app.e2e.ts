/**
 * 浏览器端到端测试：覆盖单元测试发现不了的前端问题
 *（例如回答完成后 👍/👎 被覆盖、管理页脚本初始化顺序错误导致整页失效）。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ADMIN_PASSWORD } from '../playwright.config'

/** 每个页面都收集脚本错误，测试结束时断言为空 */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  return errors
}

async function apiLogin(request: APIRequestContext, username: string, password: string) {
  const res = await request.post('/api/auth/login', { data: { username, password } })
  expect(res.ok()).toBeTruthy()
  return res.json() as Promise<{ token: string; user: { id: number; username: string; role: string } }>
}

/** 直接写入登录态，跳过表单（登录表单本身由单独的用例覆盖） */
async function signIn(page: Page, session: { token: string; user: unknown }) {
  await page.goto('/login.html')
  await page.evaluate(s => {
    localStorage.setItem('kb_token', s.token)
    localStorage.setItem('kb_user', JSON.stringify(s.user))
  }, session)
}

let adminToken = ''
let kbId = 0
const auth = () => ({ Authorization: `Bearer ${adminToken}` })

test.beforeAll(async ({ request }) => {
  adminToken = (await apiLogin(request, 'admin', ADMIN_PASSWORD)).token
  const kb = await request.post('/api/kbs', { headers: auth(), data: { name: '人事制度' } })
  kbId = (await kb.json()).id
  await request.post(`/api/kbs/${kbId}/docs/text`, { headers: auth(), data: { title: '请假制度', content: '年假为每年 10 天。' } })
})

test('logs in through the form and lands on the workspace', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('/login.html')
  await page.fill('#username', 'admin')
  await page.fill('#password', ADMIN_PASSWORD)
  await page.click('#login-btn')
  await expect(page).toHaveURL(/\/(index\.html)?$/)
  await expect(page.locator('.kb-item', { hasText: '人事制度' })).toBeVisible()
  expect(errors).toEqual([])
})

test('answers a question and records a thumbs-down reason', async ({ page, request }) => {
  const errors = trackErrors(page)
  await signIn(page, await apiLogin(request, 'admin', ADMIN_PASSWORD))
  await page.goto('/')
  await page.fill('#question-input', '年假有几天？')
  await page.keyboard.press('Enter')

  const answer = page.locator('.msg-assistant').last()
  await expect(answer).toContainText('年假为每年 10 天')
  // 回答完成后 👍/👎 与复制按钮都必须可见（曾被"N 轮检索"文字覆盖掉）
  const thumbs = answer.locator('.msg-feedback-btn:not(.hidden)')
  await expect(thumbs).toHaveCount(2)
  await expect(answer.locator('.msg-copy-btn:not(.hidden)')).toBeVisible()

  await thumbs.nth(1).click()
  const panel = answer.locator('.feedback-reason-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-action=submit]')).toBeDisabled()
  await panel.locator('.feedback-reason-chip[data-reason=outdated]').click()
  await panel.locator('.feedback-reason-comment').fill('已改为 15 天')
  await panel.locator('[data-action=submit]').click()
  await expect(answer.locator('.feedback-reason-thanks')).toBeVisible()

  const negative = await (await request.get('/api/admin/feedback/negative', { headers: auth() })).json()
  expect(negative.items[0]).toMatchObject({ reason: 'outdated', comment: '已改为 15 天', question: '年假有几天？' })
  expect(errors).toEqual([])
})

test('admin feedback tab shows stats, reasons and knowledge gaps', async ({ page, request }) => {
  const errors = trackErrors(page)
  const session = await apiLogin(request, 'admin', ADMIN_PASSWORD)
  await signIn(page, session)

  // 产生一条"未找到相关内容"的回答
  await page.goto('/')
  await page.fill('#question-input', '出差补贴标准是多少？')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg-assistant').last()).toContainText('未找到相关内容')

  await page.goto('/manage.html')
  await page.click('[data-tab=feedback]')
  await expect(page.locator('#feedback-stats')).toContainText('回答满意度')
  await expect(page.locator('#feedback-reason-bars')).toContainText('信息过时')
  await expect(page.locator('.feedback-item').first()).toContainText('已改为 15 天')
  await expect(page.locator('#gap-list')).toContainText('出差补贴标准是多少')
  expect(errors).toEqual([])
})

test('shows text document history with a diff and restores an old version', async ({ page, request }) => {
  const errors = trackErrors(page)
  const kb = await (await request.post('/api/kbs', { headers: auth(), data: { name: '版本测试' } })).json()
  const doc = await (await request.post(`/api/kbs/${kb.id}/docs/text`, { headers: auth(), data: { title: '报销制度', content: '第一条 报销需在 30 天内提交。\n第二条 需附发票。' } })).json()
  await request.patch(`/api/kbs/${kb.id}/docs/${doc.id}/text`, { headers: auth(), data: { title: '报销制度', content: '第一条 报销需在 15 天内提交。\n第二条 需附发票。\n第三条 超期不予受理。' } })

  await signIn(page, await apiLogin(request, 'admin', ADMIN_PASSWORD))
  await page.goto('/manage.html')
  await page.click('[data-tab=docs]')
  await page.selectOption('#doc-kb-select', String(kb.id))
  await page.click(`[data-history-id="${doc.id}"]`)

  const modal = page.locator('#history-modal')
  await expect(modal.locator('.history-item')).toHaveCount(2)
  await expect(modal.locator('.history-item').first()).toContainText('当前')
  await expect(modal.locator('.diff-add')).toContainText(['第一条 报销需在 15 天内提交。', '第三条 超期不予受理。'])
  await expect(modal.locator('.diff-del')).toContainText('第一条 报销需在 30 天内提交。')
  await expect(modal.locator('#history-restore-btn')).toBeHidden()

  await modal.locator('.history-item').nth(1).click()
  page.once('dialog', dialog => dialog.accept())
  await modal.locator('#history-restore-btn').click()
  await expect(page.locator('#toast')).toContainText('已恢复到版本 1')
  await expect(modal.locator('.history-item')).toHaveCount(3)
  await expect(modal.locator('.history-item').first()).toContainText('恢复自版本 1')

  const preview = await (await request.get(`/api/kbs/${kb.id}/docs/${doc.id}/preview`, { headers: auth() })).json()
  expect(preview.content).toBe('第一条 报销需在 30 天内提交。\n第二条 需附发票。')
  expect(errors).toEqual([])
})

test('public knowledge base is read-only for non-members', async ({ page, request }) => {
  const errors = trackErrors(page)
  await request.patch(`/api/kbs/${kbId}/public`, { headers: auth(), data: { is_public: true } })
  await request.post('/api/admin/users', { headers: auth(), data: { username: 'viewer', password: 'Viewer@12345', role: 'user' } })
  await signIn(page, await apiLogin(request, 'viewer', 'Viewer@12345'))

  await page.goto('/manage.html')
  await page.click('[data-tab=docs]')
  await page.selectOption('#doc-kb-select', String(kbId))
  await expect(page.locator('#doc-readonly-notice')).toBeVisible()
  await expect(page.locator('#upload-zone')).toBeHidden()
  await expect(page.locator('#new-text-doc-btn')).toBeHidden()
  await expect(page.locator('[data-preview-id]').first()).toBeVisible()
  await expect(page.locator('[data-doc-id]')).toHaveCount(0)
  await expect(page.locator('[data-edit-id]')).toHaveCount(0)
  // 只读用户可以查看历史版本，但不能恢复
  await page.locator('[data-history-id]').first().click()
  await expect(page.locator('#history-modal .history-item').first()).toBeVisible()
  await expect(page.locator('#history-restore-btn')).toBeHidden()
  expect(errors).toEqual([])
})

test('admin can back up from the settings tab', async ({ page, request }) => {
  const errors = trackErrors(page)
  await signIn(page, await apiLogin(request, 'admin', ADMIN_PASSWORD))
  await page.goto('/manage.html')
  await page.click('[data-tab=settings]')

  const card = page.locator('#backup-card')
  await expect(card.locator('#backup-schedule')).toContainText('自动备份未开启')
  await card.locator('#backup-now-btn').click()
  await expect(card.locator('#backup-last')).toContainText('上次手动备份成功')
  await expect(card.locator('.backup-row').first()).toContainText(/\d+ 个知识库 · \d+ 份文档/)
  await expect(card.locator('#backup-now-btn')).toBeEnabled()

  const status = await (await request.get('/api/admin/backups', { headers: auth() })).json()
  expect(status.backups.length).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('admin console fits a phone screen', async ({ page, request }) => {
  const errors = trackErrors(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, await apiLogin(request, 'admin', ADMIN_PASSWORD))
  for (const tab of ['kbs', 'docs', 'feedback', 'settings']) {
    await page.goto('/manage.html')
    await page.click(`[data-tab=${tab}]`)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `horizontal overflow on ${tab} tab`).toBeLessThanOrEqual(0)
  }
  expect(errors).toEqual([])
})
