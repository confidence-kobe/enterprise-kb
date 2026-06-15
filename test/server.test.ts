import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Express } from 'express'

let app: Express
let testRoot: string

beforeAll(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-kb-test-'))

  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET = 'test-secret-change-me-at-least-32-chars'
  process.env.JWT_EXPIRES_IN = '1h'
  process.env.ADMIN_USERNAME = 'admin'
  process.env.ADMIN_PASSWORD = 'Admin@123'
  process.env.DB_PATH = path.join(testRoot, 'data', 'enterprise-kb-test.db')
  process.env.STORAGE_PATH = path.join(testRoot, 'storage')
  process.env.LLM_BASE_URL = 'https://example.test/v1'
  process.env.LLM_API_KEY = 'test'
  process.env.LLM_MODEL = 'test-model'
  process.env.PORT = '18080'

  const serverModule = await import('../src/server.ts')
  app = serverModule.app
})

afterAll(async () => {
  const { closeDb } = await import('../src/db.ts')
  closeDb()
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('server health and auth', () => {
  it('serves liveness and readiness endpoints', async () => {
    await request(app)
      .get('/healthz')
      .expect(200)
      .expect(res => {
        expect(res.body.status).toBe('ok')
        expect(typeof res.body.uptime).toBe('number')
      })

    await request(app)
      .get('/readyz')
      .expect(200)
      .expect(res => {
        expect(res.body.status).toBe('ok')
        expect(res.body.llmOnline).toBe(true)
        expect(res.body.model).toBe('test-model')
      })
  })

  it('protects /api/me and returns the authenticated user after login', async () => {
    await request(app).get('/api/me').expect(401)

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'Admin@123' })
      .expect(200)

    expect(login.body.token).toEqual(expect.any(String))
    expect(login.body.user).toMatchObject({ username: 'admin', role: 'admin' })

    await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200)
      .expect(res => {
        expect(res.body).toMatchObject({ username: 'admin', role: 'admin' })
      })
  })

  it('rejects invalid login credentials', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong-password' })
      .expect(401)
  })
})

