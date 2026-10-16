/**
 * 检索性能基准：生成大量模拟文档，测量索引、检索、文档列表与删除耗时。
 *
 *   npm run build && npm run bench:search -- [文档数=2000] [每篇段落数=40]
 *
 * 使用临时数据库，不会触碰 data/ 中的真实数据。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import * as db from '../dist/db.js'

const DOCS = Number(process.argv[2] ?? 2000)
const PARAGRAPHS = Number(process.argv[3] ?? 40)
const KBS = 3

const TOPICS = ['年假', '报销', '出差', '采购', '考勤', '绩效', '入职', '离职', '加班', '社保', '公积金', '培训', '合同', '保密', '设备']
const VERBS = ['申请', '审批', '发放', '核算', '登记', '变更', '归档', '复核']
const NOUNS = ['流程', '标准', '额度', '时限', '材料', '负责人', '系统', '表单']

let seed = 42
const rand = n => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
const pick = list => list[rand(list.length)]

function paragraph(i) {
  const sentences = []
  for (let s = 0; s < 4; s++) {
    sentences.push(`${pick(TOPICS)}${pick(VERBS)}的${pick(NOUNS)}为第 ${rand(30) + 1} 个工作日内完成，编号 R${i}-${s}-${rand(10000)}。`)
  }
  return sentences.join('')
}

function documentText(d) {
  const parts = [`# ${pick(TOPICS)}管理制度 ${d}`]
  for (let p = 0; p < PARAGRAPHS; p++) {
    if (p % 8 === 0) parts.push(`## 第${p / 8 + 1}节 ${pick(TOPICS)}${pick(NOUNS)}`)
    parts.push(paragraph(p))
  }
  return parts.join('\n\n')
}

function time(label, fn, runs = 1) {
  fn()
  const start = performance.now()
  for (let i = 0; i < runs; i++) fn()
  const ms = (performance.now() - start) / runs
  console.log(`${label.padEnd(36)} ${ms.toFixed(1).padStart(9)} ms`)
  return ms
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bench-'))
try {
  db.initDb(path.join(dir, 'bench.db'))
  const owner = db.createUser('bench', 'Bench@12345', 'admin')
  const kbs = Array.from({ length: KBS }, (_, i) => db.createKb({ name: `KB${i}`, storagePath: path.join(dir, `kb_${i}`), ownerId: owner.id }))

  const docIds = []
  let chars = 0
  const indexStart = performance.now()
  for (let d = 0; d < DOCS; d++) {
    const kb = kbs[d % KBS]
    const text = documentText(d)
    chars += text.length
    const doc = db.createDoc({ kbId: kb.id, filename: `doc-${d}.md`, originalName: `制度-${d}.md`, size: text.length })
    db.indexDocContent(doc.id, kb.id, doc.original_name, path.join(kb.storage_path, doc.filename), text)
    docIds.push(doc.id)
  }
  const indexMs = performance.now() - indexStart
  const kbId = kbs[0].id
  console.log(`${DOCS} 篇文档，${(chars / 1e6).toFixed(1)} M 字符，${KBS} 个知识库`)
  console.log(`${'索引全部文档'.padEnd(36)} ${indexMs.toFixed(0).padStart(9)} ms（平均 ${(indexMs / DOCS).toFixed(2)} ms/篇）`)

  time('检索：单个 3 字词', () => db.searchDocContent(kbId, '公积金'), 20)
  time('检索：单个 2 字词', () => db.searchDocContent(kbId, '年假'), 20)
  time('检索：多词', () => db.searchDocContent(kbId, '报销 审批 时限'), 20)
  time('检索：无结果（长词）', () => db.searchDocContent(kbId, '不存在的词汇'), 20)
  time('检索：无结果（2 字词）', () => db.searchDocContent(kbId, '飞机'), 20)
  time('文档列表（首页 50 条，含分块数）', () => db.listDocsWithCounts(kbId, 50, 0), 5)
  time('判断文档是否已索引', () => db.isDocIndexed(docIds[DOCS - 1]), 20)
  let next = 0
  time('删除单篇文档的索引', () => db.removeDocFromIndex(docIds[next++]), 10)
  const extra = db.createKb({ name: 'tmp', storagePath: path.join(dir, 'tmp'), ownerId: owner.id })
  const kbStart = performance.now()
  db.deleteKb(kbs[KBS - 1].id)
  console.log(`${'删除整个知识库'.padEnd(36)} ${(performance.now() - kbStart).toFixed(1).padStart(9)} ms`)
  db.deleteKb(extra.id)
} finally {
  db.closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
}
