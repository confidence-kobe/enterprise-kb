import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSupportedNodeVersion, MIN_NODE_VERSION } from '../src/nodeVersion.js'

describe('isSupportedNodeVersion', () => {
  it('accepts the minimum version and anything newer', () => {
    for (const v of [MIN_NODE_VERSION, 'v22.19.0', '22.20.1', '22.100.0', '23.0.0', '24.1.0']) {
      expect(isSupportedNodeVersion(v), v).toBe(true)
    }
  })

  it('rejects older versions', () => {
    for (const v of ['20.18.1', '22.0.0', '22.18.9', '22.9.0', '18.20.4']) {
      expect(isSupportedNodeVersion(v), v).toBe(false)
    }
  })
})

describe('startup guard', () => {
  it('stops the server on an unsupported Node version before anything else loads', () => {
    const tsxLoader = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')
    const server = path.join(__dirname, '..', 'src', 'server.ts')
    const fakeOldNode = `Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '20.11.0' } })`
    const result = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', `${fakeOldNode}; await import(${JSON.stringify(server)})`], {
      env: { ...process.env, PORT: '0', DB_PATH: ':memory:' },
      encoding: 'utf-8',
      timeout: 30_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`需要 Node.js ${MIN_NODE_VERSION} 或更高版本，当前为 20.11.0`)
    expect(result.stdout).not.toContain('企业知识库系统已启动')
  }, 30_000)
})
