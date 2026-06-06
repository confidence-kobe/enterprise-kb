import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Express } from 'express'
import {
  createConversation,
  getUserByUsername,
  insertMessages,
} from '../src/db.ts'

let app: Express
let testRoot: string

async function login(username: string, password: string) {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ username, password })
    .expect(200)

  return response.body as { token: string; user: { id: number; username: string; role: string } }
}

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

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'Admin@123' })
      .expect(200)

    expect(loginResponse.body.token).toEqual(expect.any(String))
    expect(loginResponse.body.user).toMatchObject({ username: 'admin', role: 'admin' })

    await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${loginResponse.body.token}`)
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

describe('knowledge base access control', () => {
  it('lets the owner create a kb and grants access through public visibility and memberships', async () => {
    const admin = await login('admin', 'Admin@123')

    const alicePassword = 'Alice@123'
    const createUser = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ username: 'alice', password: alicePassword, role: 'user' })
      .expect(201)

    expect(createUser.body).toMatchObject({ username: 'alice', role: 'user' })

    const kb = await request(app)
      .post('/api/kbs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Project Atlas', description: 'KB for access control tests' })
      .expect(201)

    const kbId = kb.body.id as number
    expect(kb.body).toMatchObject({ name: 'Project Atlas', description: 'KB for access control tests' })

    const alice = await login('alice', alicePassword)

    await request(app)
      .get('/api/kbs')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200)
      .expect(res => {
        expect(Array.isArray(res.body)).toBe(true)
        expect(res.body.some((item: { id: number }) => item.id === kbId)).toBe(false)
      })

    await request(app)
      .get(`/api/kbs/${kbId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(403)

    await request(app)
      .patch(`/api/kbs/${kbId}/public`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ is_public: true })
      .expect(200)

    await request(app)
      .get('/api/kbs')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200)
      .expect(res => {
        expect(res.body.some((item: { id: number; is_public?: number }) => item.id === kbId)).toBe(true)
      })

    await request(app)
      .get(`/api/kbs/${kbId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200)
      .expect(res => {
        expect(res.body).toMatchObject({ id: kbId, name: 'Project Atlas' })
      })

    await request(app)
      .patch(`/api/kbs/${kbId}/public`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ is_public: false })
      .expect(200)

    await request(app)
      .post(`/api/kbs/${kbId}/members`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ username: 'alice' })
      .expect(201)

    await request(app)
      .get(`/api/kbs/${kbId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200)

    await request(app)
      .get('/api/kbs')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200)
      .expect(res => {
        expect(res.body.some((item: { id: number }) => item.id === kbId)).toBe(true)
      })

    await request(app)
      .get(`/api/kbs/${kbId}/members`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)
      .expect(res => {
        expect(res.body.some((member: { username: string }) => member.username === 'alice')).toBe(true)
      })
  })

  it('indexes text docs and returns previews and search hits', async () => {
    const admin = await login('admin', 'Admin@123')

    const kb = await request(app)
      .post('/api/kbs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Search Atlas', description: 'KB for document flow tests' })
      .expect(201)

    const kbId = kb.body.id as number
    const content = [
      '# Incident Runbook',
      '',
      'Database migration steps:',
      '1. Take a snapshot.',
      '2. Run the migration.',
      '3. Verify indexes.',
    ].join('\n')

    const doc = await request(app)
      .post(`/api/kbs/${kbId}/docs/text`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ title: 'Incident Runbook', content })
      .expect(201)

    const docId = doc.body.id as number
    expect(doc.body).toMatchObject({ kb_id: kbId, original_name: 'Incident Runbook.md' })

    await request(app)
      .get(`/api/kbs/${kbId}/docs/${docId}/preview`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)
      .expect(res => {
        expect(res.body).toMatchObject({
          filename: 'Incident Runbook.md',
          ext: '.md',
          displayExt: '.md',
          truncated: false,
        })
        expect(res.body.content).toContain('Database migration steps')
      })

    await request(app)
      .get(`/api/kbs/${kbId}/search/docs`)
      .set('Authorization', `Bearer ${admin.token}`)
      .query({ q: 'migration steps', limit: 5 })
      .expect(200)
      .expect(res => {
        expect(Array.isArray(res.body)).toBe(true)
        expect(res.body.length).toBeGreaterThan(0)
        expect(res.body[0]).toMatchObject({
          original_name: 'Incident Runbook.md',
          chunk_line: expect.any(Number),
        })
        expect((res.body[0] as { snippet: string }).snippet).toContain('migration')
      })
  })
  it('removes docs from storage and search indexes when deleted', async () => {
    const admin = await login('admin', 'Admin@123')

    const kb = await request(app)
      .post('/api/kbs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Delete Atlas', description: 'KB for delete tests' })
      .expect(201)

    const kbId = kb.body.id as number
    const doc = await request(app)
      .post(`/api/kbs/${kbId}/docs/text`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ title: 'Temp Note', content: 'Delete me from the index and storage.' })
      .expect(201)

    const docId = doc.body.id as number

    await request(app)
      .delete(`/api/kbs/${kbId}/docs/${docId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)

    await request(app)
      .get(`/api/kbs/${kbId}/search/docs`)
      .set('Authorization', `Bearer ${admin.token}`)
      .query({ q: 'Delete me from the index', limit: 5 })
      .expect(200)
      .expect(res => {
        expect(res.body).toEqual([])
      })
  })

  it('batch deletes docs and clears search hits for removed docs', async () => {
    const admin = await login('admin', 'Admin@123')

    const kb = await request(app)
      .post('/api/kbs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Batch Delete Atlas', description: 'KB for batch delete tests' })
      .expect(201)

    const kbId = kb.body.id as number
    const firstDoc = await request(app)
      .post(`/api/kbs/${kbId}/docs/text`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ title: 'Batch One', content: 'Alpha batch document with a unique search phrase.' })
      .expect(201)

    const secondDoc = await request(app)
      .post(`/api/kbs/${kbId}/docs/text`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ title: 'Batch Two', content: 'Beta batch document with another unique phrase.' })
      .expect(201)

    await request(app)
      .delete(`/api/kbs/${kbId}/docs/batch`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ ids: [firstDoc.body.id, secondDoc.body.id] })
      .expect(200)
      .expect(res => {
        expect(res.body).toEqual({ deleted: 2 })
      })

    await request(app)
      .get(`/api/kbs/${kbId}/docs`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)
      .expect(res => {
        expect(res.body).toEqual([])
      })

    await request(app)
      .get(`/api/kbs/${kbId}/search/docs`)
      .set('Authorization', `Bearer ${admin.token}`)
      .query({ q: 'unique search phrase', limit: 5 })
      .expect(200)
      .expect(res => {
        expect(res.body).toEqual([])
      })
  })
})

describe('conversation search', () => {
  it('finds accessible conversations by message content', async () => {
    const admin = await login('admin', 'Admin@123')
    const adminUser = getUserByUsername('admin')
    expect(adminUser).toBeDefined()

    const kb = await request(app)
      .post('/api/kbs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Conversation Atlas', description: 'KB for conversation search tests' })
      .expect(201)

    const kbId = kb.body.id as number
    const conv = createConversation(adminUser!.id, kbId, 'Release rollout')
    insertMessages(conv.id, [
      { role: 'user', content: 'How do we roll out the release?', tool_calls: null, tool_call_id: null, seq: 0 },
      { role: 'assistant', content: 'Use the release checklist and watch the deploy job.', tool_calls: null, tool_call_id: null, seq: 1 },
    ])

    await request(app)
      .get('/api/search/conversations')
      .set('Authorization', `Bearer ${admin.token}`)
      .query({ q: 'release checklist', limit: 10, offset: 0 })
      .expect(200)
      .expect(res => {
        expect(res.body.total).toBeGreaterThanOrEqual(1)
        expect(res.body.items.length).toBeGreaterThanOrEqual(1)
        expect(res.body.items[0]).toMatchObject({
          conv_id: conv.id,
          conv_title: 'Release rollout',
          kb_id: kbId,
          kb_name: 'Conversation Atlas',
        })
        expect(res.body.items[0].snippet).toContain('release checklist')
      })
  })

  it('batch deletes conversations the user owns', async () => {
    const admin = await login('admin', 'Admin@123')
    const adminUser = getUserByUsername('admin')
    expect(adminUser).toBeDefined()

    const kb = await request(app)
      .post('/api/kbs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Batch Conversation Atlas', description: 'KB for conversation batch delete tests' })
      .expect(201)

    const kbId = kb.body.id as number
    const convOne = createConversation(adminUser!.id, kbId, 'Batch Conv One')
    const convTwo = createConversation(adminUser!.id, kbId, 'Batch Conv Two')

    insertMessages(convOne.id, [
      { role: 'user', content: 'Batch conv one keeps a traceable phrase.', tool_calls: null, tool_call_id: null, seq: 0 },
    ])
    insertMessages(convTwo.id, [
      { role: 'user', content: 'Batch conv two keeps another traceable phrase.', tool_calls: null, tool_call_id: null, seq: 0 },
    ])

    await request(app)
      .delete('/api/conversations/batch')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ ids: [convOne.id, convTwo.id] })
      .expect(200)
      .expect(res => {
        expect(res.body).toEqual({ deleted: 2 })
      })

    await request(app)
      .get('/api/search/conversations')
      .set('Authorization', `Bearer ${admin.token}`)
      .query({ q: 'traceable phrase', limit: 10, offset: 0 })
      .expect(200)
      .expect(res => {
        expect(res.body.total).toBe(0)
        expect(res.body.items).toEqual([])
      })
  })
})
