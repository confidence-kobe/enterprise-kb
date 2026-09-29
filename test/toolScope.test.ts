import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALL_TOOLS, isWithinDirs, scopeForKbPath } from '../src/tools.js'
import type { ToolScope } from '../src/tools.js'

let root: string
let kbA: string
let kbB: string
let secret: string
let scope: ToolScope

const tool = (name: string) => {
  const t = ALL_TOOLS.find(t => t.definition.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-scope-'))
  kbA = path.join(root, 'kb_1')
  kbB = path.join(root, 'kb_2')
  secret = path.join(root, 'kb_3')
  for (const dir of [kbA, kbB, secret]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(kbA, 'a.md'), 'alpha handbook\n')
  fs.writeFileSync(path.join(kbB, 'b.md'), 'bravo handbook\n')
  fs.writeFileSync(path.join(secret, 'salary.md'), 'confidential salaries\n')
  scope = { cwd: kbA, allowedDirs: [kbA, kbB], kbIds: [1, 2] }
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('isWithinDirs', () => {
  it('accepts the directory itself and its children only', () => {
    expect(isWithinDirs(kbA, [kbA])).toBe(true)
    expect(isWithinDirs(path.join(kbA, 'x', 'y.md'), [kbA])).toBe(true)
    expect(isWithinDirs(path.join(kbA, '..', 'kb_3'), [kbA])).toBe(false)
    expect(isWithinDirs(`${kbA}-evil`, [kbA])).toBe(false)
  })
})

describe('scopeForKbPath', () => {
  it('derives the KB id from kb_<id> directories', () => {
    expect(scopeForKbPath('/data/kb_7')).toEqual({ cwd: '/data/kb_7', allowedDirs: ['/data/kb_7'], kbIds: [7] })
    expect(scopeForKbPath('/tmp').kbIds).toEqual([])
    expect(scopeForKbPath('/data/whatever', 9).kbIds).toEqual([9])
  })
})

describe('tools honour the scope', () => {
  it('reads files from every allowed knowledge base', async () => {
    expect(await tool('Read').execute({ file_path: path.join(kbA, 'a.md') }, scope)).toContain('alpha handbook')
    expect(await tool('Read').execute({ file_path: path.join(kbB, 'b.md') }, scope)).toContain('bravo handbook')
  })

  it('refuses files outside the allowed knowledge bases', async () => {
    await expect(tool('Read').execute({ file_path: path.join(secret, 'salary.md') }, scope)).rejects.toThrow()
    await expect(tool('Read').execute({ file_path: path.join(kbA, '..', 'kb_3', 'salary.md') }, scope)).rejects.toThrow('只能访问')
    await expect(tool('Read').execute({ file_path: '../kb_3/salary.md' }, scope)).rejects.toThrow('只能访问')
  })

  it('blocks Grep and Glob from searching outside the scope', async () => {
    await expect(tool('Grep').execute({ pattern: 'confidential', path: secret }, scope)).rejects.toThrow('只能访问')
    await expect(tool('Grep').execute({ pattern: 'confidential', path: '..' }, scope)).rejects.toThrow('只能访问')
    await expect(tool('Glob').execute({ pattern: '*', path: root }, scope)).rejects.toThrow('只能访问')
    await expect(tool('Glob').execute({ pattern: '../kb_3/*' }, scope)).rejects.toThrow('只能访问')
    await expect(tool('Glob').execute({ pattern: `${secret}/*` }, scope)).rejects.toThrow('只能访问')
    // 范围内的搜索照常工作
    expect(await tool('Grep').execute({ pattern: 'bravo', path: kbB }, scope)).toContain('b.md')
    expect(await tool('Glob').execute({ pattern: '*.md' }, scope)).toContain('a.md')
  })

  it('does not follow symlinks out of a knowledge base', async () => {
    const link = path.join(kbA, 'escape')
    fs.symlinkSync(secret, link)
    try {
      await expect(tool('Read').execute({ file_path: path.join(link, 'salary.md') }, scope)).rejects.toThrow('只能访问')
      await expect(tool('Grep').execute({ pattern: 'confidential', path: link }, scope)).rejects.toThrow('只能访问')
    } finally {
      fs.unlinkSync(link)
    }
  })

  it('treats a sibling directory with a shared prefix as outside', async () => {
    const evil = `${kbA}-evil`
    fs.mkdirSync(evil)
    fs.writeFileSync(path.join(evil, 'x.md'), 'nope\n')
    await expect(tool('Read').execute({ file_path: path.join(evil, 'x.md') }, scope)).rejects.toThrow('只能访问')
  })

  it('keeps KBStats inside the allowed directories', async () => {
    const all = await tool('KBStats').execute({}, scope)
    expect(all).toMatch(/文件总数：2/)
    await expect(tool('KBStats').execute({ dir: '../kb_3' }, scope)).rejects.toThrow('只能统计知识库目录内的文件')
    await expect(tool('KBStats').execute({ dir: '..' }, scope)).rejects.toThrow()
  })
})
