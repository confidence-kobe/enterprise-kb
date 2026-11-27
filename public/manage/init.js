/**
 * 管理控制台 · 页面启动：显示登录用户、管理员专属标签、绑定各功能的事件、首次加载数据。
 * 最后一个加载，这时所有文件里的函数和常量都已就绪（见 core.js 开头的加载规则）。
 * 这里语句的先后顺序保持不变：事件监听的注册顺序和数据加载的发起顺序不要随意调换。
 */

/* ── 初始化 ───────────────────────────────────────── */
document.getElementById('user-badge').textContent = isAdmin ? '管理员' : '用户'

document.getElementById('user-badge').className   = `badge badge-${user.role}`

document.getElementById('user-name').textContent  = user.username

document.getElementById('user-avatar').textContent = (user.username || '?').slice(0, 1).toUpperCase()

if (isAdmin) {
  // 管理员的首页是「待处理」：查不到、不满意、没能入库的情况
  document.getElementById('inbox-tab').style.display = ''
  document.querySelector('.tab-btn[data-tab="kbs"]').classList.remove('active')
  document.getElementById('tab-kbs').classList.remove('active')
  document.getElementById('inbox-tab').classList.add('active')
  document.getElementById('tab-inbox').classList.add('active')
  document.getElementById('users-tab').style.display = ''
  document.getElementById('audit-tab').style.display = ''
  document.getElementById('feedback-tab').style.display = ''
  document.getElementById('settings-tab').style.display = ''
  loadUsers()
  initModelSettings()
  initBackupSettings()
  initAuditLog()
  initFeedbackTab()
}

loadKbs()

initTabs()

initGapsTab()

initApiAccess()

initVersionHistory()

initKbModal()

initUserModal()

initUpload()

initLogout()

initMembersModal()

initPwdModal()

initPreviewModal()

initDocBulk()

initReindex()

initTextDocModal()

initSyncSource()

if (isAdmin) initResetPwdModal()

initRowMenus()
initEscapeKey()
initDocSearch()
