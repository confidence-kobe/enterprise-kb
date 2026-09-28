import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { configureProxyFromEnv } from '../src/proxy.js'
import { LLMExecutor } from '../src/executor.js'

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']

let llm: http.Server
let proxy: http.Server
let llmPort: number
let proxyHits: string[] = []
const savedEnv: Record<string, string | undefined> = {}
const savedDispatcher = getGlobalDispatcher()

/** 最小的 OpenAI 兼容流式接口 */
function startMockLlm(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.write(chunk({ content: 'proxied ' }, null))
      res.write(chunk({ content: 'answer' }, null))
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** 只记录请求、不真正转发的代理 */
function startRecordingProxy(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    proxyHits.push(`HTTP ${req.url}`)
    res.writeHead(502).end()
  })
  server.on('connect', (req, socket) => {
    proxyHits.push(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function run(baseUrl: string) {
  const executor = new LLMExecutor({ baseUrl, apiKey: 'test', model: 'mock', kbPath: '/tmp', maxTurns: 1 })
  return executor.run('hello', [])
}

beforeAll(async () => {
  llm = await startMockLlm()
  proxy = await startRecordingProxy()
  llmPort = (llm.address() as AddressInfo).port
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  for (const key of PROXY_KEYS) savedEnv[key] = process.env[key]
  process.env.HTTPS_PROXY = process.env.https_proxy = proxyUrl
  process.env.HTTP_PROXY = process.env.http_proxy = proxyUrl
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost'
  configureProxyFromEnv()
})

afterAll(() => {
  setGlobalDispatcher(savedDispatcher)
  for (const key of PROXY_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  llm?.close()
  proxy?.close()
})

describe('LLMExecutor with an outbound proxy configured', () => {
  it('still streams answers from a NO_PROXY host (e.g. local Ollama)', async () => {
    proxyHits = []
    const result = await run(`http://127.0.0.1:${llmPort}/v1`)
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'proxied answer' })
    expect(proxyHits).toEqual([])
  })

  it('sends requests for other hosts through the proxy', async () => {
    proxyHits = []
    await expect(run('https://llm.example.test/v1')).rejects.toThrow()
    expect(proxyHits).toContain('CONNECT llm.example.test:443')
  })
})
