#!/usr/bin/env node
/**
 * MCP 标准输入输出 (stdio) 传输模式运行入口
 *
 * 核心功能与使用场景：
 * 1. 供本地宿主客户端（如 Claude Code CLI, Claude Desktop, Cursor 等）通过子进程方式唤起；
 * 2. 命令行与环境变量双重传参支持：
 *    - `--api-key=ekb_...` 或 `MCP_API_KEY` 环境变量（必填）
 *    - `--kb-id=N` 限制只访问指定知识库（可选）
 * 3. 密钥校验：通过前 8 字符快速检索候选记录，再执行 bcrypt 安全哈希校验；
 * 4. 传输通道隔离：所有运行日志与错误均严格定向输出到 `stderr`，确保 `stdout` 纯净用于 JSON-RPC 消息通信。
 *
 * 典型配置示例 (.mcp.json)：
 * ```json
 * {
 *   "mcpServers": {
 *     "enterprise-kb": {
 *       "command": "node",
 *       "args": ["H:/enterprise-kb/dist/mcp-stdio.js", "--kb-id=1"],
 *       "env": { "MCP_API_KEY": "ekb_xxxxxxxxxxxxxxxxxxxx" }
 *     }
 *   }
 * }
 * ```
 */

import 'dotenv/config'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import bcrypt from 'bcryptjs'
import {
  initDb, getUserById, getKbById,
  getMcpApiKeysByPrefix, touchMcpApiKey,
} from './db.js'
import { createMcpServer, type McpContext } from './mcp-server.js'
import * as path from 'node:path'

// 初始化底层 SQLite 数据库连接
const DB_PATH = path.resolve(process.env.DB_PATH ?? 'data/enterprise-kb.db')
initDb(DB_PATH)

// 解析命令行长参数（如 --kb-id=3 --api-key=xxx）
const args: Record<string, string> = {}
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--')) {
    const [k, ...v] = arg.slice(2).split('=')
    args[k] = v.join('=')
  }
}

const kbIdArg = args['kb-id'] ? Number(args['kb-id']) : undefined
const apiKey  = args['api-key'] ?? process.env.MCP_API_KEY ?? ''

// 必填参数校验：未提供 API Key 时退出
if (!apiKey) {
  process.stderr.write('[mcp-stdio] 错误：未提供 API Key，请设置 --api-key=xxx 或环境变量 MCP_API_KEY\n')
  process.exit(1)
}

// 凭证校验：先根据前缀索引提取候选密钥，再调用 bcrypt 进行抗时序攻击的安全哈希比对
const prefix = apiKey.slice(0, 8)
const candidates = getMcpApiKeysByPrefix(prefix)
const matchedKey = candidates.find(k => bcrypt.compareSync(apiKey, k.key_hash))

if (!matchedKey) {
  process.stderr.write('[mcp-stdio] 错误：API Key 无效\n')
  process.exit(1)
}

// 关联账户有效性检查
const user = getUserById(matchedKey.user_id)
if (!user) {
  process.stderr.write('[mcp-stdio] 错误：关联用户不存在\n')
  process.exit(1)
}

// 更新该密钥的最后使用时间戳
touchMcpApiKey(matchedKey.id)

// 解析该 API Key 所绑定的知识库范围
const keyKbIds: number[] = JSON.parse(matchedKey.kb_ids || '[]')

// 若启动参数显式指定了 --kb-id，则验证授权后收敛至单知识库沙箱
let allowedKbIds: number[]
if (kbIdArg) {
  if (keyKbIds.length > 0 && !keyKbIds.includes(kbIdArg)) {
    process.stderr.write(`[mcp-stdio] 错误：API Key 无权访问知识库 ${kbIdArg}\n`)
    process.exit(1)
  }
  const kb = getKbById(kbIdArg)
  if (!kb) {
    process.stderr.write(`[mcp-stdio] 错误：知识库 ${kbIdArg} 不存在\n`)
    process.exit(1)
  }
  allowedKbIds = [kbIdArg]
} else {
  allowedKbIds = keyKbIds
}

// 组装运行时 MCP 鉴权上下文
const ctx: McpContext = {
  userId:   user.id,
  username: user.username,
  role:     user.role,
  kbIds:    allowedKbIds,
}

// 实例化 MCP 服务端并绑定 stdio 标准传输流
const mcpServer = createMcpServer(ctx)
const transport = new StdioServerTransport()
await mcpServer.connect(transport)

// 向 stderr 打印就绪状态日志，不干扰 stdout 的 JSON-RPC 数据通信
process.stderr.write(
  `[mcp-stdio] 已启动 | 用户: ${user.username} | KB范围: ${allowedKbIds.length ? allowedKbIds.join(',') : '全部可访问'}\n`
)
