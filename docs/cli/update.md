---
summary: "CLI reference for `moltbot update` (safe-ish source update + gateway auto-restart)"
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
---

# `moltbot update`

Safely update Moltbot and switch between stable/beta/dev channels.

If you installed via **npm/pnpm** (global install, no git metadata), updates happen via the package manager flow in [Updating](/install/updating).

## Usage

```bash
moltbot update
moltbot update status
moltbot update wizard
moltbot update --channel beta
moltbot update --channel dev
moltbot update --tag beta
moltbot update --no-restart
moltbot update --json
moltbot --update
```

## Options

- `--no-restart`: skip restarting the Gateway service after a successful update.
- `--channel <stable|beta|dev>`: set the update channel (git + npm; persisted in config).
- `--tag <dist-tag|version>`: override the npm dist-tag or version for this update only.
- `--json`: print machine-readable `UpdateRunResult` JSON.
- `--timeout <seconds>`: per-step timeout (default is 1200s).

Note: downgrades require confirmation because older versions can break configuration.

## `update status`

Show the active update channel + git tag/branch/SHA (for source checkouts), plus update availability.

```bash
moltbot update status
moltbot update status --json
moltbot update status --timeout 10
```

Options:
- `--json`: print machine-readable status JSON.
- `--timeout <seconds>`: timeout for checks (default is 3s).

## `update wizard`

Interactive flow to pick an update channel and confirm whether to restart the Gateway
after updating (default is to restart). If you select `dev` without a git checkout, it
offers to create one.

## What it does

When you switch channels explicitly (`--channel ...`), Moltbot also keeps the
install method aligned:

- `dev` → ensures a git checkout (default: `~/moltbot`, override with `CLAWDBOT_GIT_DIR`),
  updates it, and installs the global CLI from that checkout.
- `stable`/`beta` → installs from npm using the matching dist-tag.

## Git checkout flow

Channels:

- `stable`: checkout the latest non-beta tag, then build + doctor.
- `beta`: checkout the latest `-beta` tag, then build + doctor.
- `dev`: checkout `main`, then fetch + rebase.

High-level:

1. Requires a clean worktree (no uncommitted changes).
2. Switches to the selected channel (tag or branch).
3. Fetches upstream (dev only).
4. Dev only: preflight lint + TypeScript build in a temp worktree; if the tip fails, walks back up to 10 commits to find the newest clean build.
5. Rebases onto the selected commit (dev only).
6. Installs deps (pnpm preferred; npm fallback).
7. Builds + builds the Control UI.
8. Runs `moltbot doctor` as the final “safe update” check.
9. Syncs plugins to the active channel (dev uses bundled extensions; stable/beta uses npm) and updates npm-installed plugins.

## `--update` shorthand

`moltbot --update` rewrites to `moltbot update` (useful for shells and launcher scripts).

## See also

- `moltbot doctor` (offers to run update first on git checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
