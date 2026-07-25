---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "Updating"
---

Keep OpenClaw up to date.

For Docker, Podman, and Kubernetes image replacements, see
[Upgrading container images](/install/docker#upgrading-container-images). The
gateway runs startup-safe upgrade work before readiness and exits if mounted
state needs manual repair.

## Recommended: `openclaw update`

Detects your install type (npm, pnpm, Bun, or git), fetches the latest version, runs `openclaw doctor`, and restarts the gateway.

```bash
openclaw update
```

Switch channels or target a specific version:

```bash
openclaw update --channel beta
openclaw update --channel extended-stable
openclaw update --channel dev
openclaw update --dry-run   # preview without applying
```

`openclaw update` has no `--verbose` flag (the installer does). For diagnostics use
`--dry-run` to preview planned actions, `--json` for structured results, or
`openclaw update status --json` to inspect channel and availability state.

`--channel beta` prefers the beta npm dist-tag, but falls back to stable/latest
when the beta tag is missing or its version is older than the latest stable
release. Use `--tag beta` for a one-off package update pinned to the raw npm
beta dist-tag instead.

`--channel extended-stable` is package-only, and installation remains
foreground-only. OpenClaw reads the public npm `extended-stable` selector,
verifies the selected exact package, and installs that exact version. Missing
or inconsistent registry data fails closed; it never falls back to `latest`.
If the selected version is older than the installed version, the normal
downgrade confirmation still applies. The CLI persists the channel after a
successful core update; a direct `npm install -g openclaw@extended-stable`
does not update `update.channel`.
After the core swap, eligible official npm plugins with bare/default or
`latest` intent converge to that exact core version. Exact pins and explicit
non-`latest` tags, third-party plugins, and non-npm sources remain unchanged.
Catalog installs created by current OpenClaw versions retain that default
intent. Older records that contain only an exact version remain pinned because
OpenClaw cannot safely distinguish an old automatic pin from a user pin; run
`openclaw plugins update @openclaw/name` once on the extended-stable channel
to opt that plugin back into exact-core tracking.

`--channel dev` gives a persistent moving GitHub `main` checkout. For a one-off
package update, `--tag main` maps to the `github:openclaw/openclaw#main` package
spec and installs it directly through the target package manager (npm/pnpm/bun).

For managed plugins, a missing beta release is a warning, not a failure: the
core update can still succeed while a plugin falls back to its recorded
default/latest release.

See [Release channels](/install/development-channels) for channel semantics.

## Switch between npm and git installs

Use channels to change the install type. The updater keeps your state, config,
credentials, and workspace in `~/.openclaw`; it only changes which OpenClaw
code install the CLI and gateway use.

```bash
# npm package install -> editable git checkout
openclaw update --channel dev

# git checkout -> npm package install
openclaw update --channel stable
```

Preview the install-mode switch first:

```bash
openclaw update --channel dev --dry-run
openclaw update --channel stable --dry-run
```

`dev` ensures a git checkout, builds it, and installs the global CLI from that
checkout. The `stable`, `extended-stable`, and `beta` channels use package
installs. Extended-stable is rejected on a git checkout without mutating or
converting it. If the gateway is already installed, `openclaw update` refreshes
the service metadata and restarts it unless you pass `--no-restart`.

For package installs with a managed Gateway service, `openclaw update` targets
the package root used by that service. If the shell `openclaw` command comes
from a different install, the updater prints both roots and the managed
service's Node path, and checks that Node version against the target release's
`engines.node` requirement before replacing the package.

## Source-checkout servers (reference script)

Teams running a gateway directly from a git checkout on a server can update it
with `scripts/update-gateway.sh` from inside that checkout. It is the reference
for an efficient source-server update: it restores tracked build outputs that
`pnpm build` rewrites, fails closed on any other local changes, fast-forwards
`main` (or rebases a local server branch onto `origin/main`), installs
dependencies, builds clean, and restarts the gateway.

```bash
ssh you@server 'cd /path/to/openclaw && scripts/update-gateway.sh'
```

Override the restart for custom service units, or skip it entirely:

```bash
OPENCLAW_UPDATE_RESTART_CMD='systemctl --user restart openclaw-gateway.service' scripts/update-gateway.sh
OPENCLAW_UPDATE_RESTART_CMD='' scripts/update-gateway.sh
```

For a plain single-user source install, prefer `openclaw update --channel dev`
instead — it manages the checkout, build, and gateway restart for you.

## Alternative: re-run the installer

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Add `--no-onboard` to skip onboarding. To force a specific install type, pass
`--install-method git --no-onboard` or `--install-method npm --no-onboard`.

If `openclaw update` fails after the npm package install phase, re-run the
installer instead. It does not call the updater; it runs the global package
install directly and can recover a partially updated npm install.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm
```

Pin the recovery to a specific version or dist-tag with `--version`:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm --version <version-or-dist-tag>
```

## Alternative: manual npm, pnpm, or bun

```bash
npm i -g openclaw@latest
```

Prefer `openclaw update` for supervised installs: it can coordinate the package
swap with the running Gateway service. If you update manually on a supervised
install, stop the managed Gateway first. Package managers replace files in
place, and a running Gateway can otherwise try to load core or plugin files
mid-swap. Restart the Gateway after the package manager finishes so it picks up
the new install.

For a root-owned Linux system-global install, if `openclaw update` fails with
`EACCES`, recover with system npm while keeping the Gateway stopped for the
manual replacement. Use the same profile flags/environment you normally use for
that Gateway. Replace `/usr/bin/npm` with the system npm that owns the
root-owned global prefix on your host:

```bash
openclaw gateway stop
sudo /usr/bin/npm i -g openclaw@latest
openclaw gateway install --force
openclaw gateway restart
```

Then verify:

```bash
openclaw --version
curl -fsS http://127.0.0.1:18789/readyz
openclaw plugins list --json
openclaw gateway status --deep --json
openclaw doctor --lint --json
```

When `openclaw update` manages a global npm install, it installs the target
into a temporary npm prefix first. The candidate package validates the host
Node version during `preinstall`; only then does OpenClaw verify the packaged
`dist` inventory and swap the clean package tree into the real global prefix. A
packed completion guard is omitted from the expected inventory and removed only
after `preinstall` succeeds, so skipped lifecycle scripts also fail before the
swap. On npm 12 and newer, the updater approves only the candidate OpenClaw
lifecycle; transitive dependency scripts remain blocked. This avoids npm
overlaying a new package onto stale files from the old one. If the install
command fails, OpenClaw retries once with `--omit=optional`, which helps hosts
where native optional dependencies cannot compile.

OpenClaw-managed npm update and plugin-update commands also clear npm's
`min-release-age` supply-chain quarantine (or the older `before` config key)
for the child npm process. That policy exists for general protection, but an
explicit OpenClaw update means "install the selected release now."

```bash
pnpm add -g openclaw@latest
```

If pnpm 11 installed OpenClaw 2026.7.1, run that manual command once. That
release predates pnpm 11's isolated global-package layout, so its updater can
mistake another npm installation for the running CLI. Later releases retain
pnpm ownership and follow the replacement package root during updates. They
also use the owning manager's reported global bin directory and stop before
mutation when the available pnpm command reports another global root or major,
or when the invoking package is orphaned or not the only active OpenClaw
install there.

If OpenClaw shares a pnpm 11 global install group with another package, the
automatic updater stops before changing the group. Update the original
comma-separated group manually so its sibling packages and build policy stay
intact.

```bash
bun add -g openclaw@latest
```

### Advanced npm install topics

<AccordionGroup>
  <Accordion title="Read-only package tree">
    OpenClaw treats packaged global installs as read-only at runtime, even when the global package directory is writable by the current user. Plugin package installs live in OpenClaw-owned npm/git roots under the user config directory, and Gateway startup does not mutate the OpenClaw package tree.

    Some Linux npm setups install global packages under root-owned directories such as `/usr/lib/node_modules/openclaw`. OpenClaw supports that layout because plugin install/update commands write outside that global package directory.

  </Accordion>
  <Accordion title="Hardened systemd units">
    Give OpenClaw write access to its config/state roots so explicit plugin installs, plugin updates, and doctor cleanup can persist their changes:

    ```ini
    ReadWritePaths=/var/lib/openclaw /home/openclaw/.openclaw /tmp
    ```

  </Accordion>
  <Accordion title="Disk-space preflight">
    Before package updates and explicit plugin installs, OpenClaw tries a best-effort disk-space check for the target volume. Low space produces a warning with the checked path, but does not block the update because filesystem quotas, snapshots, and network volumes can change after the check. The actual package-manager install and post-install verification remain authoritative.
  </Accordion>
</AccordionGroup>

## Auto-updater

Off by default. Enable it in `~/.openclaw/openclaw.json`:

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
    },
  },
}
```

| Channel           | Behavior                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `stable`          | Applies after a built-in delay with deterministic jitter for a spread rollout.                                                |
| `extended-stable` | Checks for a read-only update hint on startup and every 24 hours when `checkOnStart` is enabled. Never applies automatically. |
| `beta`            | Checks on a built-in interval and applies immediately.                                                                        |
| `dev`             | No automatic apply. Use `openclaw update` manually.                                                                           |

The gateway also logs an update hint on startup (disable with
`update.checkOnStart: false`). Stored extended-stable selections use this
read-only hint path and the existing 24-hour hint interval, but never invoke
automatic installation, handoff, restart, stable delay/jitter, or beta polling.
For downgrade or incident recovery, set `OPENCLAW_NO_AUTO_UPDATE=1` in the gateway environment to block automatic applies even when `update.auto.enabled` is configured. Startup update hints can still run unless `update.checkOnStart` is also disabled.

Package-manager updates requested through the live Gateway control-plane
(`update.run`) do not replace the package tree inside the running Gateway
process. On managed service installs, the Gateway starts a detached handoff,
exits, and lets the normal `openclaw update --yes --json` CLI path stop the
service, replace the package, refresh service metadata, restart, verify the
Gateway version and reachability, and recover an installed-but-unloaded macOS
LaunchAgent when possible. If the Gateway cannot make that handoff safely,
`update.run` reports a safe shell command instead of running the package
manager in-process.

The Control UI sidebar update card shows **Update Gateway** when it will start
this `update.run` flow directly. This covers browser-hosted Control UI, remote
Gateways, and manually managed local Gateways.

In the signed macOS app, a local app-owned Gateway changes that card to
**Update Mac app + Gateway**. Sparkle updates the app first; after relaunch, the
app runs `openclaw update --tag <app-version> --json`, restarts its Gateway,
and verifies health in a setup-style progress window. The window appears only
when that managed Gateway needs update, repair, or installation; app-only updates relaunch
directly into the app. Failure details stay visible with Retry, [Update guide](/install/updating), and
[Discord](https://discord.gg/clawd) actions. The app never uses this coordinated
path for a remote or externally managed Gateway, never downgrades a newer
Gateway, and never overrides an `extended-stable` channel pin.

When the update succeeds, the app queues a one-time welcome event for the most
recent top-level direct session with a real user/channel interaction. Cron runs,
heartbeats, and background-only session updates do not move that selection. In
remote mode, the app updates only its local Mac node runtime and sends the event
only when the connected remote Gateway is at least as new as the app.

## After updating

<Steps>

### Run doctor

```bash
openclaw doctor
```

Migrates config, audits DM policies, and checks gateway health. Details: [Doctor](/gateway/doctor)

### Restart the gateway

```bash
openclaw gateway restart
```

### Verify

```bash
openclaw health
```

</Steps>

## Rollback

Rollback has two layers:

1. Reinstall older OpenClaw code while keeping the current state.
2. Restore pre-update state only when the older code cannot use a migrated
   config or database.

Start with a code-only rollback. Restoring state discards changes made after
the backup.

### Before updating: create a verified backup

`openclaw update` preserves an automatic pre-update config copy, but it does not
create a full state recovery point. Before a significant update, create one
explicitly:

```bash
mkdir -p ~/Backups/openclaw
openclaw backup create --output ~/Backups/openclaw --verify
```

The archive manifest records the OpenClaw version and the source paths included
in the backup. The archive can contain credentials, auth profiles, and channel
state, so store it with owner-only permissions and the same protection as the
live state directory. See [Backup](/cli/backup) for included and intentionally
omitted files.

For a byte-for-byte recovery point that includes volatile artifacts omitted by
the portable archive, stop the Gateway and use a filesystem, volume, or VM
snapshot provided by your platform.

### Roll back a package install

List published versions, then preview and install the known-good version:

```bash
npm view openclaw versions --json
openclaw update --tag <known-good-version> --dry-run
openclaw update --tag <known-good-version>
```

`openclaw update --tag` is preferred over a direct package-manager install. It
detects the downgrade, asks for confirmation, runs managed plugin convergence
and compatibility checks against the installed target, refreshes service
metadata, restarts the Gateway, and verifies the running version. If the stored
channel is `extended-stable`, use
`--channel stable --tag <known-good-version>` because exact one-off tags cannot
be combined with the `extended-stable` selector.

Package updates stage and verify the candidate before activation. If the
filesystem swap or command-shim replacement fails, OpenClaw restores the old
package automatically. After a successful swap, a later Gateway health failure
reports the previous version and manual rollback instructions instead of
automatically replacing the package again.

If the CLI update path is unavailable, use the same package manager and install
scope that own the current Gateway:

```bash
openclaw gateway stop
npm i -g openclaw@<known-good-version>
openclaw gateway install --force
openclaw gateway restart
```

Replace `npm` with `pnpm` or `bun` when that manager owns the install. During
incident recovery, prevent an enabled auto-updater from immediately applying a
newer release by setting `OPENCLAW_NO_AUTO_UPDATE=1` in the Gateway environment.

### Roll back a source checkout

Use a clean checkout and select a known-good tag or commit:

```bash
git fetch --all --tags
git checkout --detach <known-good-tag-or-commit>
pnpm install && pnpm build
openclaw gateway restart
```

To return to latest: `git checkout main && git pull`.

The updater automatically returns a git checkout to its previous branch and
SHA when dependency installation, build, UI build, or doctor fails after a git
update starts. Manual checkout is still required when you intentionally choose
an older commit.

### Downgrading across the session SQLite migration

Before starting an older file-backed OpenClaw release, use the current CLI to
restore archived legacy transcript artifacts:

```bash
openclaw gateway stop
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

