# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.2.0] - 2026-10-18

**Upgrade notes:** requires Node.js 22.19 or newer (Docker users are unaffected). The database is migrated automatically on first start, so no manual steps are needed. Back up first with `npm run backup` as usual.

### Fixed

- Deleting a knowledge base now also deletes its search index and vectors. Leftover entries from earlier deletions are cleaned up on startup.

### Security

- Upgraded proxy-addr to 2.0.8 (IP spoofing via IPv4-mapped IPv6 when `TRUST_PROXY` names a subnet, GHSA-jqcg-44mw-7w3h).
- Removed sprintf-js (GHSA-hp3w-g68c-fv3c, no patched release) by pinning mammoth's `argparse` to 2.x. It was only reachable from mammoth's own command-line tool, which this app never runs; document parsing is unaffected.

### Added

- Knowledge gap report in the admin 反馈 tab: questions the assistant answered with "未找到相关内容", or that users marked 👎 "没找到相关资料", grouped by question and knowledge base and ranked by how often they were asked (last 7/30/90 days). Admin API: `GET /api/admin/gaps?days=&kbId=`.
- `npm run upgrade:check -- <previous release build>`: seeds data with the previous release, starts the current build on the same data and verifies that users, documents, search, conversations and feedback survive the upgrade. It's part of the release checklist in `RELEASE.md`.
- Browser end-to-end tests (Playwright, `npm run test:e2e`) for login, Q&A with 👎 reasons, the admin feedback tab, read-only public knowledge bases and phone layout. They run in CI as a separate job.

### Changed

- **Requires Node.js 22.19 or newer** (Node 20 reached end of life in April 2026). The server and the backup/restore commands now stop at startup with a clear message on older versions. Docker images and CI already use Node 22, so they are unaffected.
- Upgraded openai to 7 and undici to 8. Both require Node 22. undici 8 uses HTTP/2 automatically when an HTTPS model endpoint offers it. The outbound proxy (`HTTPS_PROXY`/`NO_PROXY`) still applies to model calls, embeddings and document summaries.
- Faster search index bookkeeping for large knowledge bases. With 2,000 documents (11 M characters), the document list page went from about 1 s to under 1 ms, indexing went from 11.7 ms to about 2 ms per document, and deleting a document's index went from 19 ms to under 1 ms. Searches that use 2-character terms only scan the selected knowledge base. Existing databases are migrated automatically on startup. Benchmark: `npm run bench:search`.
- Large uploads no longer freeze the server while they are indexed. A 50 MB text file used to block every other request (including streaming answers) for about 4 s. Chunks are now written in batches that yield between writes, and the longest pause is about 0.2 s. If the document is deleted or edited while indexing is still running, the remaining batches are dropped.
- PDF, Word, Excel and PowerPoint text extraction now runs in a separate worker thread. Before this change, a 2,000-page PDF froze the server for about 6.5 s; now the longest stall is about 13 ms. Files that take longer than `EXTRACT_TIMEOUT_SECONDS` (default 120) are marked as failed instead of hanging the index queue.
- Upgraded pdf-parse to 2.x (current pdf.js); table cells in PDFs are now extracted with spacing.
- Upgraded tsx, TypeScript 6 and better-sqlite3 12.
- Upgraded officeparser, mammoth, p5 2 and bcryptjs 3. Existing password hashes keep working.
- Upgraded dotenv to 18 (`.env` parsing unchanged; startup stays quiet), Playwright to 1.64 and @types/multer to 2.3.

## [1.1.0] - 2026-10-02

### Security

- LLM file tools (Read/Grep/Glob/KBStats) are now confined to the knowledge bases the user can access. Previously they could read any file on the server, including `.env` and the database. **If untrusted users had access, rotate `JWT_SECRET` and `LLM_API_KEY` after upgrading.**
- Only admins can set a knowledge base's sync folder. New optional `SYNC_ALLOWED_ROOTS` limits which server folders can be synced.
- Upload permission is checked before the file is written, so rejected uploads no longer leave files in the knowledge base folder.
- Public knowledge bases are read-only for non-members.
- Login tokens are revoked immediately when a user is deleted, their role changes, or their password changes. Previously they stayed valid until expiry (24 h by default), including a demoted admin's admin rights.
- Dependency updates for multer, body-parser, qs, form-data, brace-expansion and uuid advisories.

### Changed

- **Behavior change:** uploading, creating and editing documents now requires being the owner, a member, or an admin. Public visibility only grants viewing and Q&A.
- **Behavior change:** knowledge base owners can no longer set a sync folder themselves. They can still run a sync on a folder an admin configured.
- Cross-knowledge-base Q&A can now open documents in every knowledge base the user can access, not just the first one.
- CI, release builds and the Docker image now use Node.js 22.
- Frontend libraries and the Inter font are served locally (no CDN needed on intranets).
- Redesigned UI, including a new login page background.

### Added

- Chinese/Japanese/Korean full-text search (trigram index).
- Word, Excel and PowerPoint parsing.
- Hybrid semantic search with optional embeddings, and related-document suggestions.
- Thumbs-down reasons with an optional comment, and a 反馈 tab for admins with the reason breakdown and the rated questions and answers.
- Audit log of logins, user, knowledge base, document, sync, configuration and Q&A actions.
- Local folder sync, inline text documents with Markdown preview, document auto-summaries, and per-knowledge-base system prompts.
- Conversation search, pinning, batch delete and a stop-generation button.
- Model selection that persists across restarts, and a per-user Q&A rate limit (`QA_RATE_MAX`, `QA_RATE_WINDOW_MS`).
- Outbound HTTP proxy support (`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`).
- Backup and restore: `npm run backup` (works while the server runs; keeps the newest `BACKUP_KEEP`), `npm run backup:list`, and `npm run restore -- <backup> --yes`, which keeps the current data aside. See `DEPLOYMENT.md`.

### Fixed

- 👍/👎 buttons were never shown under answers.
- Home page panels stuck on "加载中…" when no knowledge base was available.
- Admin console layout on phones.

## [1.0.0] - 2026-06-06

### Added

- Initial enterprise KB application.
- Express + SQLite backend with OpenAI-compatible LLM support.
- Multi-user authentication and KB ownership/member checks.
- Document upload, preview, and storage paths.
- Codex-oriented project guidance in `AGENTS.md`.
- API tests, smoke checks, Docker deployment, and GitHub CI.
- GitHub workflow hygiene files, security ownership notes, and branch protection.
