/**
 * 问答质量评测：用一批标准问题真实地问一遍知识库，给回答打分。
 *
 *   npm run eval:qa
 *   npm run eval:qa -- --baseline eval/results/上次.json   # 和上次对比，退步则退出码为 1
 *   npm run eval:qa -- --min 90                            # 通过率低于 90% 则退出码为 1
 *   npm run eval:qa -- --only leave-annual-days            # 只跑某一题（可重复）
 *
 * 需要先启动服务（npm run dev 或 npm start），并设置 ADMIN_PASSWORD（可放在 .env 里）。
 * 会调用真实的大模型，所以会产生费用，也不会放进 npm run check。
 * 脚本会临时建一个知识库，把 eval/docs 里的示例制度传进去，跑完自动删除，不影响你的真实数据。
 *
 * 想用自己的文档评测：把 --docs 和 --cases 指向你自己的目录和题目文件，格式见 eval/README.md。
 */

import 'dotenv/config'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseSse, extractAnswer, scoreCase, summarize, compareWithBaseline, formatPercent,
} from './evalLib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const opts = { docs: path.join(root, 'eval/docs'), cases: path.join(root, 'eval/cases.json'), only: [], keep: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--docs') opts.docs = path.resolve(next())
    else if (arg === '--cases') opts.cases = path.resolve(next())
    else if (arg === '--out') opts.out = path.resolve(next())
    else if (arg === '--baseline') opts.baseline = path.resolve(next())
    else if (arg === '--min') opts.min = Number(next())
    else if (arg === '--only') opts.only.push(next())
    else if (arg === '--keep') opts.keep = true
    else throw new Error(`不认识的参数：${arg}`)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const base = process.env.CODEX_APP_URL ?? `http://127.0.0.1:${process.env.PORT || 8080}`
const adminPassword = process.env.ADMIN_PASSWORD
if (!adminPassword) throw new Error('需要设置 ADMIN_PASSWORD（可以写在 .env 里）')

async function api(urlPath, { method = 'GET', token, body, timeout = 30_000 } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let data = text
  try { data = text ? JSON.parse(text) : null } catch { /* 问答接口返回的是事件流，不是 JSON */ }
  return { status: response.status, data }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 问一个问题；遇到限速（429）就等一个窗口再试，最多重试 3 次 */
async function ask(token, kbId, question) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { status, data } = await api(`/api/kbs/${kbId}/ask`, {
      method: 'POST', token, body: { question, conversationId: null }, timeout: 180_000,
    })
    if (status === 429) {
      console.log('  遇到提问限速，等待 61 秒后重试…')
      await sleep(61_000)
      continue
    }
    if (status !== 200) return { answer: '', error: `HTTP ${status}：${JSON.stringify(data).slice(0, 200)}` }
    const events = parseSse(data)
    const failure = events.find(event => event.type === 'error')
    if (failure) return { answer: '', error: failure.message }
    return { answer: extractAnswer(events), turns: events.findLast(event => event.type === 'done')?.turns }
  }
  return { answer: '', error: '一直被限速，放弃' }
}

const { cases: allCases, kbName } = JSON.parse(fs.readFileSync(opts.cases, 'utf-8'))
const cases = opts.only.length ? allCases.filter(c => opts.only.includes(c.id)) : allCases
if (!cases.length) throw new Error('没有要跑的题目')

const login = await api('/api/auth/login', {
  method: 'POST', body: { username: process.env.ADMIN_USERNAME ?? 'admin', password: adminPassword },
})
if (login.status !== 200) throw new Error(`登录失败：HTTP ${login.status}`)
const token = login.data.token

const config = (await api('/api/config')).data ?? {}
const created = await api('/api/kbs', {
  method: 'POST', token, body: { name: `${kbName ?? '评测用知识库'}-${Date.now().toString(36)}`, description: '问答评测临时创建，会自动删除' },
})
if (created.status !== 201) throw new Error(`创建知识库失败：HTTP ${created.status}`)
const kbId = created.data.id

const results = []
try {
  const files = fs.readdirSync(opts.docs).filter(name => name.endsWith('.md')).sort()
  for (const file of files) {
    const content = fs.readFileSync(path.join(opts.docs, file), 'utf-8')
    const res = await api(`/api/kbs/${kbId}/docs/text`, { method: 'POST', token, body: { title: file, content } })
    if (res.status !== 201) throw new Error(`上传 ${file} 失败：HTTP ${res.status}`)
  }
  console.log(`模型：${config.model ?? '未知'}　向量检索：${config.embeddingEnabled ? '开' : '关'}　文档 ${files.length} 份，题目 ${cases.length} 道\n`)

  for (const testCase of cases) {
    const started = Date.now()
    const { answer, error, turns } = await ask(token, kbId, testCase.question)
    const scored = error ? { pass: false, problems: [`调用失败：${error}`] } : scoreCase(testCase, answer)
    results.push({
      id: testCase.id, kind: testCase.kind, question: testCase.question,
      pass: scored.pass, problems: scored.problems, answer, turns, ms: Date.now() - started,
    })
    console.log(`${scored.pass ? '✓' : '✗'} ${testCase.id}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`)
    for (const problem of scored.problems) console.log(`    ${problem}`)
  }
} finally {
  if (opts.keep) console.log(`\n评测知识库已保留（id=${kbId}）`)
  else await api(`/api/kbs/${kbId}`, { method: 'DELETE', token }).catch(() => {})
}

const summary = summarize(results)
console.log(`\n通过 ${summary.passed}/${summary.total}（${formatPercent(summary.passRate)}）`
  + `　有答案的题 ${formatPercent(summary.answerRate)}　该拒答的题 ${formatPercent(summary.refuseRate)}`)

const outFile = opts.out ?? path.join(root, 'eval/results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify({
  at: new Date().toISOString(), model: config.model, embedding: config.embeddingModel ?? null, summary, results,
}, null, 2))
console.log(`详细结果：${path.relative(root, outFile)}`)

let failed = false
if (opts.baseline) {
  const baseline = JSON.parse(fs.readFileSync(opts.baseline, 'utf-8'))
  const { regressions, fixed } = compareWithBaseline(results, baseline.results)
  if (fixed.length) console.log(`比上次修好：${fixed.join('、')}`)
  if (regressions.length) { console.log(`比上次退步：${regressions.join('、')}`); failed = true }
  else console.log('没有比上次退步的题')
}
if (opts.min != null && (summary.passRate ?? 0) * 100 < opts.min) {
  console.log(`通过率低于要求的 ${opts.min}%`)
  failed = true
}
process.exit(failed ? 1 : 0)
