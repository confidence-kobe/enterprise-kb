import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPdfText } from '../src/pdfText.js'

const fixture = (name: string) => path.join(__dirname, 'fixtures', name)

describe('extractPdfText', () => {
  it('extracts Chinese text and keeps table cells apart', async () => {
    const text = await extractPdfText(fixture('zh-policy.pdf'))
    expect(text).toContain('员工请假制度')
    expect(text).toContain('入职满一年的员工每年享有 15 天带薪年假')
    expect(text).toMatch(/年假\s+15/)
  })

  it('extracts every page without inserting page markers', async () => {
    const text = await extractPdfText(fixture('en-multipage.pdf'))
    for (const n of [1, 2, 3]) expect(text).toContain(`Chapter ${n}`)
    expect(text).toContain('restart the service on port 8082')
    expect(text).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/)
  })

  it('rejects a file that is not a PDF', async () => {
    const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-')), 'broken.pdf')
    fs.writeFileSync(broken, 'not a real pdf file')
    await expect(extractPdfText(broken)).rejects.toThrow()
  })
})
