/**
 * 端到端测试用的 OpenAI 兼容模型（流式）。
 * 问题里含"补贴"时回答"未找到相关内容"，用于知识空白测试；其他问题给出固定回答。
 */
import http from 'node:http'

const port = Number(process.env.MOCK_LLM_PORT || 9919)
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'mock', data: [{ id: 'mock' }] }))
      return
    }
    const messages = JSON.parse(body || '{}').messages ?? []
    const question = String(messages[messages.length - 1]?.content ?? '')
    const answer = question.includes('补贴') ? '抱歉，知识库中未找到相关内容。' : '年假为每年 10 天。'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunk({ content: answer }))
    res.write(chunk({}, 'stop'))
    res.end('data: [DONE]\n\n')
  })
}).listen(port, '127.0.0.1', () => console.log(`[mock-llm] http://127.0.0.1:${port}`))
