# OpenCrustacean — Frozen Fork

**Status: FROZEN as of 2026-08-15.** This fork no longer tracks upstream
[openclaw/openclaw](https://github.com/openclaw/openclaw).

## Freeze point

- Fork tag: **`crab-edition-2026.7.2-beta.10`** (commit `b35f4ef66a4`)
- Upstream base: `183db47e97f` (2026-07-30, "fix(ui): preserve schema-backed settings edits (#116282)")
- Divergence at freeze: upstream ~5,644 commits ahead; fork 100 commits (rebrand + crab theme + small features)
- Schema versions at freeze: state **6** / agent **16** (upstream is state **8** / agent **17**)

## Rules

- **Do NOT run `git merge upstream/main` or attempt upstream syncs.** A plain
  merge produces 500+ branding conflicts and leaves the tree broken (the
  2026-08-15 incident: invalid `package.json`, gateway unstartable).
- Upstream moves ~350 commits/day. Re-syncing, if ever desired, is a deliberate
  multi-hour merge project with a conflict policy (keep fork branding in
  `package.json`s, take upstream code elsewhere, manual i18n pass) — not a routine.
- Local backups from failed sync attempts (`main-pre-sync-20260812`,
  `main-stale-backup-20260812`) are inert; the staging branch
  `sync/upstream-main` was deleted at freeze.

## Fork-specific work preserved in this history

- OpenCrustacean rebrand + crab theme (cosmetic)
- New-session-folder support
- One-shot auto-retry for empty interactive replies
- Mobile declutter + hard-refresh button
- Version-bump-on-merge CI workflow

Development continues on `main`; upstream compatibility is not a goal.
