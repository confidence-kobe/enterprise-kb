/**
 * 网页上传的 multer 配置：存到对应知识库的目录、50 MB 上限、扩展名白名单。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import multer from 'multer'
import type { Request } from 'express'
import type { AuthRequest } from './auth.js'
import { STORAGE_PATH } from './config.js'
import { UPLOAD_EXTS } from './fileTypes.js'

/** multer 在 Windows 上把中文文件名按 Latin-1 读取，需转回 UTF-8 */
export function uploadName(originalname: string): string {
  return Buffer.from(originalname, 'latin1').toString('utf8')
}

export const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      // 目录在路由里确保存在
      const kbId = (req as AuthRequest).params?.id
      const dir  = path.join(STORAGE_PATH, `kb_${kbId}`)
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase()
      const name = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
      cb(null, name)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },   // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (!UPLOAD_EXTS.has(ext)) {
      // 记下被跳过的文件，全部不支持时在错误信息里说明
      const r = req as Request & { skippedFiles?: string[] }
      ;(r.skippedFiles ??= []).push(uploadName(file.originalname))
    }
    cb(null, UPLOAD_EXTS.has(ext))
  },
})
