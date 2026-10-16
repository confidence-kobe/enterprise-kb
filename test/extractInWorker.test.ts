import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractDocumentTextInWorker } from '../src/extractInWorker.js'

const fixture = (name: string) => path.join(__dirname, 'fixtures', name)

describe('extractDocumentTextInWorker', () => {
  it('extracts PDF text in a worker thread while the main thread keeps running', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 1)
    const text = await extractDocumentTextInWorker(fixture('en-multipage.pdf'), '.pdf')
    clearInterval(timer)

    expect(text).toContain('restart the service on port 8082')
    expect(ticks).toBeGreaterThan(0)
  })

  it('reports parser errors from the worker', async () => {
    const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'extract-')), 'broken.pdf')
    fs.writeFileSync(broken, 'not a real pdf file')
    await expect(extractDocumentTextInWorker(broken, '.pdf')).rejects.toThrow()
  })

  it('gives up on a file that takes too long', async () => {
    await expect(extractDocumentTextInWorker(fixture('zh-policy.pdf'), '.pdf', { timeoutMs: 1 }))
      .rejects.toThrow('文档解析超时')
  })

  it('rejects file types it cannot parse', async () => {
    await expect(extractDocumentTextInWorker(fixture('zh-policy.pdf'), '.exe')).rejects.toThrow('不支持解析的文件类型')
  })
})
