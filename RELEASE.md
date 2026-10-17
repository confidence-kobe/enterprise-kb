# Release Process

This repository uses tag-based releases.

## Versioning

- Bump `package.json` before cutting a release.
- Use semantic version tags: `v1.0.0`, `v1.0.1`, `v1.1.0`, `v2.0.0`.
- Keep `CHANGELOG.md` updated with user-facing changes.

## Release Steps

1. Update `package.json` and `CHANGELOG.md`.
2. Run the normal validation locally:

```bash
npm run check
npm run test:e2e
```

3. Check that a database from the previous release upgrades cleanly. This seeds data with the previous tag, then starts the current build on the same data and verifies logins, documents, search, conversations and feedback:

```bash
git worktree add ../kb-prev v1.1.0          # previous release tag
(cd ../kb-prev && npm ci && npm run build)
npm run build && npm run upgrade:check -- ../kb-prev
git worktree remove ../kb-prev
```

4. Commit the release changes.
5. Create and push a tag:

```bash
git tag v1.0.1
git push origin v1.0.1
```

6. GitHub Actions will build the release artifact and publish a GitHub Release from the tag.

## Release Artifact

The release workflow produces a tarball containing:

- built server output in `dist/`
- `public/`
- `CHANGELOG.md` with upgrade notes
- vendored `packages/claude-tools-kit/dist/`
- runtime and deployment metadata

## Notes

- Do not tag a release without running checks locally.
- Keep release notes short and user-facing.
