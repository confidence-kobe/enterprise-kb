# AGENTS.md

## Project Overview

This repository is `enterprise-kb`, a Node.js/TypeScript enterprise knowledge-base app.

- Runtime: Node.js 20+
- Server: Express 5
- Database: SQLite via `better-sqlite3`
- UI: static files in `public/`
- Source: TypeScript in `src/`
- Build output: `dist/`
- Local packages: `packages/claude-tools-kit`

## Important Commands

Use these commands from the repository root:

```bash
npm run dev
npm run build
npm run test
npm run check
npm run codex:smoke
npm start
```

Command meanings:

- `npm run dev`: run the TypeScript server with `tsx`.
- `npm run build`: compile TypeScript into `dist/`.
- `npm run test`: run Vitest API tests.
- `npm run check`: run TypeScript build, Vitest tests, and production dependency audit.
- `npm run codex:smoke`: verify a running app's homepage and health endpoints.
- `npm start`: run the built server from `dist/server.js`.

## Local App

The app defaults to:

```text
http://localhost:8080
```

If port `8080` is occupied, run the app with another port:

```powershell
$env:PORT="8081"; npm run dev
```

Health endpoints:

```text
GET /healthz
GET /readyz
```

The app serves both API and static UI from the same Express server.

## Environment

Use `.env.example` as the template for `.env`.

Key variables:

- `PORT`
- `JWT_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `STORAGE_PATH`
- `DB_PATH`
- `CORS_ORIGIN`
- `TRUST_PROXY`

Production must not use default/example `JWT_SECRET` or `ADMIN_PASSWORD`.

## Files And Directories

Prefer editing:

- `src/`
- `public/`
- `packages/claude-tools-kit/`
- `.env.example`
- `DEPLOYMENT.md`
- `README.md`
- `SECURITY_OWNERSHIP.md`
- `Dockerfile`
- `docker-compose.yml`
- `.github/pull_request_template.md`
- `.github/dependabot.yml`
- `CODEOWNERS`
- `package.json`
- `tsconfig.json`

Avoid manual edits unless explicitly required:

- `dist/` unless rebuilding generated output is part of the task
- `node_modules/`
- `data/`
- `storage/`
- `.env` secrets
- `server.log`

## Validation Rules

Before finishing code changes, run the smallest useful validation:

```bash
npm run build
```

For API, auth, or route changes, run:

```bash
npm run test
```

For release-sensitive or security-sensitive changes, run:

```bash
npm run check
```

GitHub Actions CI is defined in `.github/workflows/ci.yml` and runs `npm ci` followed by `npm run check`.

GitHub workflow hygiene files are:

- `.github/pull_request_template.md`
- `.github/dependabot.yml`
- `.github/workflows/release.yml`
- `CODEOWNERS`

Docker deployment files are `Dockerfile`, `.dockerignore`, and `docker-compose.yml`. Validate Docker changes with at least:

```bash
docker build -t enterprise-kb:local .
```

For frontend or route changes, start the app and verify in a browser:

```bash
npm run dev
```

If the app is running on a non-default port, set `CODEX_APP_URL` for smoke checks:

```powershell
$env:CODEX_APP_URL="http://localhost:8081"; npm run codex:smoke
```

Then inspect:

```text
http://localhost:8080
http://localhost:8080/healthz
http://localhost:8080/readyz
```

Check the browser console for errors and confirm the page is not blank.

## Release Flow

- Release tags follow semantic versioning, such as `v1.0.1`.
- Update `CHANGELOG.md` before tagging a release.
- `RELEASE.md` contains the release checklist and artifact contents.
- Tag pushes trigger `.github/workflows/release.yml` to publish a GitHub Release artifact.

## Security Notes

- Treat `.env` as secret-bearing and do not print or copy its values into chat.
- Keep authentication and authorization checks intact around `requireAuth`, `requireAdmin`, and KB ownership/member checks.
- File upload and document preview behavior should preserve path traversal protections.
- Keep production startup checks for weak `JWT_SECRET` and `ADMIN_PASSWORD`.
- Do not weaken `npm audit --omit=dev --audit-level=moderate` in `npm run check`.
- Keep `SECURITY_OWNERSHIP.md` aligned when auth, authorization, uploads, deployment, or storage boundaries change.

## Codex Workflow Preferences

- Read relevant files before making changes.
- Keep edits narrowly scoped to the user request.
- Prefer existing project patterns over new abstractions.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Do not revert user changes.
- After frontend-visible changes, use browser validation when a local server is available.
- Summarize changes and validation results at the end.
