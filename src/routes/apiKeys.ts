/**
 * 接口密钥的管理：用户管理自己的密钥，管理员可以撤销任何人的。
 * 只能用登录 Token 访问，密钥本身不能管理密钥（见 auth.ts 的 isApiKeyAllowed）。
 */

import type { Express } from 'express'
import { requireAuth, requireAdmin, generateApiKey } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { listApiKeys, countApiKeys, createApiKey, getApiKeyById, deleteApiKey, MAX_API_KEYS_PER_USER } from '../db.js'
import { audit } from '../access.js'

const API_KEY_EXPIRY_DAYS_MAX = 3650

/** 返回给前端的密钥信息：用白名单挑字段，保证 key_hash 永远不会出现在响应里 */
function publicApiKey(key: ReturnType<typeof listApiKeys>[number]) {
  const { id, user_id, username, name, prefix, created_at, expires_at, last_used_at } = key
  return { id, user_id, username, name, prefix, created_at, expires_at, last_used_at }
}

export function registerApiKeyRoutes(app: Express): void {
  app.get('/api/me/api-keys', requireAuth, (req: AuthRequest, res) => {
    res.json({ items: listApiKeys(req.user!.userId).map(publicApiKey), max: MAX_API_KEYS_PER_USER })
  })

  app.post('/api/me/api-keys', requireAuth, (req: AuthRequest, res) => {
    const { name, expiresInDays } = (req.body ?? {}) as { name?: unknown; expiresInDays?: unknown }
    const keyName = typeof name === 'string' ? name.trim() : ''
    if (!keyName || keyName.length > 50) {
      res.status(400).json({ error: '请填写密钥名称（最多 50 字），例如「Claude 桌面版」' }); return
    }
    if (expiresInDays != null && (!Number.isInteger(expiresInDays) || (expiresInDays as number) < 1 || (expiresInDays as number) > API_KEY_EXPIRY_DAYS_MAX)) {
      res.status(400).json({ error: `有效期必须是 1–${API_KEY_EXPIRY_DAYS_MAX} 天，或不填表示永久有效` }); return
    }
    if (countApiKeys(req.user!.userId) >= MAX_API_KEYS_PER_USER) {
      res.status(400).json({ error: `每人最多 ${MAX_API_KEYS_PER_USER} 个密钥，请先撤销不用的密钥` }); return
    }
    const generated = generateApiKey()
    const expiresAt = expiresInDays == null ? null : Math.floor(Date.now() / 1000) + (expiresInDays as number) * 86400
    const item = createApiKey({
      userId: req.user!.userId, name: keyName, prefix: generated.prefix, keyHash: generated.hash, expiresAt,
    })
    audit(req, 'apikey.create', 'api_key', {
      entityId: item.id, detail: { name: keyName, prefix: item.prefix, expiresAt },
    })
    res.status(201).json({ key: generated.key, item: publicApiKey(item) })
  })

  app.delete('/api/me/api-keys/:keyId', requireAuth, (req: AuthRequest, res) => {
    const key = getApiKeyById(Number(req.params.keyId))
    if (!key || key.user_id !== req.user!.userId) { res.status(404).json({ error: '密钥不存在' }); return }
    deleteApiKey(key.id)
    audit(req, 'apikey.revoke', 'api_key', { entityId: key.id, detail: { name: key.name, prefix: key.prefix } })
    res.json({ ok: true })
  })

  app.get('/api/admin/api-keys', requireAdmin, (_req, res) => {
    res.json({ items: listApiKeys().map(publicApiKey) })
  })

  /** 员工离职或密钥泄露时，管理员可以撤销任何人的密钥 */
  app.delete('/api/admin/api-keys/:keyId', requireAdmin, (req: AuthRequest, res) => {
    const key = getApiKeyById(Number(req.params.keyId))
    if (!key) { res.status(404).json({ error: '密钥不存在' }); return }
    deleteApiKey(key.id)
    audit(req, 'apikey.revoke', 'api_key', {
      entityId: key.id, detail: { name: key.name, prefix: key.prefix, owner: key.username },
    })
    res.json({ ok: true })
  })
}
