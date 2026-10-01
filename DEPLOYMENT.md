# Enterprise KB deployment checklist

## Requirements

- Node.js 20 or newer (22 LTS recommended).
- A writable SQLite data directory.
- A writable document storage directory.
- An OpenAI-compatible LLM endpoint. For Ollama, use `http://localhost:11434/v1`.

## Configure

Copy `.env.example` to `.env` and set production values:

- `NODE_ENV=production` in the runtime environment.
- `JWT_SECRET`: random string, at least 32 characters.
- `ADMIN_PASSWORD`: non-default initial admin password.
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MAX_TURNS`.
- `HISTORY_MAX_MESSAGES`, `HISTORY_MAX_CHARS` to cap trusted persisted conversation context sent to the model.
- `STORAGE_PATH`, `DB_PATH`.
- `CORS_ORIGIN` only when the UI and API are served from different origins.
- `SYNC_ALLOWED_ROOTS`: restrict local folder sync to specific server folders (for example `/srv/shared-docs`). Only admins can set a knowledge base's sync folder; owners can run a sync on a folder an admin configured.
- `HTTPS_PROXY` / `NO_PROXY` when the server must reach the LLM or embedding endpoint through a corporate proxy. Credentials in the proxy URL are redacted from logs.

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

## Backup And Restore

Everything the app stores lives in two places: the SQLite database (`DB_PATH`) and the document folder (`STORAGE_PATH`). One command backs up both. Run `npm run build` first if you are running from source.

```bash
npm run backup          # snapshot DB + documents into BACKUP_DIR (default ./backups)
npm run backup:list     # list existing backups
```

- The backup is safe to take while the server is running (it uses SQLite's online backup API) and checks the copy's integrity.
- Each backup is a folder `backup-<UTC time>/` with `enterprise-kb.db`, `storage/` and `manifest.json`.
- Only the newest `BACKUP_KEEP` backups (default 7) are kept.
- Backups sit on the same machine as the data. **Copy the backup folder somewhere else regularly** (another disk, NAS or object storage).

Scheduled backup (Linux cron, every day at 02:30):

```cron
30 2 * * * cd /opt/enterprise-kb && npm run backup >> backups/backup.log 2>&1
```

Restore (stop the server first; the command refuses to run while `/healthz` answers):

```bash
npm run restore -- backup-20261001-020000          # preview only
npm run restore -- backup-20261001-020000 --yes    # restore
```

The current database and document folder are renamed to `*.before-restore-<time>`, not deleted. Remove them once the restored app looks right.

Docker (backups go to `/app/data/backups` inside the data volume):

```bash
docker compose exec enterprise-kb npm run backup
docker compose cp enterprise-kb:/app/data/backups ./kb-backups      # copy off the server

docker compose stop enterprise-kb
docker compose run --rm --no-deps enterprise-kb npm run restore -- backup-20261001-020000 --yes
docker compose start enterprise-kb
```

## Operational Notes

- `data/`, `storage/`, `.env`, `node_modules/`, and `dist/` are intentionally ignored by git.
- `packages/claude-tools-kit` is vendored so deployment does not depend on a sibling directory outside this project.
- `npm ci` may warn about transitive maintenance notices from native/SDK dependencies. The release gate is `npm audit --omit=dev --audit-level=moderate`, which must remain clean.
- Review `SECURITY_OWNERSHIP.md` before production releases.
