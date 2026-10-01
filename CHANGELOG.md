# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - Unreleased

### Security

- LLM file tools (Read/Grep/Glob/KBStats) are now confined to the knowledge bases the user can access. Previously they could read any file on the server, including `.env` and the database. **If untrusted users had access, rotate `JWT_SECRET` and `LLM_API_KEY` after upgrading.**
- Only admins can set a knowledge base's sync folder. New optional `SYNC_ALLOWED_ROOTS` limits which server folders can be synced.
- Upload permission is checked before the file is written, so rejected uploads no longer leave files in the knowledge base folder.
- Public knowledge bases are read-only for non-members.
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
