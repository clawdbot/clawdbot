---
summary: "Repository script entry points and compatibility notes"
read_when:
  - Looking for an existing script before adding a new one
  - Running repository checks, tests, docs, Docker, release, or GitHub helper scripts
  - Updating package scripts or CI workflow script references
title: "Scripts Directory"
---

# Scripts Directory

The `scripts/` directory contains repository tooling used by local development,
CI, docs publishing, releases, Docker proof, and maintainer operations. Prefer
the package-script entry points in `package.json` when one exists, then read the
underlying script before running it directly.

## Compatibility

Many scripts are stable paths referenced by `package.json`, GitHub Actions,
docs, and maintainer runbooks. Do not move, rename, or regroup scripts only to
improve taxonomy. A directory migration needs an explicit maintainer-approved
compatibility plan for package scripts, workflows, docs snippets, and any raw
script paths users may have copied.

This index is a discovery aid for the current flat layout. It does not define a
new directory taxonomy.

## Common Entry Points

| Area            | Prefer                                                                         | Notes                                                                                                              |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Build           | `pnpm build`                                                                   | Runs `scripts/build-all.mjs`; use specific build scripts only when debugging a build stage.                        |
| Changed checks  | `pnpm changed:lanes --json`, `pnpm check:changed`                              | Lane classification lives in `scripts/changed-lanes.mjs`; changed-file checks live in `scripts/check-changed.mjs`. |
| Docs            | `pnpm docs:list`, `pnpm docs:check-mdx`, `pnpm docs:check-links`               | Backed by `scripts/docs-list.js`, `scripts/check-docs-mdx.mjs`, and `scripts/docs-link-audit.mjs`.                 |
| Formatting docs | `pnpm format:docs:check`                                                       | Uses `scripts/format-docs.mjs`; use write mode only when intentionally formatting docs.                            |
| Lint            | `pnpm lint`, `pnpm lint:core`, `pnpm lint:all`                                 | Wrapper scripts keep oxlint behavior aligned with repo config.                                                     |
| Targeted tests  | `pnpm test <path-or-filter>` or `node scripts/run-vitest.mjs <path-or-filter>` | Avoid bare `vitest`; it can start watch mode.                                                                      |
| Changed tests   | `pnpm test:changed`                                                            | Uses the repo's changed-test resolver instead of a broad Vitest run.                                               |
| Docker proof    | `pnpm test:docker:all`, `pnpm test:docker:rerun`, `pnpm test:docker:timings`   | Use the planner/rerun helpers before launching broad Docker work.                                                  |
| Live proof      | `pnpm test:live`                                                               | Live checks require the matching environment and credentials.                                                      |
| Release checks  | `pnpm release:check`, `pnpm release:beta`, `pnpm release:candidate`            | Release scripts are maintainer workflows; read release docs before use.                                            |
| GitHub reads    | `scripts/gh-read`                                                              | Uses a GitHub App read token when configured, leaving normal `gh` login for writes.                                |
| Commits         | `scripts/committer "<message>" <files...>`                                     | Preferred scoped commit helper for OpenClaw changes.                                                               |
| Remote proof    | `node scripts/crabbox-wrapper.mjs ...`                                         | Agent default for tests and heavy work; pre-warm by source trust, sync each run, reuse the lease.                  |

## Script Families

- `check-*.mjs` / `check-*.ts`: guardrails for architecture, docs, package
  contents, boundaries, workflows, and generated artifacts.
- `run-*.mjs`: wrappers around repo runtimes or tools, such as Node, Vitest,
  oxlint, tsgo, and environment setup.
- `test-*.mjs` / `test-*.sh` / `test-*.ts`: test planners, Docker lanes, live
  checks, and focused validation helpers.
- `docs-*` and `check-docs-*`: docs listing, link auditing, MDX checks,
  spellcheck, sync, and i18n glossary checks.
- `release-*`, `openclaw-npm-*`, and `plugin-*-release-*`: release preparation,
  package verification, and publishing helpers.
- `docker-*`, `test-docker-*`, and `test-live-*-docker.sh`: Docker E2E planning,
  rerun, timing, and live/package lane helpers.
- `gh-read*`, `label-*`, `sync-labels.ts`, and PR helpers: GitHub read,
  labeling, and maintainer workflow support.
- `generate-*`, `write-*`, `copy-*`, and `sync-*`: generated docs, metadata,
  package surfaces, and build artifact support.
- `lib/`: shared helpers imported by script entry points.

## Maintenance Rules

- Read `scripts/AGENTS.md` before changing scripts.
- Keep package scripts, generators, generated-artifact checks, docs references,
  and workflow references aligned when touching a script path.
- Prefer existing wrappers instead of introducing a raw tool invocation.
- Add or update focused tests under `test/scripts/` when changing script
  behavior.

See also [Scripts](https://docs.openclaw.ai/help/scripts) for public-facing script guidance.
