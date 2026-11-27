/**
 * 权限与审计的共用辅助函数：谁能管理、谁能写入知识库，返回给前端的信息要隐藏什么，以及怎么记审计日志。
 * 路由文件都从这里取，不要在路由里各写一份判断。
 */

import type { Request, Response } from 'express'
import { canUserWriteKb, createAuditEvent, getKbById } from './db.js'
import type { Document, KnowledgeBase } from './db.js'
import type { AuthRequest } from './auth.js'

/** 能否管理知识库（改设置、管成员、删库）：只有管理员和所有者，成员不行 */
export function canManageKb(kb: KnowledgeBase, user: AuthRequest['user']): boolean {
  return Boolean(user && (user.role === 'admin' || kb.owner_id === user.userId))
}

/** 能否写入文档（上传、新建、编辑）：管理员、所有者、成员；公开知识库对其他人只读 */
export function canWriteKb(kbId: number, user: AuthRequest['user']): boolean {
  return Boolean(user && (user.role === 'admin' || canUserWriteKb(user.userId, kbId)))
}

/**
 * 返回给前端的知识库信息。不能管理的人看不到同步文件夹路径：
 * 那是服务器上的真实路径，暴露出去会泄露服务器的目录结构。
 */
export function publicKb(kb: KnowledgeBase, user: AuthRequest['user']): KnowledgeBase & { can_write: boolean } {
  const can_write = canWriteKb(kb.id, user)
  if (canManageKb(kb, user)) return { ...kb, can_write }
  return { ...kb, sync_source_path: null, sync_last_at: null, sync_last_result: null, can_write }
}

/** 同上：同步来的文档，源文件路径只给能管理知识库的人看 */
export function publicDoc(doc: Document, kb: KnowledgeBase, user: AuthRequest['user']): Document {
  if (canManageKb(kb, user)) return doc
  return { ...doc, source_path: null }
}

/**
 * 记一条审计日志。操作人、IP 从请求里取，路由只需说明做了什么（action）、对什么做的（entityType）。
 * action 的命名规则是"对象.动作"，例如 kb.create、doc.delete、qa.ask。
 */
export function audit(
  req: AuthRequest | Request,
  action: string,
  entityType: string,
  data: {
    entityId?: number | null
    kbId?: number | null
    detail?: unknown
    userId?: number | null
    username?: string | null
  } = {},
): void {
  const authUser = (req as AuthRequest).user
  const apiKey = (req as AuthRequest).apiKey
  // 通过接口密钥发起的操作在详情里注明用的是哪把密钥
  const detail = apiKey && (data.detail === undefined || (typeof data.detail === 'object' && data.detail && !Array.isArray(data.detail)))
    ? { ...(data.detail as object | undefined), via: 'api_key', apiKey: apiKey.prefix }
    : data.detail
  createAuditEvent({
    userId: data.userId ?? authUser?.userId ?? null,
    username: data.username ?? authUser?.username ?? null,
    action,
    entityType,
    entityId: data.entityId ?? null,
    kbId: data.kbId ?? null,
    detail,
    ip: req.ip,
  })
}

/** 路由里常用的检查：知识库存在且当前用户能管理它，否则直接回 404/403 并返回 null */
export function requireKbOwnerOrAdmin(req: AuthRequest, res: Response, kbId: number): KnowledgeBase | null {
  const kb = getKbById(kbId)
  if (!kb) {
    res.status(404).json({ error: '知识库不存在' })
    return null
  }
  if (!canManageKb(kb, req.user)) {
    res.status(403).json({ error: '无权限' })
    return null
  }
  return kb
}
