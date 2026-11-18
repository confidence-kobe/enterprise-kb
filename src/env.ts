/**
 * 读取环境变量的小工具。服务入口和限速等模块共用。
 */

/** 读取环境变量，空字符串视为没有设置；aliases 兼容早期版本的 OLLAMA_* 变量名 */
export function envValue(primary: string, ...aliases: string[]): string | undefined {
  for (const key of [primary, ...aliases]) {
    const val = process.env[key]?.trim()
    if (val) return val
  }
  return undefined
}

export function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 必须是正整数。`)
  return n
}
