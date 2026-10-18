/**
 * 启动时检查 Node.js 版本。作为入口文件的第一个 import，先于其他依赖执行，
 * 在旧版本上给出明确提示，而不是在运行中途因依赖（undici 8、openai 7）不兼容而出错。
 */

export const MIN_NODE_VERSION = '22.19.0'

export function isSupportedNodeVersion(version: string, min = MIN_NODE_VERSION): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const [a, b] = [parse(version), parse(min)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(`✗ 需要 Node.js ${MIN_NODE_VERSION} 或更高版本，当前为 ${process.versions.node}。请升级 Node.js 后再启动。`)
  process.exit(1)
}
