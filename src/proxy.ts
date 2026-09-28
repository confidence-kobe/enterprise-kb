/**
 * 出站 HTTP 代理 — 读取 HTTPS_PROXY / HTTP_PROXY / NO_PROXY（大小写均可）
 *
 * 设置 undici 全局 dispatcher 后，Node 内置 fetch()（LLM 探测、Embedding）
 * 以及传入 fetch: globalThis.fetch 的 OpenAI SDK 都会走代理；
 * NO_PROXY 中的地址（如本机 Ollama）直连。
 */

import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const

/** 返回生效的代理地址（未配置时为 undefined） */
export function getProxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of PROXY_KEYS) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

/** 去掉代理地址中的用户名和密码，便于写日志 */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl)
    if (u.username || u.password) {
      u.username = '***'
      u.password = ''
    }
    return u.toString().replace(/\/$/, '')
  } catch {
    return '<invalid proxy url>'
  }
}

/** 若配置了代理则启用，返回脱敏后的代理地址 */
export function configureProxyFromEnv(): string | undefined {
  const proxyUrl = getProxyFromEnv()
  if (!proxyUrl) return undefined
  setGlobalDispatcher(new EnvHttpProxyAgent())
  return redactProxyUrl(proxyUrl)
}
