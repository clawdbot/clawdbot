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
clawdbot update status
clawdbot update --channel beta
clawdbot update --channel dev
clawdbot update --tag beta
clawdbot update --restart
clawdbot update --json
clawdbot --update
```

## Options

- `--restart`: restart the Gateway daemon after a successful update.
- `--channel <stable|beta|dev>`: set the update channel (git + npm; persisted in config).
- `--tag <dist-tag|version>`: override the npm dist-tag or version for this update only.
- `--json`: print machine-readable `UpdateRunResult` JSON.
- `--timeout <seconds>`: per-step timeout (default is 1200s).

Note: downgrades require confirmation because older versions can break configuration.

## `update status`

Show the active update channel + git tag/branch/SHA (for source checkouts), plus update availability.

```bash
clawdbot update status
clawdbot update status --json
clawdbot update status --timeout 10
```

Options:
- `--json`: print machine-readable status JSON.
- `--timeout <seconds>`: timeout for checks (default is 3s).

## What it does (git checkout)

Channels:

- `stable`: checkout the latest non-beta tag, then build + doctor.
- `beta`: checkout the latest `-beta` tag, then build + doctor.
- `dev`: checkout `main`, then fetch + rebase.

High-level:

1. Requires a clean worktree (no uncommitted changes).
2. Switches to the selected channel (tag or branch).
3. Fetches and rebases against `@{upstream}` (dev only).
4. Installs deps (pnpm preferred; npm fallback).
5. Builds + builds the Control UI.
6. Runs `clawdbot doctor` as the final “safe update” check.

## `--update` shorthand

`clawdbot --update` rewrites to `clawdbot update` (useful for shells and launcher scripts).

## See also

- `clawdbot doctor` (offers to run update first on git checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
