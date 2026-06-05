# claude-tools-kit

从 Claude Code 源码提取的独立工具包，可直接在你的项目中使用。

提供 7 个内置工具 + `buildTool` 工厂 + `ClaudeExecutor` 执行器。

---

## 安装

```bash
npm install claude-tools-kit
# 或
bun add claude-tools-kit
```

---

## 快速开始

```typescript
import { ClaudeExecutor, ALL_TOOLS } from 'claude-tools-kit'

const executor = new ClaudeExecutor({
  // apiKey: 'sk-ant-...',  // 或设置环境变量 ANTHROPIC_API_KEY
  model: 'claude-sonnet-4-6',
  toolContext: {
    cwd: process.cwd(),
    permissionMode: 'dontAsk',
  },
})

const result = await executor.run(
  '列出当前目录所有 .ts 文件',
  ALL_TOOLS,
)

console.log(result.response)
```

---

## 内置工具

| 工具 | 名称 | 说明 |
|------|------|------|
| `BashTool` | `Bash` | 执行 Shell 命令 |
| `FileReadTool` | `Read` | 读取文件（带行号，支持分页） |
| `FileWriteTool` | `Write` | 写入文件（自动创建目录） |
| `FileEditTool` | `Edit` | 精确字符串替换 |
| `GlobTool` | `Glob` | 文件名模式匹配 |
| `GrepTool` | `Grep` | 正则表达式文件内容搜索 |
| `WebFetchTool` | `WebFetch` | 获取网页/API 内容 |

### 工具集合

```typescript
import { ALL_TOOLS, READ_ONLY_TOOLS } from 'claude-tools-kit'

// ALL_TOOLS       — 全部 7 个工具
// READ_ONLY_TOOLS — 只读工具（Read, Glob, Grep, WebFetch）
```

---

## ClaudeExecutor

```typescript
import { ClaudeExecutor } from 'claude-tools-kit'

const executor = new ClaudeExecutor({
  apiKey: 'sk-ant-...',      // 默认读取 ANTHROPIC_API_KEY
  model: 'claude-sonnet-4-6', // 默认 claude-sonnet-4-6
  systemPrompt: '你是一个代码助手',
  maxTurns: 50,              // 最大工具调用轮次（默认 50）
  
  toolContext: {
    cwd: '/my/project',       // 工作目录
    permissionMode: 'dontAsk', // 权限模式（见下方）
    allowedDirectories: ['/extra/dir'],  // 额外允许访问的目录
    onPermissionRequest: async (toolName, message) => {
      // permissionMode === 'default' 时触发
      console.log(`[确认] ${toolName}: ${message}`)
      return true  // true=允许, false=拒绝
    },
  },
  
  onTurn: (event) => {
    // 实时回调
    if (event.type === 'text')        process.stdout.write(event.text)
    if (event.type === 'tool_call')   console.log('调用:', event.name, event.input)
    if (event.type === 'tool_result') console.log('结果:', event.output)
  },
})

// 单次运行
const result = await executor.run('帮我...',  tools)

// 多轮对话
const r1 = await executor.run('第一个问题', tools)
const r2 = await executor.run('接着上面...', tools, r1.messages)
```

### 权限模式

| 模式 | 行为 |
|------|------|
| `default` | 调用 `onPermissionRequest` 回调 |
| `acceptEdits` | 自动允许文件编辑，Bash 仍需确认 |
| `bypassPermissions` | 跳过所有权限检查 |
| `dontAsk` | 自动允许所有操作 |
| `plan` | 只读模式，拒绝所有写入操作 |

---

## 自定义工具

```typescript
import { buildTool, ClaudeExecutor } from 'claude-tools-kit'
import { z } from 'zod'

const MyTool = buildTool({
  name: 'MyTool',
  description: '工具的功能说明（Claude 根据此决定是否调用）',
  
  inputSchema: z.object({
    query: z.string().describe('查询参数'),
    limit: z.number().int().optional().describe('最大结果数'),
  }),
  
  isReadOnly: true,           // 不写入文件
  isConcurrencySafe: true,    // 可以并发调用
  
  async call(input, context) {
    // input 已经过 Zod 验证，类型安全
    const results = await myApiCall(input.query, input.limit ?? 10)
    return { data: results }
  },
  
  serializeResult(result) {
    // 将结果转为字符串，发回给 Claude
    return (result as string[]).join('\n')
  },
})

// 与内置工具混合使用
const executor = new ClaudeExecutor()
await executor.run('帮我查询...', [MyTool, FileReadTool, GlobTool])
```

---

## 便捷函数

```typescript
import { runWithClaude, ALL_TOOLS } from 'claude-tools-kit'

// 一行代码运行
const result = await runWithClaude('分析这个项目的结构', ALL_TOOLS, {
  toolContext: { cwd: '/my/project', permissionMode: 'dontAsk' },
})
console.log(result.response)
```

---

## 目录结构

```
claude-tools-kit/
├── src/
│   ├── index.ts          主入口（所有导出）
│   ├── types.ts          核心类型定义
│   ├── buildTool.ts      buildTool 工厂 + 权限解析
│   ├── executor.ts       ClaudeExecutor（工具循环）
│   ├── utils/
│   │   └── path.ts       路径工具函数
│   └── tools/
│       ├── bash.ts       BashTool
│       ├── read.ts       FileReadTool
│       ├── write.ts      FileWriteTool
│       ├── edit.ts       FileEditTool
│       ├── glob.ts       GlobTool
│       ├── grep.ts       GrepTool
│       ├── webfetch.ts   WebFetchTool
│       └── index.ts      工具集合导出
├── examples/
│   ├── basic.ts          基础示例
│   ├── custom-tool.ts    自定义工具示例
│   └── file-agent.ts     文件操作代理示例
├── package.json
└── tsconfig.json
```

---

## 构建

```bash
npm install
npm run build   # 编译到 dist/
npm run example # 运行基础示例
```

---

## 来源

核心逻辑提取自 [Claude Code](https://claude.ai/code) 源码：
- `Tool.ts` → `buildTool.ts` + `types.ts`
- `QueryEngine.ts` + `query.ts` → `executor.ts`
- `BashTool.tsx` → `tools/bash.ts`
- `FileReadTool.ts` → `tools/read.ts`
- `FileWriteTool.ts` → `tools/write.ts`
- `FileEditTool.ts` → `tools/edit.ts`
- `GlobTool.ts` → `tools/glob.ts`
- `GrepTool.ts` → `tools/grep.ts`
- `WebFetchTool.ts` → `tools/webfetch.ts`
