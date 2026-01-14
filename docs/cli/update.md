---
summary: "CLI reference for `clawdbot update` (safe-ish source update + optional daemon restart)"
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
---

# `clawdbot update`

Safely update a **source checkout** (git install) of Clawdbot.

If you installed via **npm/pnpm** (global install, no git metadata), use the package manager flow in [Updating](/install/updating).

## Usage

```bash
clawdbot update
clawdbot update --restart
clawdbot update --json
clawdbot --update
```

## Options

- `--restart`: restart the Gateway daemon after a successful update.
- `--json`: print machine-readable `UpdateRunResult` JSON.
- `--timeout <seconds>`: per-step timeout (default is 1200s).

## What it does (git checkout)

High-level:

1. Requires a clean worktree (no uncommitted changes).
2. Fetches and rebases against `@{upstream}`.
3. Installs deps (pnpm preferred; npm fallback).
4. Builds + builds the Control UI.
5. Runs `clawdbot doctor` as the final “safe update” check.

## `--update` shorthand

`clawdbot --update` rewrites to `clawdbot update` (useful for shells and launcher scripts).

## See also

- `clawdbot doctor` (offers to run update first on git checkouts)
- [Updating](/install/updating)
- [CLI reference](/cli)
