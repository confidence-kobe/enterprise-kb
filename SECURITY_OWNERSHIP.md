# Security Ownership Map

This map defines the security boundaries and ownership areas for `enterprise-kb`.

## Scope

The app is an Express/TypeScript service that serves a static UI, authenticates users with JWTs, stores data in SQLite, stores uploaded documents on disk, and calls an OpenAI-compatible LLM endpoint.

## Assets

- User accounts and password hashes in SQLite.
- JWT signing secret.
- Knowledge-base metadata, conversations, and messages.
- Uploaded documents under `STORAGE_PATH`.
- SQLite database under `DB_PATH`.
- LLM API key and provider endpoint.
- Admin account credentials.
- Runtime logs and operational metadata.

## Trust Boundaries

| Boundary | Entry Points | Primary Controls | Owner |
| --- | --- | --- | --- |
| Public HTTP to Express | `src/server.ts` routes | Helmet-style headers, CORS policy, JSON size limits, auth middleware | Backend owner |
| Anonymous to authenticated user | `/api/auth/login` | Password verification, login rate limit, JWT issuance | Backend owner |
| User to admin actions | `/api/admin/*`, model config | `requireAdmin` | Backend owner |
| User to KB data | `/api/kbs/*`, conversations, docs | owner/member/public checks through DB helpers | Backend owner |
| Browser to uploaded files | document preview routes | route auth checks and stored filename lookup | Backend owner |
| App to SQLite | `src/db.ts` | parameterized queries, foreign keys, WAL | Backend owner |
| App to local storage | `STORAGE_PATH` | generated filenames, allowlisted extensions, per-KB directories | Backend owner |
| App to LLM provider | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | environment config and request limits | Platform owner |
| Host/container runtime | Docker, `.env`, volumes | non-root container user, mounted persistent volumes, secret handling | Platform owner |
| CI | `.github/workflows/ci.yml` | `npm ci`, build, tests, audit | Repository owner |

## Current Controls

- JWT auth is centralized in `src/auth.ts`.
- Admin-only routes use `requireAdmin`.
- KB access checks use `canUserAccessKb`, owner checks, or admin checks.
- Login attempts are rate-limited per IP and username.
- Production startup rejects weak/default `JWT_SECRET`.
- Production startup rejects default `ADMIN_PASSWORD`.
- Upload size is limited to 50 MB.
- Upload extensions are allowlisted.
- SQL calls use prepared statements.
- Security response headers are set in Express.
- `.env`, `data/`, `storage/`, database files, logs, and dependency/build output are ignored by git.
- Docker runtime uses the `node` user and persists data/storage through volumes.
- CI runs build, API tests, and dependency audit.

## Ownership Details

### Backend Owner

Responsible for:

- Auth middleware correctness.
- Route-level authorization.
- KB membership and ownership checks.
- Upload validation.
- Document preview safety.
- API error handling.
- Test coverage for auth, admin, KB, and upload flows.

Important files:

```text
src/server.ts
src/auth.ts
src/db.ts
src/tools.ts
test/server.test.ts
```

### Platform Owner

Responsible for:

- Production `.env` values.
- Secret rotation.
- Docker or host deployment.
- Volume backups for SQLite and document storage.
- Reverse proxy and TLS.
- LLM provider credentials.
- Sentry or production monitoring.

Important files:

```text
.env.example
DEPLOYMENT.md
Dockerfile
docker-compose.yml
```

### Repository Owner

Responsible for:

- GitHub repository permissions.
- Branch protection.
- CI configuration.
- Dependency review.
- Release process.

Important files:

```text
.github/workflows/ci.yml
package.json
package-lock.json
.gitignore
```

## High-Priority Abuse Paths

### Weak Production Secrets

Risk:

- Attackers can forge JWTs or take over the default admin account.

Controls:

- Production startup rejects default/weak `JWT_SECRET`.
- Production startup rejects default `ADMIN_PASSWORD`.

Owner:

- Platform owner.

### Broken KB Authorization

Risk:

- A user can read or modify another user's private KB, documents, or conversations.

Controls:

- Preserve `canUserAccessKb` checks.
- Preserve owner/admin checks.
- Add tests for user-to-user access denial before expanding KB routes.

Owner:

- Backend owner.

### Unsafe File Upload Or Preview

Risk:

- Path traversal, oversized files, unexpected executable content, or data exposure.

Controls:

- Keep extension allowlist.
- Keep generated storage filenames.
- Keep route-level auth before document access.
- Do not trust client-provided paths.

Owner:

- Backend owner.

### LLM Endpoint Misconfiguration

Risk:

- Requests leak sensitive KB data to the wrong provider or unavailable models break production.

Controls:

- Keep `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` environment-specific.
- Avoid committing `.env`.
- Verify provider and model in deployment checklist.

Owner:

- Platform owner.

### Runtime Data Loss

Risk:

- SQLite database or uploaded documents are lost during deployment.

Controls:

- Persist `DB_PATH` and `STORAGE_PATH`.
- Docker Compose uses named volumes.
- Back up both database and storage directories.

Owner:

- Platform owner.

## Recommended Next Controls

- Add API tests for KB member access and admin-only endpoints.
- Add upload and document preview tests.
- Add branch protection once the repository is pushed to GitHub.
- Add Sentry or equivalent production error monitoring.
- Add backup and restore runbooks for `DB_PATH` and `STORAGE_PATH`.
- Add dependency update automation after GitHub remote setup.
