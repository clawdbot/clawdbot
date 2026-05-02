---
summary: "CLI reference for `openclaw update` (safe-ish source update + gateway auto-restart)"
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
title: "Update"
---

# `openclaw update`

Safely update OpenClaw and switch between stable/beta/dev channels.

If you installed via **npm/pnpm/bun** (global install, no git metadata),
updates happen via the package-manager flow in [Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --tag main
openclaw update --dry-run
openclaw update --no-restart
openclaw update --yes
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: skip restarting the Gateway service after a successful update. Package-manager updates that do restart the Gateway verify the restarted service reports the expected updated version before the command succeeds.
- `--channel <stable|beta|dev>`: set the update channel (git + npm; persisted in config).
- `--tag <dist-tag|version|spec>`: override the package target for this update only. For package installs, `main` maps to `github:openclaw/openclaw#main`.
- `--dry-run`: preview planned update actions (channel/tag/target/restart flow) without writing config, installing, syncing plugins, or restarting.
- `--json`: print machine-readable `UpdateRunResult` JSON, including
  `postUpdate.plugins.integrityDrifts` when npm plugin artifact drift is
  detected during post-update plugin sync.
- `--timeout <seconds>`: per-step timeout (default is 1800s).
- `--yes`: skip confirmation prompts (for example downgrade confirmation).

<Warning>
Downgrades require confirmation because older versions can break configuration.
</Warning>

## `update status`

Show the active update channel + git tag/branch/SHA (for source checkouts), plus update availability.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: print machine-readable status JSON.
- `--timeout <seconds>`: timeout for checks (default is 3s).

## `update wizard`

Interactive flow to pick an update channel and confirm whether to restart the Gateway
after updating (default is to restart). If you select `dev` without a git checkout, it
offers to create one.

Options:

- `--timeout <seconds>`: timeout for each update step (default `1800`)

## What it does

When you switch channels explicitly (`--channel ...`), OpenClaw also keeps the
install method aligned:

- `dev` → ensures a git checkout (default: `~/openclaw`, override with `OPENCLAW_GIT_DIR`),
  updates it, and installs the global CLI from that checkout.
- `stable` → installs from npm using `latest`.
- `beta` → prefers npm dist-tag `beta`, but falls back to `latest` when beta is
  missing or older than the current stable release.

The Gateway core auto-updater (when enabled via config) launches the CLI update path
outside the live Gateway request handler. Control-plane `update.run` package-manager
updates force a non-deferred, no-cooldown update restart after the package swap,
because the old Gateway process may still have in-memory chunks that point at
files removed by the new package.

For package-manager installs, `openclaw update` resolves the target package
version before invoking the package manager. npm global installs use a staged
install: OpenClaw installs the new package into a temporary npm prefix, verifies
the packaged `dist` inventory there, then swaps that clean package tree into the
real global prefix. If verification fails, post-update doctor, plugin sync, and
restart work do not run from the suspect tree. Even when the installed version
already matches the target, the command refreshes the global package install,
then runs plugin sync, a core-command completion refresh, and restart work. This
keeps packaged sidecars and channel-owned plugin records aligned with the
installed OpenClaw build while leaving full plugin-command completion rebuilds to
explicit `openclaw completion --write-state` runs.

When a local managed Gateway service is installed and restart is enabled,
package-manager updates stop the running service before replacing the package
tree, then refresh the service metadata from the updated install, restart the
service, and verify the restarted Gateway reports the expected version. With
`--no-restart`, package replacement still runs but the managed service is not
stopped or restarted, so the running Gateway may keep old code until you restart
it manually.

## Git checkout flow

### Channel selection

- `stable`: checkout the latest non-beta tag, then build and doctor.
- `beta`: prefer the latest `-beta` tag, but fall back to the latest stable tag when beta is missing or older.
- `dev`: checkout `main`, then fetch and rebase.

### Update steps

<Steps>
  <Step title="Verify clean worktree">
    Requires no uncommitted changes.
  </Step>
  <Step title="Switch channel">
    Switches to the selected channel (tag or branch).
  </Step>
  <Step title="Fetch upstream">
    Dev only.
  </Step>
  <Step title="Preflight build (dev only)">
    Runs lint and TypeScript build in a temp worktree. If the tip fails, walks back up to 10 commits to find the newest clean build.
  </Step>
  <Step title="Rebase">
    Rebases onto the selected commit (dev only).
  </Step>
  <Step title="Install dependencies">
    Uses the repo package manager. For pnpm checkouts, the updater bootstraps `pnpm` on demand (via `corepack` first, then a temporary `npm install pnpm@10` fallback) instead of running `npm run build` inside a pnpm workspace.
  </Step>
  <Step title="Build Control UI">
    Builds the gateway and the Control UI.
  </Step>
  <Step title="Run doctor">
    `openclaw doctor` runs as the final safe-update check.
  </Step>
  <Step title="Sync plugins">
    Syncs plugins to the active channel. Dev uses bundled plugins; stable and beta use npm. Updates npm-installed plugins.
  </Step>
</Steps>

<Warning>
If an exact pinned npm plugin update resolves to an artifact whose integrity differs from the stored install record, `openclaw update` aborts that plugin artifact update instead of installing it. Reinstall or update the plugin explicitly only after verifying that you trust the new artifact.
</Warning>

<Note>
Post-update plugin sync failures fail the update result and stop restart follow-up work. Fix the plugin install or update error, then rerun `openclaw update`.

When the updated Gateway starts, plugin loading is verify-only: startup does not run package managers or mutate dependency trees. Package-manager `update.run` restarts bypass the normal idle deferral and restart cooldown after the package tree has been swapped, so the old process cannot keep lazy-loading removed chunks.

If pnpm bootstrap still fails, the updater stops early with a package-manager-specific error instead of trying `npm run build` inside the checkout.
</Note>

## `--update` shorthand

`openclaw --update` rewrites to `openclaw update` (useful for shells and launcher scripts).

## Related

- `openclaw doctor` (offers to run update first on git checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
