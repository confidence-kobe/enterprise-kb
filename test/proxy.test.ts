import { describe, expect, it } from 'vitest'
import { getProxyFromEnv, redactProxyUrl } from '../src/proxy.js'

describe('getProxyFromEnv', () => {
  it('returns undefined when no proxy is configured', () => {
    expect(getProxyFromEnv({})).toBeUndefined()
    expect(getProxyFromEnv({ HTTPS_PROXY: '  ' })).toBeUndefined()
  })

  it('prefers HTTPS proxies over HTTP proxies', () => {
    expect(getProxyFromEnv({ HTTP_PROXY: 'http://a:1', https_proxy: 'http://b:2' })).toBe('http://b:2')
    expect(getProxyFromEnv({ http_proxy: 'http://c:3' })).toBe('http://c:3')
  })
})

describe('redactProxyUrl', () => {
  it('hides credentials', () => {
    const out = redactProxyUrl('http://alice:s3cret@proxy.corp:3128')
    expect(out).toBe('http://***@proxy.corp:3128')
    expect(out).not.toContain('s3cret')
    expect(out).not.toContain('alice')
  })

  it('leaves credential-free URLs unchanged and tolerates garbage', () => {
    expect(redactProxyUrl('http://proxy.corp:3128')).toBe('http://proxy.corp:3128')
    expect(redactProxyUrl('not a url')).toBe('<invalid proxy url>')
  })
})
