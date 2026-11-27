/**
 * 已入库文档在磁盘和数据库里的善后：生成存储文件名、彻底删除一份文档。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { STORAGE_PATH } from './config.js'
import { deleteDoc, removeDocFromIndex } from './db.js'
import type { Document } from './db.js'
import { OFFICE_EXTS } from './fileTypes.js'
import { OCR_IMAGE_EXTS } from './ocr.js'

/**
 * 存储文件名由服务端生成（时间戳 + 随机串 + 扩展名），原始文件名只存在数据库里。
 * 这样用户提交的文件名（可能含 ../ 或特殊字符）永远不会出现在磁盘路径里。
 */
export function makeStoredFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase()
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`
}

/** 彻底删除一份文档：磁盘文件、提取出的文字、全文索引和数据库记录 */
export function removeStoredDocument(kbId: number, doc: Document): void {
  const kbDir = path.join(STORAGE_PATH, `kb_${kbId}`)
  const filePath = path.join(kbDir, doc.filename)
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch {}
  // PDF、Office、图片旁边还有一份提取出的 .txt
  const { readPath, extracted } = docTextFile(kbId, doc)
  if (extracted) {
    try { if (fs.existsSync(readPath)) fs.unlinkSync(readPath) } catch {}
  }
  removeDocFromIndex(doc.id)
  deleteDoc(doc.id)
}

/** 文档对应的可读文本文件：PDF、Office 读提取出的 .txt，其他读原文件 */
export function docTextFile(kbId: number, doc: Document): { readPath: string; origExt: string; displayExt: string; extracted: boolean } {
  const origExt = path.extname(doc.original_name).toLowerCase()
  const kbDir   = path.join(STORAGE_PATH, `kb_${kbId}`)
  const extracted = origExt === '.pdf' || OFFICE_EXTS.has(origExt) || OCR_IMAGE_EXTS.has(origExt)
  return extracted
    ? { readPath: path.join(kbDir, doc.filename.replace(/\.[^.]+$/i, '.txt')), origExt, displayExt: '.txt', extracted }
    : { readPath: path.join(kbDir, doc.filename), origExt, displayExt: origExt, extracted }
}
