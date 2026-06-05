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
