const baseUrl = (process.env.CODEX_APP_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '')

const checks = [
  { path: '/', required: true },
  { path: '/healthz', required: true },
  { path: '/readyz', required: false },
]

let failed = false

for (const check of checks) {
  const url = `${baseUrl}${check.path}`

  try {
    const response = await fetch(url)
    const ok = response.ok
    const status = `${response.status} ${response.statusText}`.trim()

    if (!ok && check.required) {
      failed = true
      console.error(`[fail] ${url} -> ${status}`)
      continue
    }

    const label = ok ? 'ok' : 'warn'
    console.log(`[${label}] ${url} -> ${status}`)
  } catch (error) {
    if (check.required) {
      failed = true
      console.error(`[fail] ${url} -> ${(error instanceof Error && error.message) || String(error)}`)
    } else {
      console.warn(`[warn] ${url} -> ${(error instanceof Error && error.message) || String(error)}`)
    }
  }
}

if (failed) {
  process.exitCode = 1
}
