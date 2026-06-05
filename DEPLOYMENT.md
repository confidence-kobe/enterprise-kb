# Enterprise KB deployment checklist

## Requirements

- Node.js 20 or newer.
- A writable SQLite data directory.
- A writable document storage directory.
- An OpenAI-compatible LLM endpoint. For Ollama, use `http://localhost:11434/v1`.

## Configure

Copy `.env.example` to `.env` and set production values:

- `NODE_ENV=production` in the runtime environment.
- `JWT_SECRET`: random string, at least 32 characters.
- `ADMIN_PASSWORD`: non-default initial admin password.
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
- `STORAGE_PATH`, `DB_PATH`.
- `CORS_ORIGIN` only when the UI and API are served from different origins.

The server refuses to start in production when `JWT_SECRET` or `ADMIN_PASSWORD` still uses an example/default value.

## Verify Before Release

```bash
npm ci
npm run check
```

`npm run check` runs the TypeScript build, Vitest API tests, and production dependency audit.

## Start

```bash
npm start
```

The app serves the UI and API from the same Express server. Health endpoints:

- `GET /healthz`: process liveness.
- `GET /readyz`: process readiness plus LLM reachability.

## Docker

Build the image:

```bash
docker build -t enterprise-kb:local .
```

Run with Docker Compose:

```bash
JWT_SECRET="replace-with-a-random-string-at-least-32-chars" \
ADMIN_PASSWORD="replace-with-a-strong-admin-password" \
docker compose up --build
```

On Windows PowerShell:

```powershell
$env:JWT_SECRET="replace-with-a-random-string-at-least-32-chars"
$env:ADMIN_PASSWORD="replace-with-a-strong-admin-password"
docker compose up --build
```

The Compose file persists SQLite data and document storage in named volumes:

- `enterprise_kb_data`
- `enterprise_kb_storage`

## Operational Notes

- `data/`, `storage/`, `.env`, `node_modules/`, and `dist/` are intentionally ignored by git.
- `packages/claude-tools-kit` is vendored so deployment does not depend on a sibling directory outside this project.
- `npm ci` may warn about transitive maintenance notices from native/SDK dependencies. The release gate is `npm audit --omit=dev --audit-level=moderate`, which must remain clean.
- Review `SECURITY_OWNERSHIP.md` before production releases.
