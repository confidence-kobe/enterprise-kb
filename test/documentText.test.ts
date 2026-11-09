import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractDocumentText } from '../src/documentText.js'
import { extractDocumentTextInWorker } from '../src/extractInWorker.js'

const fixture = (name: string) => path.join(__dirname, 'fixtures', name)

describe('extractDocumentText: PowerPoint', () => {
  // officeparser 8 起不再提供 parseOfficeAsync，旧写法会让所有 PPT 都解析失败；这条测试防止再次出现
  it('extracts slide text, table cells and speaker notes in Chinese', async () => {
    const text = await extractDocumentText(fixture('zh-slides.pptx'), '.pptx')
    expect(text).toContain('员工手册')
    expect(text).toContain('第一章 考勤制度：每天 9:00 上班。')
    expect(text).toContain('差旅住宿标准')
    expect(text).toMatch(/北京\s*\|\s*每晚 600 元/)
    expect(text).toContain('备注：超标部分自理。')
  })

  it('works in the background worker used for uploads', async () => {
    const text = await extractDocumentTextInWorker(fixture('zh-slides.pptx'), '.pptx')
    expect(text).toContain('差旅住宿标准')
  })
})
