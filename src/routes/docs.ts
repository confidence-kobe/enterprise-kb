/**
 * 文档：列表、上传、新建和编辑文本文档、历史版本、预览（含按行定位）、相关文档、删除。
 */

import type { Express, Response, NextFunction } from 'express'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { audit, canWriteKb, publicDoc } from '../access.js'
import { requireAuth } from '../auth.js'
import type { AuthRequest } from '../auth.js'
import { STORAGE_PATH } from '../config.js'
import { addDocVersion, canUserAccessKb, countDocVersions, countDocs, createDoc, getDocById, getDocVersion, getKbById, getRelatedDocs, indexDocContent, listDocVersions, listDocs, listDocsWithCounts, updateDocIndexStatus, updateDocMeta } from '../db.js'
import type { Document, KnowledgeBase } from '../db.js'
import { docTextFile, removeStoredDocument } from '../documentStore.js'
import { TEXT_PREVIEWABLE_EXTS } from '../fileTypes.js'
import { enqueueDocIndex } from '../indexQueue.js'
import { upload, uploadName } from '../upload.js'

/** 上传前校验写权限：multer 会在路由处理前把文件写入知识库目录，因此必须先拦截 */
function requireKbUploadAccess(req: AuthRequest, res: Response, next: NextFunction): void {
  const kbId = Number(req.params.id)
  if (!Number.isInteger(kbId) || !getKbById(kbId)) { res.status(404).json({ error: '知识库不存在' }); return }
  if (!canWriteKb(kbId, req.user)) {
    res.status(403).json({ error: '无权限向该知识库添加文档' }); return
  }
  next()
}

// ── 编辑现有文本文档（每次保存都记录一个历史版本） ─────────────

/** 把用户输入的标题变成文档名：替换掉文件名里不允许的字符，限制长度，统一以 .md 结尾 */
function textDocTitle(title: string | undefined, fallback: string): string {
  if (!title?.trim()) return fallback
  const safeName = title.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return safeName.endsWith('.md') ? safeName : `${safeName}.md`
}

/**
 * 写入文本文档的新内容并重建索引，同时记录版本。
 * 启用版本记录前创建的文档，第一次保存时先把原内容存为基线版本，保证随时可以找回。
 * 返回 false 表示内容与标题都没有变化。
 */
function saveTextDoc(doc: Document, kb: KnowledgeBase, title: string, content: string, user: NonNullable<AuthRequest['user']>, note?: string): boolean {
  const kbDir    = kb.storage_path || path.join(STORAGE_PATH, `kb_${kb.id}`)
  const filePath = path.join(kbDir, doc.filename)
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
  if (previous === content && title === doc.original_name) return false

  if (countDocVersions(doc.id) === 0 && previous) {
    addDocVersion({ docId: doc.id, title: doc.original_name, content: previous, note: 'baseline', createdAt: doc.indexed_at ?? doc.uploaded_at })
  }

  fs.writeFileSync(filePath, content, 'utf-8')
  const size = Buffer.byteLength(content, 'utf-8')
  updateDocMeta(doc.id, title, size)
  updateDocIndexStatus(doc.id, 'processing')
  try {
    indexDocContent(doc.id, kb.id, title, filePath, content)
  } catch (e) {
    updateDocIndexStatus(doc.id, 'error', (e as Error).message.slice(0, 500))
    console.warn('[FTS5] 索引失败:', (e as Error).message)
  }
  addDocVersion({ docId: doc.id, title, content, userId: user.userId, username: user.username, note })
  return true
}

/** 校验并取出可写的文本文档；失败时已写好响应并返回 null */
function requireWritableTextDoc(req: AuthRequest, res: Response): { doc: Document; kb: KnowledgeBase } | null {
  const kbId  = Number(req.params.id)
  const docId = Number(req.params.docId)
  if (!canWriteKb(kbId, req.user)) {
    res.status(403).json({ error: '无权限编辑该知识库的文档' }); return null
  }
  const doc = getDocById(docId)
  if (!doc || doc.kb_id !== kbId) { res.status(404).json({ error: '文档不存在' }); return null }
  if (doc.source_type !== 'text') { res.status(400).json({ error: '只能编辑文本文档' }); return null }
  const kb = getKbById(kbId)
  if (!kb) { res.status(404).json({ error: '知识库不存在' }); return null }
  return { doc, kb }
}

