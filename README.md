# Enterprise KB

Enterprise KB is a Node.js/TypeScript knowledge-base app with multi-user auth, SQLite storage, document management, and OpenAI-compatible LLM support.

## Stack

- Node.js 20+
- TypeScript
- Express 5
- SQLite via `better-sqlite3`
- Static frontend in `public/`
- OpenAI-compatible LLM endpoint support

## Quick Start

Install dependencies:

```bash
npm ci
```

Create local configuration:

```bash
cp .env.example .env
```

Start in development:

```bash
npm run dev
```

The app defaults to:

```text
http://localhost:8080
```

If port `8080` is occupied on Windows PowerShell:

```powershell
$env:PORT="8081"
npm run dev
```

## Scripts

```bash
npm run build
npm run test
npm run check
npm run codex:smoke
npm start
```

- `npm run build`: compile TypeScript to `dist/`.
- `npm run test`: run Vitest API tests.
- `npm run check`: build, test, then run production dependency audit.
- `npm run codex:smoke`: check the running app health endpoints.
- `npm start`: run `dist/server.js`.

For smoke checks against a non-default port:

```powershell
$env:CODEX_APP_URL="http://localhost:8081"
npm run codex:smoke
```

## Environment

Use `.env.example` as the template. Important variables:

- `PORT`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `STORAGE_PATH`
- `DB_PATH`
- `CORS_ORIGIN`
- `TRUST_PROXY`

Production refuses weak/default `JWT_SECRET` and `ADMIN_PASSWORD` values.

## Docker

Build the image:

```bash
docker build -t enterprise-kb:local .
```

Run with Compose:

```powershell
$env:JWT_SECRET="replace-with-a-random-string-at-least-32-chars"
$env:ADMIN_PASSWORD="replace-with-a-strong-admin-password"
docker compose up --build
```

The Compose setup persists SQLite data and uploaded documents in Docker volumes.

## CI

GitHub Actions CI is defined in:

```text
.github/workflows/ci.yml
```

It runs:

```bash
npm ci
npm run check
```

## Release

See [RELEASE.md](RELEASE.md) for the tag-based release process and artifact contents.

## Security

See [SECURITY_OWNERSHIP.md](SECURITY_OWNERSHIP.md) for the security ownership map.

Key rules:

- Never commit `.env`.
- Keep `JWT_SECRET` and `ADMIN_PASSWORD` strong in production.
- Preserve auth checks around `requireAuth`, `requireAdmin`, and KB access checks.
- Treat `data/` and `storage/` as sensitive runtime state.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the release checklist.
