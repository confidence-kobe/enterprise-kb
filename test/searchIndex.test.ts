import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDb, createDoc, createKb, createUser, deleteDoc, deleteKb, initDb, indexDocContent,
  indexDocContentInBatches, isDocIndexed, listDocsWithCounts, removeDocFromIndex, searchDocContent,
} from '../src/db.ts'

let root: string
let dbPath: string

function setup() {
  const owner = createUser('owner', 'Owner@12345', 'admin')
  const kb = (name: string) => createKb({ name, storagePath: path.join(root, name), ownerId: owner.id })
  const addDoc = (kbId: number, name: string, text: string) => {
    const doc = createDoc({ kbId, filename: name, originalName: name, size: text.length })
    indexDocContent(doc.id, kbId, name, path.join(root, name), text)
    return doc
  }
  return { kb, addDoc }
}

function ftsRows(): number {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return (raw.prepare('SELECT COUNT(*) AS n FROM doc_fts').get() as { n: number }).n
  } finally {
    raw.close()
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-search-'))
  dbPath = path.join(root, 'kb.db')
  initDb(dbPath)
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('search index bookkeeping', () => {
  it('reindexing replaces a document\'s chunks instead of duplicating them', () => {
    const { kb, addDoc } = setup()
    const hr = kb('hr')
    const doc = addDoc(hr.id, 'leave.md', '# 年假\n\n年假为每年 10 天，需提前申请。')
    indexDocContent(doc.id, hr.id, 'leave.md', 'leave.md', '# 年假\n\n年假调整为每年 15 天，需提前申请。')

    const results = searchDocContent(hr.id, '年假')
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toContain('15 天')
    expect(listDocsWithCounts(hr.id, 10, 0)[0].chunk_count).toBe(1)
  })

  it('keeps knowledge bases apart for short and long search terms', () => {
    const { kb, addDoc } = setup()
    const hr = kb('hr')
    const finance = kb('finance')
    addDoc(hr.id, 'leave.md', '年假为每年 10 天，公积金按月缴纳。')
    addDoc(finance.id, 'travel.md', '出差报销标准，年假期间不得报销，公积金另计。')

    for (const query of ['年假', '公积金', '报销 年假']) {
      expect(searchDocContent(hr.id, query).map(r => r.original_name)).toEqual(['leave.md'])
    }
  })

  it('removes a document from search and its chunk count', () => {
    const { kb, addDoc } = setup()
    const hr = kb('hr')
    const doc = addDoc(hr.id, 'leave.md', '年假为每年 10 天，需提前申请。')
    expect(isDocIndexed(doc.id)).toBe(true)

    removeDocFromIndex(doc.id)
    expect(isDocIndexed(doc.id)).toBe(false)
    expect(searchDocContent(hr.id, '年假')).toEqual([])
    expect(ftsRows()).toBe(0)
  })

  it('deleting a knowledge base also deletes its search index', () => {
    const { kb, addDoc } = setup()
    const hr = kb('hr')
    const finance = kb('finance')
    addDoc(hr.id, 'leave.md', '年假为每年 10 天，需提前申请。')
    addDoc(finance.id, 'travel.md', '出差报销需在 30 天内提交。')

    deleteKb(hr.id)
    expect(ftsRows()).toBe(1)
    expect(searchDocContent(finance.id, '报销')).toHaveLength(1)
  })

  it('upgrades an older database: backfills the chunk map and drops orphaned index rows', () => {
    const { kb, addDoc } = setup()
    const hr = kb('hr')
    const doc = addDoc(hr.id, 'leave.md', '年假为每年 10 天，需提前申请。')
    closeDb()

    // 模拟旧版本数据库：没有 doc_chunks，且有已删除知识库遗留的索引
    const raw = new Database(dbPath)
    raw.exec(`
      DROP TABLE doc_chunks;
      INSERT INTO doc_fts(content, original_name, file_path, kb_id, doc_id, chunk_line)
        VALUES ('孤儿索引 年假 内容', 'ghost.md', 'ghost.md', 999, 999, 0);
    `)
    raw.close()

    initDb(dbPath)
    expect(ftsRows()).toBe(1)
    expect(isDocIndexed(doc.id)).toBe(true)
    expect(listDocsWithCounts(hr.id, 10, 0)[0].chunk_count).toBe(1)
    removeDocFromIndex(doc.id)
    expect(ftsRows()).toBe(0)
  })

  describe('batched indexing for large documents', () => {
    const sections = Array.from({ length: 6 }, (_, i) => `## 第${i + 1}节\n\n年假相关规定第 ${i + 1} 条，需提前申请并由主管审批。`).join('\n\n')

    it('indexes every chunk and lets other work run between batches', async () => {
      const { kb } = setup()
      const hr = kb('hr')
      const doc = createDoc({ kbId: hr.id, filename: 'big.md', originalName: 'big.md', size: sections.length })

      let ticks = 0
      const timer = setInterval(() => { ticks++ }, 0)
      await indexDocContentInBatches(doc.id, hr.id, 'big.md', 'big.md', sections, 2)
      clearInterval(timer)

      expect(ticks).toBeGreaterThan(0)
      expect(isDocIndexed(doc.id)).toBe(true)
      expect(listDocsWithCounts(hr.id, 10, 0)[0].chunk_count).toBe(6)
      expect(searchDocContent(hr.id, '第6节')).toHaveLength(1)
    })

    it('stops and cleans up when the document is deleted mid-way', async () => {
      const { kb } = setup()
      const hr = kb('hr')
      const doc = createDoc({ kbId: hr.id, filename: 'big.md', originalName: 'big.md', size: sections.length })

      const indexing = indexDocContentInBatches(doc.id, hr.id, 'big.md', 'big.md', sections, 2)
      deleteDoc(doc.id)
      await indexing

      expect(ftsRows()).toBe(0)
    })

    it('keeps a manual edit that lands while a large reindex is running', async () => {
      const { kb } = setup()
      const hr = kb('hr')
      const doc = createDoc({ kbId: hr.id, filename: 'big.md', originalName: 'big.md', size: sections.length })

      const indexing = indexDocContentInBatches(doc.id, hr.id, 'big.md', 'big.md', sections, 2)
      indexDocContent(doc.id, hr.id, 'big.md', 'big.md', '年假调整为每年 15 天，需提前申请。')
      await indexing

      expect(listDocsWithCounts(hr.id, 10, 0)[0].chunk_count).toBe(1)
      expect(searchDocContent(hr.id, '年假')[0].snippet).toContain('15 天')
    })
  })
})
