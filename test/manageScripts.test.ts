/**
 * 管理控制台前端脚本（public/manage/*.js）的结构检查。
 * 这些脚本是普通 <script>，按 manage.html 里的顺序依次加载、共享同一个全局作用域，
 * 没有构建步骤，写错了只有打开页面才发现。这里把几条最容易踩的规则固定下来。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const publicDir = path.resolve(__dirname, '../public')
const html = fs.readFileSync(path.join(publicDir, 'manage.html'), 'utf-8')
const scripts = [...html.matchAll(/<script src="(manage\/[\w-]+\.js)\?v=(\d+)"><\/script>/g)].map(m => ({ file: m[1], version: m[2] }))
const read = (file: string) => fs.readFileSync(path.join(publicDir, file), 'utf-8')

describe('管理控制台脚本', () => {
  it('manage.html 加载的脚本都存在，init.js 最后加载，core.js 最先加载', () => {
    expect(scripts.length).toBeGreaterThan(5)
    for (const s of scripts) expect(fs.existsSync(path.join(publicDir, s.file)), s.file).toBe(true)
    expect(scripts[0].file).toBe('manage/core.js')
    expect(scripts.at(-1)!.file).toBe('manage/init.js')
    // public/manage/ 下的每个脚本都被页面加载了，没有漏掉的
    const onDisk = fs.readdirSync(path.join(publicDir, 'manage')).filter(f => f.endsWith('.js')).map(f => `manage/${f}`).sort()
    expect(scripts.map(s => s.file).sort()).toEqual(onDisk)
  })

  it('所有脚本的版本号一致（改了任何一个文件，要把它们一起加一）', () => {
    expect(new Set(scripts.map(s => s.version)).size).toBe(1)
  })

  it('按加载顺序拼起来能解析：没有语法错误，也没有跨文件重复声明', () => {
    const all = scripts.map(s => read(s.file)).join('\n')
    expect(() => new vm.Script(all, { filename: 'manage-all.js' })).not.toThrow()
  })

  it('除 core.js 和 init.js 外，各文件顶层只有声明，没有加载时就执行的语句', () => {
    // 顶层（不缩进）的行只能是：注释、function/const/let 声明，或者上一条语句的收尾括号
    const allowed = /^(\/\*|\/\/| \*|\*\/|async function |function |const |let |[})\]`])/
    for (const s of scripts) {
      if (/\/(core|init)\.js$/.test(s.file)) continue
      const bad = read(s.file).split('\n').map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.length > 0 && !/^\s/.test(line) && !allowed.test(line))
      expect(bad.map(b => `${s.file}:${b.n} ${b.line.slice(0, 60)}`), `${s.file} 顶层不要写会立刻执行的语句，放到 init.js`).toEqual([])
    }
  })
})
