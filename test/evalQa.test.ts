/**
 * 问答评测集的自检：不调用大模型，只保证评测集本身是对的——
 * 每道题都能在示例文档里找到依据、该拒答的题确实没有依据、打分规则按预期工作。
 * 评测集写错了，评测报告就会冤枉模型（或者放过它），所以这里要卡住。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error 纯 JS 模块，没有类型声明
import * as lib from '../scripts/evalLib.mjs'

interface EvalCase {
  id: string
  kind: 'answer' | 'refuse'
  question: string
  expect?: string[][]
  reject?: string[]
  sources?: string[]
}

const root = path.resolve(__dirname, '..')
const { cases } = JSON.parse(fs.readFileSync(path.join(root, 'eval/cases.json'), 'utf-8')) as { cases: EvalCase[] }
const docs = new Map(
  fs.readdirSync(path.join(root, 'eval/docs'))
    .filter(name => name.endsWith('.md'))
    .map(name => [name, lib.normalize(fs.readFileSync(path.join(root, 'eval/docs', name), 'utf-8'))] as const),
)

describe('评测集自检', () => {
  it('题目编号不重复，类型合法', () => {
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
    for (const c of cases) expect(['answer', 'refuse']).toContain(c.kind)
  })

  it('有答案的题：引用的文档存在，要求的说法都能在这些文档里找到', () => {
    const answerable = cases.filter(c => c.kind === 'answer')
    expect(answerable.length).toBeGreaterThanOrEqual(20)
    for (const c of answerable) {
      expect(c.sources?.length, `${c.id} 没写 sources`).toBeGreaterThan(0)
      for (const source of c.sources!) expect(docs.has(source), `${c.id}：找不到文档 ${source}`).toBe(true)
      const text = c.sources!.map(s => docs.get(s)!).join('')
      for (const group of c.expect ?? []) {
        // 不要求每个说法都出现在原文里（"不能"这类是模型的措辞），但至少一个要有，否则这题根本答不出来
        const anchored = group.some(alt => text.includes(lib.normalize(alt)))
        const wording = group.every(alt => /^[一-龥]{1,4}$/.test(alt))
        expect(anchored || wording, `${c.id}：文档里找不到 ${group.join('/')}`).toBe(true)
      }
    }
  })

  it('该拒答的题：全部示例文档里确实没有相关内容', () => {
    const keywords: Record<string, string> = {
      'none-canteen': '食堂', 'none-overtime': '加班费', 'none-bonus': '年终奖',
      'none-remote': '居家', 'none-equity': '股权',
    }
    const refusals = cases.filter(c => c.kind === 'refuse')
    expect(refusals.length).toBeGreaterThanOrEqual(5)
    const all = [...docs.values()].join('')
    for (const c of refusals) {
      const key = keywords[c.id]
      expect(key, `${c.id} 没登记关键词，请在这里补上`).toBeTruthy()
      expect(all.includes(key), `${c.id}：文档里其实有"${key}"`).toBe(false)
    }
  })

  it('拒答标记和服务端一致', () => {
    const db = fs.readFileSync(path.join(root, 'src/db.ts'), 'utf-8')
    expect(db).toContain(`NOT_FOUND_MARKER = '${lib.NOT_FOUND_MARKER}'`)
  })
})

describe('打分规则', () => {
  const answerCase: EvalCase = {
    id: 'x', kind: 'answer', question: '?', expect: [['5 天', '五天'], ['财务经理']], reject: ['10 天'], sources: ['请假制度.md'],
  }

  it('空格、加粗标记不影响比对', () => {
    const r = lib.scoreCase(answerCase, '根据 `请假制度.md:3`，每年 **5** 天，需财务 经理 审批。')
    expect(r.pass).toBe(true)
  })

  it('缺少要点、出现禁词、没标来源都会失败并说明原因', () => {
    expect(lib.scoreCase(answerCase, '每年 5 天（请假制度.md:3）').problems).toEqual(['缺少：财务经理'])
    expect(lib.scoreCase(answerCase, '5 天，财务经理，也有人说 10 天（请假制度.md:3）').problems).toEqual(['不该出现：10 天'])
    expect(lib.scoreCase(answerCase, '5 天，财务经理').problems).toEqual(['没有标注来源：请假制度.md'])
    expect(lib.scoreCase(answerCase, '').pass).toBe(false)
  })

  it('拒答题：说了"未找到相关内容"才算对，编一个答案算错', () => {
    const refuse: EvalCase = { id: 'r', kind: 'refuse', question: '?' }
    expect(lib.scoreCase(refuse, '抱歉，知识库中未找到相关内容。').pass).toBe(true)
    expect(lib.scoreCase(refuse, '食堂补贴每天 20 元。').pass).toBe(false)
  })

  it('解析事件流并去掉思考内容', () => {
    const raw = [
      'data: {"type":"tool_call","name":"SearchDocs"}',
      'data: {"type":"text","text":"<think>先想想</think>年假"}',
      'data: {"type":"text","text":" 5 天"}',
      ': keepalive',
      'data: {"type":"done","turns":2}',
    ].join('\n\n') + '\n\n'
    const events = lib.parseSse(raw)
    expect(events).toHaveLength(4)
    expect(lib.extractAnswer(events)).toBe('年假 5 天')
  })

  it('汇总和对比上次结果', () => {
    const now = [
      { id: 'a', kind: 'answer', pass: true }, { id: 'b', kind: 'answer', pass: false },
      { id: 'c', kind: 'refuse', pass: true }, { id: 'd', kind: 'refuse', pass: true },
    ]
    const summary = lib.summarize(now)
    expect(summary).toMatchObject({ total: 4, passed: 3, passRate: 0.75, answerRate: 0.5, refuseRate: 1 })
    const before = [
      { id: 'a', pass: false }, { id: 'b', pass: true }, { id: 'c', pass: true },
    ]
    expect(lib.compareWithBaseline(now, before)).toEqual({ regressions: ['b'], fixed: ['a'] })
  })
})
