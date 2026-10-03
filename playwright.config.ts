import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT || 8095)
const LLM_PORT = Number(process.env.MOCK_LLM_PORT || 9919)

export const ADMIN_PASSWORD = 'E2e-admin-pass-1'

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/mock-llm.mjs',
      url: `http://127.0.0.1:${LLM_PORT}/v1/models`,
      env: { MOCK_LLM_PORT: String(LLM_PORT) },
      reuseExistingServer: false,
    },
    {
      // 需先 npm run build
      command: 'node e2e/start-server.mjs',
      url: `http://127.0.0.1:${PORT}/healthz`,
      reuseExistingServer: false,
      env: {
        PORT: String(PORT),
        NODE_ENV: 'test',
        JWT_SECRET: 'e2e-secret-that-is-at-least-32-characters',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD,
        LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
        LLM_API_KEY: 'mock',
        LLM_MODEL: 'mock',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    },
  ],
})