describe('knowledge-base isolation', () => {
  it('prevents cross-KB writes, member batch deletion, and conversation search leaks', async () => {
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'Admin@123' })
      .expect(200)
    const adminAuth = { Authorization: `Bearer ${adminLogin.body.token}` }

    const createdUser = await request(app)
      .post('/api/admin/users')
      .set(adminAuth)
      .send({ username: 'isolation-user', password: 'User@123', role: 'user' })
      .expect(201)

    const userLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'isolation-user', password: 'User@123' })
      .expect(200)
    const userAuth = { Authorization: `Bearer ${userLogin.body.token}` }

    const kbA = await request(app)
      .post('/api/kbs')
      .set(adminAuth)
      .send({ name: 'Isolation A' })
      .expect(201)
    const kbB = await request(app)
      .post('/api/kbs')
      .set(adminAuth)
      .send({ name: 'Isolation B' })
      .expect(201)

    for (const kb of [kbA.body, kbB.body]) {
      await request(app)
        .post(`/api/kbs/${kb.id}/members`)
        .set(adminAuth)
        .send({ username: 'isolation-user' })
        .expect(201)
    }

    const docA = await request(app)
      .post(`/api/kbs/${kbA.body.id}/docs/text`)
      .set(adminAuth)
      .send({ title: '项目排错SOP', content: 'private alpha content；中文项目检索用于验证中文子串搜索。' })
      .expect(201)
    const docB = await request(app)
      .post(`/api/kbs/${kbB.body.id}/docs/text`)
      .set(adminAuth)
      .send({ title: 'Isolation B doc', content: 'private beta content for isolation test' })
      .expect(201)
    await request(app)
      .post(`/api/kbs/${kbA.body.id}/docs/text`)
      .set(adminAuth)
      .send({ title: '通用项目说明', content: '这里只描述项目背景，不包含具体排错步骤。' })
      .expect(201)

    await request(app)
      .delete(`/api/kbs/${kbA.body.id}/docs/batch`)
      .set(userAuth)
      .send({ ids: [docA.body.id] })
      .expect(403)

    const chineseSearch = await request(app)
      .get(`/api/kbs/${kbA.body.id}/search/docs?q=${encodeURIComponent('中文子串')}`)
      .set(adminAuth)
      .expect(200)
    expect(chineseSearch.body.length).toBeGreaterThan(0)

    const rankedSearch = await request(app)
      .get(`/api/kbs/${kbA.body.id}/search/docs?q=${encodeURIComponent('项目 排错')}`)
      .set(adminAuth)
      .expect(200)
    expect(rankedSearch.body[0].original_name).toContain('项目排错SOP')
    expect(rankedSearch.body[0].snippet).toContain('>>>')

    await request(app)
      .delete(`/api/kbs/${kbA.body.id}/docs/${docB.body.id}`)
      .set(adminAuth)
      .expect(404)

    const docsB = await request(app)
      .get(`/api/kbs/${kbB.body.id}/docs`)
      .set(adminAuth)
      .expect(200)
    expect(docsB.body.some((doc: { id: number }) => doc.id === docB.body.id)).toBe(true)

    const userConv = await request(app)
      .post(`/api/kbs/${kbB.body.id}/conversations`)
      .set(userAuth)
      .expect(201)

    await request(app)
      .post(`/api/kbs/${kbA.body.id}/ask`)
      .set(userAuth)
      .send({ question: 'This must not run', history: [], conversationId: userConv.body.id })
      .expect(400)

    const { createConversation, insertMessages } = await import('../src/db.ts')
    const privateMarker = `admin-private-${Date.now()}`
    const adminConv = createConversation(adminLogin.body.user.id, kbA.body.id, 'Admin private conversation')
    insertMessages(adminConv.id, [{
      role: 'user',
      content: privateMarker,
      tool_calls: null,
      tool_call_id: null,
      seq: 0,
    }])

    const search = await request(app)
      .get(`/api/search/conversations?q=${privateMarker}`)
      .set(userAuth)
      .expect(200)
    expect(search.body.total).toBe(0)

    await request(app).delete(`/api/kbs/${kbA.body.id}`).set(adminAuth).expect(200)
    await request(app).delete(`/api/kbs/${kbB.body.id}`).set(adminAuth).expect(200)
    await request(app).delete(`/api/admin/users/${createdUser.body.id}`).set(adminAuth).expect(200)
  })
})

describe('audit log', () => {
  it('records administrative actions and restricts audit reads to admins', async () => {
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'Admin@123' })
      .expect(200)
    const adminAuth = { Authorization: `Bearer ${adminLogin.body.token}` }

    const createdUser = await request(app)
      .post('/api/admin/users')
      .set(adminAuth)
      .send({ username: 'audit-user', password: 'User@123', role: 'user' })
      .expect(201)

    const userLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'audit-user', password: 'User@123' })
      .expect(200)
    const userAuth = { Authorization: `Bearer ${userLogin.body.token}` }

    await request(app)
      .get('/api/admin/audit')
      .set(userAuth)
      .expect(403)

    const kb = await request(app)
      .post('/api/kbs')
      .set(adminAuth)
      .send({ name: 'Audit KB' })
      .expect(201)

    const audit = await request(app)
      .get('/api/admin/audit?action=kb.create')
      .set(adminAuth)
      .expect(200)

    expect(audit.body.total).toBeGreaterThan(0)
    expect(audit.body.items.some((item: { action: string; kb_id: number; username: string }) =>
      item.action === 'kb.create' && item.kb_id === kb.body.id && item.username === 'admin',
    )).toBe(true)

    await request(app).delete(`/api/kbs/${kb.body.id}`).set(adminAuth).expect(200)
    await request(app).delete(`/api/admin/users/${createdUser.body.id}`).set(adminAuth).expect(200)
  })
})
