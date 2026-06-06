import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Express } from 'express'

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
})
