/**
 * 知识库本身（列表、创建、改、删、公开、文件夹同步）和成员管理。
 */

import type { Express } from 'express'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { audit, publicKb, requireKbOwnerOrAdmin } from '../access.js'
import { requireAuth } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { STORAGE_PATH } from '../config.js'
import { canUserAccessKb, createKb, deleteKb, getAllKbs, getKbById, getUserByUsername, grantKbAccess, listKbMembers, listKbsForUser, revokeKbAccess, updateKbMeta, updateKbPublic, updateKbStoragePath, updateKbSyncResult, updateKbSyncSource, updateKbSystemPrompt } from '../db.js'
import { normalizeSourcePath, syncKnowledgeBase, validateSyncSource } from '../folderSync.js'
import { getKbStats } from '../db.js'

export function registerKbRoutes(app: Express): void {
  // ── 知识库路由 ────────────────────────────────────────

  app.get('/api/kbs', requireAuth, (req: AuthRequest, res) => {
    const kbs = req.user!.role === 'admin'
      ? getAllKbs()
      : listKbsForUser(req.user!.userId)
    res.json(kbs.map(kb => ({ ...publicKb(kb, req.user), ...getKbStats(kb.id) })))
  })

  app.post('/api/kbs', requireAuth, (req: AuthRequest, res) => {
    const { name, description } = req.body as { name: string; description?: string }
    if (!name?.trim()) { res.status(400).json({ error: '知识库名称不能为空' }); return }

    // 先用占位路径创建记录，拿到 ID 后更新为真实路径
    const kb = createKb({ name: name.trim(), description, storagePath: '', ownerId: req.user!.userId })
    const realPath = path.join(STORAGE_PATH, `kb_${kb.id}`)
    fs.mkdirSync(realPath, { recursive: true })
    updateKbStoragePath(kb.id, realPath)
    audit(req, 'kb.create', 'kb', { entityId: kb.id, kbId: kb.id, detail: { name: name.trim() } })

    res.status(201).json({ ...kb, storage_path: realPath, can_write: true })
  })

  app.get('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限访问该知识库' }); return
    }
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    res.json(publicKb(kb, req.user))
  })

  app.delete('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限删除' }); return
    }

    // 删除存储目录（使用计算路径，兼容旧数据）
    const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
    if (fs.existsSync(kbDir)) {
      fs.rmSync(kbDir, { recursive: true, force: true })
    }
    deleteKb(kbId)
    audit(req, 'kb.delete', 'kb', { entityId: kbId, kbId, detail: { name: kb.name } })
    res.json({ ok: true })
  })

  app.patch('/api/kbs/:id', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限修改' }); return
    }
    const { name, description, system_prompt } = req.body as { name?: string; description?: string; system_prompt?: string }
    if (!name?.trim()) { res.status(400).json({ error: '名称不能为空' }); return }
    updateKbMeta(kbId, name.trim(), description?.trim() ?? null)
    if (system_prompt !== undefined) updateKbSystemPrompt(kbId, system_prompt?.trim() || null)
    audit(req, 'kb.update', 'kb', { entityId: kbId, kbId, detail: { name: name.trim() } })
    res.json({ ok: true })
  })

  app.patch('/api/kbs/:id/public', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限修改' }); return
    }
    updateKbPublic(kbId, Boolean(req.body.is_public))
    audit(req, 'kb.public_update', 'kb', {
      entityId: kbId,
      kbId,
      detail: { is_public: Boolean(req.body.is_public) },
    })
    res.json({ ok: true })
  })

  app.patch('/api/kbs/:id/sync-source', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = requireKbOwnerOrAdmin(req, res, kbId)
    if (!kb) return

    const rawPath = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
    if (!rawPath) {
      updateKbSyncSource(kbId, null)
      updateKbSyncResult(kbId, '同步目录已清空')
      audit(req, 'kb.sync_source_clear', 'kb', { entityId: kbId, kbId })
      res.json({ ok: true, sync_source_path: null })
      return
    }

    // 同步会把服务器目录中的文件导入知识库，只有管理员可以指定目录（所有者仍可清空）
    if (req.user!.role !== 'admin') {
      res.status(403).json({ error: '只有管理员可以设置同步目录' })
      return
    }

    const sourcePath = normalizeSourcePath(rawPath)
    const invalid = validateSyncSource(sourcePath)
    if (invalid) {
      res.status(400).json({ error: invalid })
      return
    }

    updateKbSyncSource(kbId, sourcePath)
    audit(req, 'kb.sync_source_update', 'kb', { entityId: kbId, kbId, detail: { path: sourcePath } })
    res.json({ ok: true, sync_source_path: sourcePath })
  })

  app.post('/api/kbs/:id/sync', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = requireKbOwnerOrAdmin(req, res, kbId)
    if (!kb) return

    const sourcePath = kb.sync_source_path ? normalizeSourcePath(kb.sync_source_path) : ''
    if (!sourcePath) {
      res.status(400).json({ error: '请先设置同步文件夹' })
      return
    }
    // 执行时再次校验：目录可能已被替换为符号链接，或白名单已调整
    const invalid = validateSyncSource(sourcePath)
    if (invalid) {
      res.status(400).json({ error: invalid })
      return
    }

    const summary = syncKnowledgeBase(kb, sourcePath)
    updateKbSyncResult(kbId, JSON.stringify(summary))
    audit(req, 'kb.sync_run', 'kb', {
      entityId: kbId,
      kbId,
      detail: { ...summary, errors: summary.errors.slice(0, 5) },
    })
    res.json(summary)
  })

  // ── 知识库成员路由 ────────────────────────────────────

  app.get('/api/kbs/:id/members', requireAuth, (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    res.json(listKbMembers(kbId))
  })

  app.post('/api/kbs/:id/members', requireAuth, (req: AuthRequest, res) => {
    const kbId   = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    const { username } = req.body as { username: string }
    if (!username?.trim()) { res.status(400).json({ error: '请提供用户名' }); return }

    const target = getUserByUsername(username.trim())
    if (!target) { res.status(404).json({ error: `用户 "${username}" 不存在` }); return }
    if (target.id === kb.owner_id) { res.status(400).json({ error: '创建者已有访问权限' }); return }

    grantKbAccess(kbId, target.id)
    audit(req, 'kb.member_add', 'kb_member', {
      entityId: target.id,
      kbId,
      detail: { username: target.username },
    })
    res.status(201).json({ id: target.id, username: target.username, role: target.role })
  })

  app.delete('/api/kbs/:id/members/:userId', requireAuth, (req: AuthRequest, res) => {
    const kbId   = Number(req.params.id)
    const userId = Number(req.params.userId)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    revokeKbAccess(kbId, userId)
    audit(req, 'kb.member_remove', 'kb_member', { entityId: userId, kbId })
    res.json({ ok: true })
  })
}
