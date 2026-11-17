/**
 * 问答评测的纯函数部分：解析回答、给单题打分、汇总、和上一次结果对比。
 * 不依赖网络和数据库，所以可以在自动测试里直接验证打分规则本身是对的。
 */

/** 和服务端 src/db.ts 里的 NOT_FOUND_MARKER 保持一致：模型回答"没找到"时必须包含这句 */
export const NOT_FOUND_MARKER = '未找到相关内容'

/** 比对前统一格式：去掉空白和 Markdown 标记，"5 天"、"**5** 天"、"5天"都当成同一个 */
export function normalize(text) {
  return String(text ?? '').replace(/[\s*`_]/g, '').toLowerCase()
}

/** 把 /ask 返回的 SSE 文本拆成事件列表 */
export function parseSse(raw) {
  return String(raw)
    .split('\n\n')
    .filter(part => part.startsWith('data: '))
    .map(part => {
      try { return JSON.parse(part.slice(6)) } catch { return null }
    })
    .filter(Boolean)
}

/** 取出模型最终说给用户的话（去掉 <think> 思考内容） */
export function extractAnswer(events) {
  return events
    .filter(event => event.type === 'text')
    .map(event => event.text)
    .join('')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
}

/** 来源引用用的是不带扩展名的文件名，如「请假制度」 */
function sourceStem(name) {
  return name.replace(/\.[^.]+$/, '')
}

/**
 * 给一道题打分。
 *   answer 题：expect 的每一组里至少命中一个说法（说法之间是"或"，组之间是"且"），
 *             reject 里的任何说法都不能出现，sources 里每份文档都要被引用。
 *   refuse 题：知识库里确实没有答案，必须明确说"未找到相关内容"，不能编。
 * 返回 { pass, problems }，problems 是给人看的失败原因。
 */
export function scoreCase(testCase, answer) {
  const text = normalize(answer)
  const problems = []

  if (!text) return { pass: false, problems: ['没有收到回答'] }

  if (testCase.kind === 'refuse') {
    if (!text.includes(normalize(NOT_FOUND_MARKER))) problems.push('知识库里没有答案，却没有说"未找到相关内容"（可能在编造）')
  } else {
    for (const group of testCase.expect ?? []) {
      if (!group.some(alt => text.includes(normalize(alt)))) problems.push(`缺少：${group.join(' / ')}`)
    }
    for (const bad of testCase.reject ?? []) {
      if (text.includes(normalize(bad))) problems.push(`不该出现：${bad}`)
    }
    for (const source of testCase.sources ?? []) {
      if (!text.includes(normalize(sourceStem(source)))) problems.push(`没有标注来源：${source}`)
    }
  }
  return { pass: problems.length === 0, problems }
}

/** 汇总：总通过率，以及"有答案的题"和"该拒答的题"各自的通过率 */
export function summarize(results) {
  const rate = list => (list.length ? list.filter(r => r.pass).length / list.length : null)
  return {
    total: results.length,
    passed: results.filter(r => r.pass).length,
    passRate: rate(results),
    answerRate: rate(results.filter(r => r.kind === 'answer')),
    refuseRate: rate(results.filter(r => r.kind === 'refuse')),
  }
}

/** 和上一次结果对比：上次对、这次错的是"退步"，上次错、这次对的是"修好" */
export function compareWithBaseline(current, baseline) {
  const before = new Map(baseline.map(r => [r.id, r.pass]))
  return {
    regressions: current.filter(r => !r.pass && before.get(r.id) === true).map(r => r.id),
    fixed: current.filter(r => r.pass && before.get(r.id) === false).map(r => r.id),
  }
}

export function formatPercent(value) {
  return value == null ? '—' : `${Math.round(value * 100)}%`
}