This does not delete SQLite data. Sessions created after the SQLite migration
exist only in SQLite and will not appear to the older runtime. See
[Downgrading after session SQLite migration](/cli/doctor#downgrading-after-session-sqlite-migration).

### Restore state only when necessary

If the older code cannot read a newer config or database schema, stop the
Gateway and restore the verified pre-update filesystem, volume, or VM snapshot.
Preserve the current state separately before restoring because this removes
changes made after the snapshot.

Broad `openclaw backup create` archives support creation and verification, but
not in-place whole-archive activation. Extract a broad archive into a staging
directory and use its `manifest.json` source-to-archive mapping for an offline
restore. `openclaw backup sqlite restore` likewise writes a verified database
to a fresh target; activating that target remains an explicit offline operator
step.

### Verify the rollback

```bash
openclaw --version
openclaw health
openclaw plugins list --json
openclaw gateway status --deep --json
openclaw doctor --lint --json
```

## If you are stuck

- Run `openclaw doctor` again and read the output carefully.
- For `openclaw update --channel dev` on source checkouts, the updater auto-bootstraps `pnpm` when needed. If you see a pnpm/corepack bootstrap error, install `pnpm` manually (or re-enable `corepack`) and rerun the update.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

## Related

- [Install overview](/install): all installation methods.
- [Doctor](/gateway/doctor): health checks after updates.
- [Migrating](/install/migrating): major version migration guides.