/** 判断当前用户能否查看该知识库的文档；失败时已写好响应并返回 null */
function requireReadableDoc(req: AuthRequest, res: Response): Document | null {
  const kbId  = Number(req.params.id)
  const docId = Number(req.params.docId)
  if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
    res.status(403).json({ error: '无权限' }); return null
  }
  const doc = getDocById(docId)
  if (!doc || doc.kb_id !== kbId) { res.status(404).json({ error: '文档不存在' }); return null }
  return doc
}

const PREVIEW_MAX_CHARS = 10_000

/** 按行号预览时，目标行之前保留的行数 */
const PREVIEW_LINES_BEFORE = 30

/** 超过这个大小的文本不做按行号定位，只预览开头 */
const PREVIEW_AROUND_MAX_BYTES = 64 * 1024 * 1024

/**
 * 按行读文件，取第 line 行附近的内容：前面留 PREVIEW_LINES_BEFORE 行，总长不超过 PREVIEW_MAX_CHARS。
 * 边读边丢，内存里只留要返回的几十行，不会把几十 MB 的文件整个读进来；读完是为了数出总行数。
 * line 超过总行数时，和以前一样显示文件末尾。
 */
async function readLinesAround(filePath: string, line: number): Promise<{ startLine: number; endLine: number; totalLines: number; content: string }> {
  /** 还没读到目标行时，最近读到的 PREVIEW_LINES_BEFORE + 1 行（含当前行） */
  const recent: string[] = []
  const picked: string[] = []
  let startLine = 0
  let chars = 0
  let full = false
  let n = 0
  // 第一行总要显示；之后的行放得下才放，放不下就停（后面的行只计数）
  const take = (text: string) => {
    if (full) return
    if (picked.length > 0 && chars + text.length >= PREVIEW_MAX_CHARS) { full = true; return }
    picked.push(text)
    chars += text.length + 1
  }
  const onLine = (text: string) => {
    n++
    if (startLine) { take(text); return }
    recent.push(text)
    if (recent.length > PREVIEW_LINES_BEFORE + 1) recent.shift()
    if (n === line) {
      startLine = n - recent.length + 1
      recent.forEach(take)
    }
  }
  // 按 '\n' 切分，行号和索引、Read 工具用的 split('\n') 完全一致（包括 '\r' 留在行尾、末尾换行后算一个空行）
  let rest = ''
  for await (const chunk of fs.createReadStream(filePath, { encoding: 'utf-8' })) {
    const parts = (rest + chunk).split('\n')
    rest = parts.pop()!
    parts.forEach(onLine)
  }
  onLine(rest)
  if (!startLine) {
    // 目标行超出文件末尾：显示最后几行
    startLine = n - recent.length + 1
    recent.forEach(take)
  }
  return { startLine, endLine: startLine + picked.length - 1, totalLines: n, content: picked.join('\n') }
}

