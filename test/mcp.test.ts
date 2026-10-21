import { describe, expect, it } from 'vitest'
import { handleMcpMessage, MCP_PROTOCOL_VERSIONS, McpToolError, type McpTool } from '../src/mcp.ts'

process.env.JWT_SECRET ??= 'test-secret-change-me-at-least-32-chars'
const { isApiKeyAllowed, generateApiKey, hashApiKey } = await import('../src/auth.ts')

const info = { name: 'kb', title: 'KB', version: '1.0.0', instructions: '' }
const tools: McpTool[] = [
  { name: 'ok', title: 'ok', description: '', inputSchema: { type: 'object' }, call: async args => `hi ${args.who}` },
  { name: 'bad', title: 'bad', description: '', inputSchema: { type: 'object' }, call: async () => { throw new McpToolError('无权访问') } },
]

describe('MCP protocol', () => {
  it('negotiates the protocol version', async () => {
    const reply = (v: unknown) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } }, info, tools)
    expect(await reply('2024-11-05')).toMatchObject({ result: { protocolVersion: '2024-11-05' } })
    expect(await reply('1999-01-01')).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] } })
  })

  it('returns tool results and tool errors, ignores notifications', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'ok', arguments: { who: '小王' } } }, info, tools))
      .toEqual({ jsonrpc: '2.0', id: 'a', result: { content: [{ type: 'text', text: 'hi 小王' }], isError: false } })
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bad' } }, info, tools))
      .toMatchObject({ result: { content: [{ text: '无权访问' }], isError: true } })
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, info, tools)).toBeNull()
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 3, result: {} }, info, tools)).toBeNull()
    expect(await handleMcpMessage('nope', info, tools)).toMatchObject({ error: { code: -32600 } })
  })
})

describe('API key permissions', () => {
  it('allows reads and Q&A only', () => {
    expect(isApiKeyAllowed('GET', '/api/kbs')).toBe(true)
    expect(isApiKeyAllowed('POST', '/api/kbs/3/ask')).toBe(true)
    expect(isApiKeyAllowed('POST', '/api/ask/')).toBe(true)
    expect(isApiKeyAllowed('POST', '/MCP')).toBe(true)
    expect(isApiKeyAllowed('POST', '/api/kbs')).toBe(false)
    expect(isApiKeyAllowed('PATCH', '/api/me/password')).toBe(false)
    expect(isApiKeyAllowed('DELETE', '/api/kbs/3')).toBe(false)
    expect(isApiKeyAllowed('GET', '/api/admin/users')).toBe(false)
    expect(isApiKeyAllowed('GET', '/Api/Me/Api-Keys')).toBe(false)
  })

  it('generates distinct keys and stores only a hash', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.key).not.toBe(b.key)
    expect(a.hash).toBe(hashApiKey(a.key))
    expect(a.hash).not.toContain(a.key)
    expect(a.key.startsWith(a.prefix)).toBe(true)
  })
})