export function registerDocRoutes(app: Express): void {
  // ── 文档路由 ──────────────────────────────────────────

  app.get('/api/kbs/:id/docs', requireAuth, (req: AuthRequest, res) => {
    const kbId   = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    // 参数不是正整数时按默认值处理，不让非法值传进 SQL 导致 500
    const limitRaw  = Number(req.query.limit)
    const offsetRaw = Number(req.query.offset)
    const limit  = req.query.limit != null ? Math.min(Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50, 200) : undefined
    const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : undefined
    const total  = countDocs(kbId)
    const items  = limit != null
      ? listDocsWithCounts(kbId, limit, offset ?? 0).map(doc => publicDoc(doc, kb, req.user))
      : listDocs(kbId).map(doc => publicDoc(doc, kb, req.user))
    if (limit != null) {
      res.json({ items, total, hasMore: (offset ?? 0) + items.length < total })
    } else {
      res.json(items)   // 不传 limit 时保持原格式，兼容 chat.js 的 kbDocMap 加载
    }
  })

  app.post('/api/kbs/:id/docs', requireAuth, requireKbUploadAccess, upload.array('files', 20), async (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)

    const files = req.files as Express.Multer.File[] | undefined
    if (!files?.length) {
      const skipped = (req as AuthRequest & { skippedFiles?: string[] }).skippedFiles ?? []
      res.status(400).json({
        error: skipped.length ? `不支持的文件格式：${skipped.slice(0, 5).join('、')}` : '未接收到文件',
      })
      return
    }

    const docs = files.map(f => {
      const origName = uploadName(f.originalname)
      const doc = createDoc({ kbId, filename: f.filename, originalName: origName, size: f.size, indexStatus: 'pending' })
      enqueueDocIndex({ docId: doc.id, kbId, originalName: origName, filePath: f.path })
      return doc
    })
    audit(req, 'doc.upload', 'doc', {
      kbId,
      detail: { count: docs.length, names: docs.map(doc => doc.original_name).slice(0, 20) },
    })
    res.status(201).json(docs)
  })

  // ── 直接创建文本文档 ──────────────────────────────────
  app.post('/api/kbs/:id/docs/text', requireAuth, async (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    if (!canWriteKb(kbId, req.user)) {
      res.status(403).json({ error: '无权限向该知识库添加文档' }); return
    }

    const { title, content } = req.body as { title?: string; content?: string }
    if (!content?.trim()) { res.status(400).json({ error: '内容不能为空' }); return }

    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }

    const safeName = (title?.trim() || '未命名笔记')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 80)
    const timestamp  = Date.now()
    const filename   = `${timestamp}_${Math.random().toString(36).slice(2,8)}.md`
    const origName   = safeName.endsWith('.md') ? safeName : `${safeName}.md`
    const filePath   = path.join(kb.storage_path, filename)

    fs.writeFileSync(filePath, content, 'utf-8')
    const size = Buffer.byteLength(content, 'utf-8')

    const doc = createDoc({ kbId, filename, originalName: origName, size, indexStatus: 'processing', sourceType: 'text' })
    try {
      indexDocContent(doc.id, kbId, origName, filePath, content)
    } catch (e) {
      updateDocIndexStatus(doc.id, 'error', (e as Error).message.slice(0, 500))
      console.warn('[FTS5] 索引失败:', (e as Error).message)
    }

    addDocVersion({ docId: doc.id, title: origName, content, userId: req.user!.userId, username: req.user!.username })

    audit(req, 'doc.create_text', 'doc', {
      entityId: doc.id,
      kbId,
      detail: { title: origName, size },
    })
    res.status(201).json(doc)
  })

  app.patch('/api/kbs/:id/docs/:docId/text', requireAuth, async (req: AuthRequest, res) => {
    const target = requireWritableTextDoc(req, res)
    if (!target) return
    const { doc, kb } = target

    const { title, content } = req.body as { title?: string; content?: string }
    if (!content?.trim()) { res.status(400).json({ error: '内容不能为空' }); return }

    const origName = textDocTitle(title, doc.original_name)
    const changed = saveTextDoc(doc, kb, origName, content, req.user!)
    if (changed) {
      audit(req, 'doc.update_text', 'doc', { entityId: doc.id, kbId: kb.id, detail: { title: origName, size: Buffer.byteLength(content, 'utf-8') } })
    }
    res.json({ ok: true, changed })
  })

  app.get('/api/kbs/:id/docs/:docId/versions', requireAuth, (req: AuthRequest, res) => {
    const doc = requireReadableDoc(req, res)
    if (!doc) return
    res.json({ items: listDocVersions(doc.id) })
  })

  app.get('/api/kbs/:id/docs/:docId/versions/:versionId', requireAuth, (req: AuthRequest, res) => {
    const doc = requireReadableDoc(req, res)
    if (!doc) return
    const version = getDocVersion(doc.id, Number(req.params.versionId))
    if (!version) { res.status(404).json({ error: '版本不存在' }); return }
    res.json(version)
  })

  /** 恢复旧版本：把旧内容另存为最新版本，历史记录不会被删除 */
  app.post('/api/kbs/:id/docs/:docId/versions/:versionId/restore', requireAuth, (req: AuthRequest, res) => {
    const target = requireWritableTextDoc(req, res)
    if (!target) return
    const { doc, kb } = target
    const version = getDocVersion(doc.id, Number(req.params.versionId))
    if (!version) { res.status(404).json({ error: '版本不存在' }); return }

    const changed = saveTextDoc(doc, kb, version.title, version.content, req.user!, `restore:${version.id}`)
    audit(req, 'doc.restore_version', 'doc', {
      entityId: doc.id, kbId: kb.id, detail: { title: version.title, versionId: version.id, changed },
    })
    res.json({ ok: true, changed })
  })

  app.get('/api/kbs/:id/docs/:docId/preview', requireAuth, async (req: AuthRequest, res) => {
    const kbId  = Number(req.params.id)
    const docId = Number(req.params.docId)
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    const doc = getDocById(docId)
    if (!doc || doc.kb_id !== kbId) {
      res.status(404).json({ error: '文档不存在' }); return
    }
    const { readPath, origExt, displayExt, extracted } = docTextFile(kbId, doc)
    if (!TEXT_PREVIEWABLE_EXTS.has(displayExt)) {
      res.status(415).json({ error: '该文件类型不支持预览', type: origExt }); return
    }
    if (!fs.existsSync(readPath)) {
      res.status(404).json({ error: extracted ? '文档文本提取失败或尚未完成' : '文件不存在' }); return
    }
    const totalBytes = fs.statSync(readPath).size
    const line = Number(req.query.line)
    // 引用跳转：长文档里被引用的行不在开头时，返回那一行附近的内容
    if (Number.isInteger(line) && line > 0 && totalBytes > PREVIEW_MAX_CHARS * 3 && totalBytes <= PREVIEW_AROUND_MAX_BYTES) {
      const { startLine, endLine, totalLines, content } = await readLinesAround(readPath, line)
      res.json({
        filename: doc.original_name, ext: origExt, displayExt, totalBytes,
        content, startLine, truncated: true,
        truncatedHint: `内容过长，显示第 ${startLine}–${endLine} 行（共 ${totalLines} 行）`,
      })
      return
    }
    const fd  = fs.openSync(readPath, 'r')
    const buf = Buffer.alloc(Math.min(totalBytes, PREVIEW_MAX_CHARS * 3))
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    let content = buf.subarray(0, bytesRead).toString('utf-8')
    if (content.length > PREVIEW_MAX_CHARS) content = content.slice(0, PREVIEW_MAX_CHARS)
    const truncated = totalBytes > PREVIEW_MAX_CHARS * 3 || content.length >= PREVIEW_MAX_CHARS
    res.json({
      filename: doc.original_name, ext: origExt, displayExt, totalBytes, content, startLine: 1, truncated,
      truncatedHint: truncated
        ? `内容过长，仅显示前 ${(content.length / 1024).toFixed(1)} KB（共 ${(totalBytes / 1024).toFixed(1)} KB）`
        : null,
    })
  })

  app.get('/api/kbs/:id/docs/:docId/related', requireAuth, (req: AuthRequest, res) => {
    const kbId  = Number(req.params.id)
    const docId = Number(req.params.docId)
    if (!canUserAccessKb(req.user!.userId, kbId) && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    const doc = getDocById(docId)
    if (!doc || doc.kb_id !== kbId) { res.status(404).json({ error: '文档不存在' }); return }
    const limit = Math.min(Number(req.query.limit ?? 5), 10)
    const related = getRelatedDocs(kbId, docId, limit)
    res.json({ items: related, vectorsAvailable: related.length > 0 })
  })

  app.delete('/api/kbs/:id/docs/batch', requireAuth, async (req: AuthRequest, res) => {
    const kbId = Number(req.params.id)
    const kb = getKbById(kbId)
    if (!kb) { res.status(404).json({ error: '知识库不存在' }); return }
    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }
    const ids: number[] = req.body?.ids ?? []
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: '请提供文档 id 列表' }); return
    }
    let deleted = 0
    for (const docId of ids) {
      const doc = getDocById(docId)
      if (!doc || doc.kb_id !== kbId) continue
      removeStoredDocument(kbId, doc)
      deleted++
    }
    audit(req, 'doc.batch_delete', 'doc', { kbId, detail: { requested: ids.length, deleted } })
    res.json({ deleted })
  })

  app.delete('/api/kbs/:id/docs/:docId', requireAuth, (req: AuthRequest, res) => {
    const kbId  = Number(req.params.id)
    const docId = Number(req.params.docId)
    const kb  = getKbById(kbId)
    const doc = getDocById(docId)
    if (!kb || !doc || doc.kb_id !== kbId) { res.status(404).json({ error: '不存在' }); return }

    if (kb.owner_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: '无权限' }); return
    }

    removeStoredDocument(kbId, doc)
    audit(req, 'doc.delete', 'doc', {
      entityId: docId,
      kbId,
      detail: { name: doc.original_name },
    })
    res.json({ ok: true })
  })
}
